const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { fixture, utils, migration } = require('./facebook-helpers.cjs');
const dbTest = (name, fn) => test(name, { skip: !process.env.FACEBOOK_TEST_DATABASE_URL && 'Set FACEBOOK_TEST_DATABASE_URL to an isolated local PostgreSQL database.' }, () => fixture(fn));

dbTest('authorization is browser-bound, single-use, cancellable and permission checked', async ({ service, a, b, meta, database }) => {
  let login = await service.start(a); let state = new URL(login.url).searchParams.get('state');
  assert.equal(new URL(login.url).searchParams.get('config_id'), process.env.FACEBOOK_LOGIN_CONFIG_ID);
  assert.equal(new URL(login.url).searchParams.has('scope'), false);
  await assert.rejects(service.callback(state, 'another-browser', 'code', false));
  assert.equal(await service.callback(state, login.browser, 'code', true), 'failed');
  assert.match((await service.candidates(a, login.browser)).error, /cancelled/);
  await assert.rejects(service.callback(state, login.browser, 'code', false));
  assert.equal((await service.candidates(b, login.browser)).status, 'none');
  meta.grants = ['pages_show_list']; login = await service.start(a); state = new URL(login.url).searchParams.get('state');
  assert.equal(await service.callback(state, login.browser, 'code', false), 'failed');
  assert.match((await service.candidates(a, login.browser)).error, /pages_messaging/);
  assert.equal((await database('facebook_pages')).length, 0);
});

dbTest('connection encrypts tokens, verifies subscription and rejects ownership transfer', async ({ service, database, connect, a, b, other, meta }) => {
  const page = await connect(); assert.equal(page.status, 'connected'); assert.equal(page.token_ciphertext, undefined);
  const stored = await database('facebook_pages').first(); assert.notEqual(stored.token_ciphertext, 'TEST_PAGE_TOKEN'); assert.equal(utils.decrypt(stored.token_ciphertext), 'TEST_PAGE_TOKEN');
  assert.equal((await service.pages(a))[0].facebook_user_id, undefined);
  assert.equal(meta.calls[0].body.subscribed_fields, utils.subscriptions.join(','));
  await assert.rejects(connect(b), /another account/); await assert.rejects(connect(other), /another account/);
  assert.equal((await service.pages(b)).length, 0);
});

dbTest('subscription failure is stored visibly and reconnect preserves Page identity', async ({ connect, meta, database }) => {
  meta.failure = new utils.FacebookError(403, 'Permission denied', 'PERMISSION_DENIED');
  const failed = await connect(); assert.equal(failed.status, 'subscription_failed'); assert.equal(failed.error, 'Permission denied');
  meta.failure = null; const page = await connect(); assert.equal(page.id, failed.id); assert.equal(page.status, 'connected'); assert.equal(page.error, null);
  assert.equal((await database('facebook_pages')).length, 1);
});

dbTest('duplicate webhooks persist one message, customer follow-up reuses conversation, old events cannot extend window', async ({ connect, service, database, inbound, a }) => {
  await connect(); const first = inbound(); await Promise.all([service.receive(first), service.receive(first), service.receive(first)]);
  assert.equal((await database('facebook_messages')).length, 1); assert.equal((await database('facebook_conversations')).length, 1);
  const initial = await database('facebook_conversations').first();
  await service.receive(inbound('in-2', 'My order number is 1234.'));
  await service.receive(inbound('in-old', 'Earlier', Date.now() - 90000000));
  const result = await service.messages(a, initial.id); assert.equal(result.messages.length, 3); assert.equal(result.conversation.id, initial.id);
  assert.ok(new Date(result.conversation.last_customer_message_at).getTime() >= new Date(initial.last_customer_message_at).getTime());
});

dbTest('foreign Page routing and cross-company or cross-owner read/send are rejected', async ({ connect, service, database, inbound, b, other, a, meta }) => {
  await connect(); await service.receive(inbound()); const c = await database('facebook_conversations').first();
  for (const scope of [b, other]) {
    assert.equal((await service.conversations(scope)).conversations.length, 0);
    await assert.rejects(service.messages(scope, c.id), /not found/);
    await assert.rejects(service.send(scope, c.id, 'Reply', crypto.randomUUID()), /not found/);
    const page = await database('facebook_pages').first(); await assert.rejects(service.disconnect(scope, page.id), /not found/);
  }
  const before = (await database('facebook_messages')).length;
  const invalid = inbound('foreign'); invalid.entry[0].messaging[0].recipient.id = '20002'; await service.receive(invalid);
  assert.equal((await database('facebook_messages')).length, before);
  assert.equal(meta.calls.filter(c => c.path.endsWith('/messages')).length, 0);
  assert.equal((await service.conversations(a)).conversations.length, 1);
});

dbTest('team members require live inbox membership and cannot manage integration', async ({ connect, service, database, member, a }) => {
  await connect(); await assert.rejects(service.pages(member), /inbox permission/);
  await database('user_team').insert({ company_id: a.companyId, invite_sent_by: a.ownerId, email: 'member@example.test', invite_status: 'accepted', permission: JSON.stringify(['inbox']) });
  assert.equal((await service.pages(member)).length, 1);
  await assert.rejects(service.start(member), /account owner/);
  await database('user_team').update({ invite_status: 'expired' }); await assert.rejects(service.pages(member), /inbox permission/);
});

