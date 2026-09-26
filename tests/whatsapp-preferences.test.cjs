const { test } = require('node:test');
const assert = require('node:assert/strict');
const { harness, load, phone, policy, HttpError } = require('./helpers/whatsapp-preference-harness.cjs');

test('whole-message STOP/UNSUBSCRIBE/START/HELP and explicit button IDs only', () => {
  for (const text of ['STOP', ' unsubscribe ', '\u200Bstop\u200F']) assert.equal(policy.preferenceCommand({ text: { body: text } }).action, 'STOP');
  for (const text of ['please STOP', 'STOP now', 'YES', 'ACCEPT', 'START today']) assert.equal(policy.preferenceCommand({ text: { body: text } }), null);
  assert.equal(policy.preferenceCommand({ interactive: { button_reply: { id: 'wa_opt_out_all', title: 'Other' } } }).action, 'STOP');
  assert.equal(policy.preferenceCommand({ interactive: { button_reply: { id: 'unrelated', title: 'STOP' } } }), null);
});
test('STOP is atomic and duplicate deliveries produce one inbound, event and reply claim', async () => {
  const h = harness();
  const results = await Promise.all([h.incoming('STOP', 'same'), h.incoming('STOP', 'same')]);
  assert.equal(h.state().messages.length, 1);
  assert.equal(h.state().whatsapp_preference_events.length, 1);
  assert.equal(h.state().whatsapp_preferences[0].status, 'opted_out');
  assert.equal(results.filter(r => r.duplicate).length, 1);
  const claims = await Promise.all(results.map(r => h.service.claimReply(r.receipt.id)));
  assert.equal(claims.filter(Boolean).length, 1);
  await assert.rejects(h.service.guardSend('meta-a', h.template(), {}, async () => assert.fail('Meta called')), { code: 'WHATSAPP_OPTED_OUT' });
});
test('START after STOP records previous state and restores consent', async () => {
  const h = harness(); await h.incoming('STOP'); await h.incoming('START');
  const events = h.state().whatsapp_preference_events;
  assert.equal(events[1].previous_status, 'opted_out');
  assert.equal(events[1].new_status, 'opted_in');
  let sent = 0;
  await h.service.guardSend('meta-a', h.template(), {}, async () => sent++);
  assert.equal(sent, 1);
});
test('HELP leaves consent unchanged and reserves only one support reply', async () => {
  const h = harness(); const first = await h.incoming('HELP', 'help'); await h.incoming('HELP', 'help');
  assert.equal(h.state().whatsapp_preferences.length, 0);
  assert.equal(h.state().whatsapp_preference_events.length, 0);
  assert.equal(first.handled, true);
  assert.match(first.receipt.reply_text, /support/i);
  const claimed = await h.service.claimReply(first.receipt.id);
  await h.service.guardSend('meta-a', { to: '6581234567', type: 'text', text: { body: claimed.reply_text }, context: { message_id: 'help' } },
    { preferenceReply: { receiptId: claimed.id, token: claimed.reply_token } }, async () => {});
});
test('generic ACCEPT/YES does not grant consent; a specific sent consent request stores agreed text', async () => {
  const h = harness();
  await h.incoming('ACCEPT'); await h.incoming('YES', 'unknown', h.contact, { context: { id: 'unknown-request' } });
  assert.equal(h.state().whatsapp_preferences.length, 0);
  await h.db('messages').insert({ company_id: 'company-a', phone_number_id: 'phone-a', wamid: 'consent-request', direction: 'outbound',
    to_phone: '6581234567', status: 'sent', content: { text: { body: 'Agree to weekly WhatsApp offers? Reply YES.' } } });
  await h.service.recordConsentRequest('company-a', h.contact.id, 'consent-request', 'marketing', 'weekly WhatsApp offers', new Date(Date.now() + 60000));
  await h.incoming('YES', 'accepted', h.contact, { context: { id: 'consent-request' } });
  const event = h.state().whatsapp_preference_events[0];
  assert.equal(event.scope, 'marketing'); assert.equal(event.source, 'whatsapp_consent_reply');
  assert.equal(event.evidence.text, 'weekly WhatsApp offers');
  await h.incoming('ACCEPT', 'second-accept', h.contact, { context: { id: 'consent-request' } });
  assert.equal(h.state().whatsapp_preference_events.length, 1);
});
test('STOP covers another sending number and future contacts in the company but not another company', async () => {
  const h = harness();
  h.state().phone_numbers.push({ id: 'phone-a2', phone_number_id: 'meta-a2', company_id: 'company-a', waba_id: 'waba' },
    { id: 'phone-b', phone_number_id: 'meta-b', company_id: 'company-b', waba_id: 'waba-b' });
  const other = { ...h.contact, id: 'contact-b', company_id: 'company-b', phone_number_id: 'phone-b' };
  h.state().contacts.push(other);
  await h.incoming('START', 'start-b', other); await h.incoming('STOP');
  await assert.rejects(h.service.guardSend('meta-a2', h.template(), {}, async () => assert.fail()), { code: 'WHATSAPP_OPTED_OUT' });
  let sent = false;
  await h.service.guardSend('meta-b', h.template(), {}, async () => { sent = true; });
  assert.equal(sent, true);
});
test('marketing opt-out permits consented utility messages but blocks marketing and unknown categories', async () => {
  const h = harness(); await h.incoming('START');
  await h.service.recordStaff('company-a', h.contact.id, 'owner', 'staff', { status: 'opted_out', scope: 'marketing', source: 'phone_call',
    evidence: { reference: 'call-123', text: 'Please stop offers, keep order updates.' } });
  await h.service.guardSend('meta-a', h.template('update'), {}, async () => {});
  for (const name of ['sale', 'unknown']) await assert.rejects(h.service.guardSend('meta-a', h.template(name), {}, async () => assert.fail()), { code: 'WHATSAPP_OPTED_OUT' });
  assert.equal(h.state().whatsapp_preference_events[1].staff_user_id, 'staff');
});
test('ordinary inbound and imported contacts do not grant campaign consent; new support requests still work', async () => {
  const h = harness(); await h.incoming('Hello', 'support');
  await assert.rejects(h.service.guardSend('meta-a', h.template(), {}, async () => assert.fail()), { code: 'WHATSAPP_CONSENT_REQUIRED' });
  const support = { to: '6581234567', type: 'text', text: { body: 'How can we help?' }, context: { message_id: 'support' } };
  await h.service.guardSend('meta-a', support, {}, async () => {});
  await h.incoming('STOP');
  await assert.rejects(h.service.guardSend('meta-a', support, {}, async () => assert.fail()), { code: 'WHATSAPP_OPTED_OUT' });
  await new Promise(resolve => setTimeout(resolve, 2));
  await h.incoming('Where is my order?', 'new-support');
  await h.service.guardSend('meta-a', { ...support, context: { message_id: 'new-support' } }, {}, async () => {});
  await assert.rejects(h.service.guardSend('meta-a', { ...support, context: { message_id: 'new-support' } }, { businessInitiated: true }, async () => assert.fail()), { code: 'WHATSAPP_OPTED_OUT' });
});
test('support cannot bypass the 24-hour window or use a forged/other-company message reference', async () => {
  const h = harness(); await h.incoming('START');
  await h.incoming('Help with order', 'old', h.contact, { timestamp: String(Math.floor(Date.now() / 1000) - 90000) });
  h.state().messages.forEach(m => { m.created_at = new Date(Date.now() - 90000000); });
  await assert.rejects(h.service.guardSend('meta-a', { to: '6581234567', type: 'text', context: { message_id: 'old' } }, {}, async () => assert.fail()), { code: 'WHATSAPP_WINDOW_CLOSED' });
});
test('staff updates reject cross-company access, invalid scope/source and missing evidence', async () => {
  const h = harness(); const valid = { status: 'opted_in', scope: 'all', source: 'email', evidence: { reference: 'email-1', text: 'I consent to WhatsApp updates and offers.' } };
  await assert.rejects(h.service.recordStaff('company-b', h.contact.id, 'owner', 'staff', valid), /not found/);
  for (const update of [{ scope: 'sms' }, { status: 'yes' }, { source: 'whatsapp_keyword' }, { evidence: {} }]) {
    await assert.rejects(h.service.recordStaff('company-a', h.contact.id, 'owner', 'staff', { ...valid, ...update }));
  }
  assert.equal(h.state().whatsapp_preference_events.length, 0);
});
test('failed confirmation never undoes STOP and cannot be claimed again', async () => {
  const h = harness(); const stored = await h.incoming('STOP');
  const claimed = await h.service.claimReply(stored.receipt.id);
  await h.service.finishReply(claimed.id, undefined, 'Meta unavailable');
  assert.equal(h.state().whatsapp_preferences[0].status, 'opted_out');
  assert.equal(await h.service.claimReply(claimed.id), undefined);
  assert.equal(h.state().whatsapp_inbound_receipts[0].reply_status, 'failed');
});
test('a fresh preference check suppresses queued campaign sends after STOP', async () => {
  const h = harness(); await h.incoming('START');
  let sent = 0;
  await h.service.guardSend('meta-a', h.template(), { businessInitiated: true }, async () => sent++);
  await h.incoming('STOP');
  await assert.rejects(h.service.guardSend('meta-a', h.template(), { businessInitiated: true }, async () => sent++), { code: 'WHATSAPP_OPTED_OUT' });
  assert.equal(sent, 1);
});