dbTest('outbound uses the scoped Page token and PSID and repeat request IDs do not resend', async ({ connect, service, database, inbound, a, meta }) => {
  await connect(); await service.receive(inbound()); const c = await database('facebook_conversations').first();
  const requestId = crypto.randomUUID(), text = 'Hello! Please share your order number so we can help.';
  const sent = await service.send(a, c.id, text, requestId); assert.equal(sent.status, 'sent');
  const again = await service.send(a, c.id, text, requestId); assert.equal(again.id, sent.id);
  await assert.rejects(service.send(a, c.id, 'Different text', requestId), /different text/);
  const calls = meta.calls.filter(c => c.path.endsWith('/messages')); assert.equal(calls.length, 1);
  assert.equal(calls[0].token, 'TEST_PAGE_TOKEN'); assert.equal(calls[0].body.recipient.id, '40001'); assert.equal(calls[0].body.messaging_type, 'RESPONSE'); assert.equal(calls[0].body.message.text, text);
});

dbTest('Send API permission failure marks failed and requires reconnection', async ({ connect, service, database, inbound, a, meta }) => {
  await connect(); await service.receive(inbound()); const c = await database('facebook_conversations').first();
  meta.failure = new utils.FacebookError(403, 'Missing Facebook messaging permission', 'PERMISSION_DENIED');
  const failed = await service.send(a, c.id, 'Reply', crypto.randomUUID()); assert.equal(failed.status, 'failed'); assert.match(failed.error, /permission/);
  assert.equal((await database('facebook_pages').first()).status, 'reconnect_required');
});

dbTest('messaging window and expired tokens block Meta calls before send', async ({ connect, service, database, inbound, a, meta }) => {
  await connect(); await service.receive(inbound('old', 'Old message', Date.now() - 86400001)); const c = await database('facebook_conversations').first();
  await assert.rejects(service.send(a, c.id, 'Reply', crypto.randomUUID()), error => error.code === 'WINDOW_CLOSED');
  await service.receive(inbound('new'));
  await database('facebook_pages').update({ token_expires_at: new Date(Date.now() - 1000) });
  await assert.rejects(service.send(a, c.id, 'Reply', crypto.randomUUID()), error => error.code === 'TOKEN_EXPIRED');
  assert.equal((await service.pages(a))[0].status, 'reconnect_required'); assert.equal(meta.calls.filter(c => c.path.endsWith('/messages')).length, 0);
});

dbTest('echo before Send API response reconciles the pending reply and receipts never regress', async ({ connect, service, database, inbound, a, meta, echo, receipt }) => {
  await connect(); await service.receive(inbound()); const c = await database('facebook_conversations').first();
  const original = meta.call.bind(meta);
  meta.call = async (...args) => {
    if (!args[0].endsWith('/messages')) return original(...args);
    const at = Date.now() - 1;
    await service.receive(echo('echo-first', args[4].message.metadata, at, args[4].message.text));
    await service.receive(receipt('read', at + 1));
    return { recipient_id: '40001', message_id: 'echo-first' };
  };
  const reply = await service.send(a, c.id, 'Reply', crypto.randomUUID()); assert.equal(reply.status, 'read');
  await service.receive(receipt('delivery', Date.now(), ['echo-first']));
  await service.receive(echo('echo-first', 'fm:' + reply.id));
  assert.equal((await database('facebook_messages').where({ direction: 'outbound' })).length, 1);
  assert.equal((await database('facebook_messages').where({ id: reply.id }).first()).status, 'read');
});

dbTest('ambiguous timeout is not automatically retried and a later echo confirms the same reply', async ({ connect, service, database, inbound, a, meta, echo }) => {
  await connect(); await service.receive(inbound()); const c = await database('facebook_conversations').first();
  meta.failure = new utils.FacebookError(502, 'No confirmation; reply may have been sent.', 'META_UNCONFIRMED');
  const requestId = crypto.randomUUID(); const reply = await service.send(a, c.id, 'Reply', requestId); assert.equal(reply.status, 'failed');
  const calls = meta.calls.length; await service.send(a, c.id, 'Reply', requestId); assert.equal(meta.calls.length, calls);
  await service.receive(echo('late-echo', 'fm:' + reply.id));
  const confirmed = await database('facebook_messages').where({ id: reply.id }).first(); assert.equal(confirmed.status, 'sent'); assert.equal(confirmed.error, null);
});

dbTest('disconnect removes credentials, stops ingestion, and reconnect retains history', async ({ connect, service, database, inbound, a }) => {
  const page = await connect(); await service.receive(inbound()); const c = await database('facebook_conversations').first();
  await service.disconnect(a, page.id); assert.equal((await database('facebook_pages').first()).token_ciphertext, null);
  await service.receive(inbound('after-disconnect')); assert.equal((await database('facebook_messages')).length, 1);
  await assert.rejects(service.send(a, c.id, 'Reply', crypto.randomUUID()), /not connected/);
  const reconnected = await connect(); assert.equal(reconnected.id, page.id);
  await service.receive(inbound('after-reconnect')); assert.equal((await database('facebook_conversations')).length, 1); assert.equal((await database('facebook_messages')).length, 2);
});

dbTest('deauthorization revokes tokens, data deletion cascades and migration rollback works', async ({ connect, service, database, inbound }) => {
  await connect(); await service.receive(inbound()); await service.revoke('30001', false);
  assert.equal((await database('facebook_pages').first()).status, 'disconnected'); assert.equal((await database('facebook_pages').first()).token_ciphertext, null);
  assert.equal((await database('facebook_messages')).length, 1);
  const confirmation = await service.revoke('30001', true); assert.equal((await service.deletionStatus(confirmation)).status, 'completed');
  assert.equal((await database('facebook_pages')).length, 0); assert.equal((await database('facebook_messages')).length, 0);
  await assert.rejects(service.deletionStatus('not-valid'));
  await migration.down(database); assert.equal(await database.schema.hasTable('facebook_pages'), false);
});
