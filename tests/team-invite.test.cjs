const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadSource } = require('./helpers/background-database.cjs');
class BadRequest extends Error { constructor({ message }) { super(message); this.statusCode = 400; } }

function fixture({ mailFails = false, domainCompany = 'company', capacity = 2 } = {}) {
  const state = { invites: [], users: [{ id: 'owner' }], mail: [], html: [], reserved: [], refunded: 0 };
  const db = table => {
    const rows = table === 'user_team' ? state.invites : state.users;
    let match = () => true;
    const query = {
      where(filter) { const previous = match; match = row => previous(row) && Object.entries(filter).every(([key, value]) => row[key] === value); return query; },
      forUpdate() { return query; },
      first() { return Promise.resolve(rows.find(match)); },
      update(patch) { const found = rows.filter(match); found.forEach(row => Object.assign(row, patch)); return Promise.resolve(found.length); },
      delete() { const found = rows.filter(match); found.forEach(row => rows.splice(rows.indexOf(row), 1)); return Promise.resolve(found.length); },
    };
    return query;
  };
  db.transaction = async work => work(db);
  const service = loadSource('src/app/services/team.service.ts', {
    '@surefy/database': db,
    '@surefy/exceptions/HTTP400Error': BadRequest,
    './planUsage.service': { __esModule: true, default: { run: async (owner, feature, work) => {
      state.reserved.push({ owner, feature });
      if (state.invites.length >= capacity) throw new BadRequest({ message: 'Team limit reached' });
      return work(db, { id: 'actual-plan' });
    } }, syncTeamSeats: async () => { state.refunded++; } },
    '@surefy/console/app/models/team.model': {
      create: async (data, trx) => { assert.equal(trx, db); const row = { ...data, id: `invite-${state.invites.length}` }; state.invites.push(row); return row; },
      findOne: async filter => state.invites.find(row => Object.entries(filter).every(([key, value]) => row[key] === value)),
    },
    '@surefy/console/utils': { __esModule: true,
      default: async (...args) => { state.mail.push(args); if (mailFails) throw new Error('Mail unavailable'); return true; },
      generateInviteTemplate: values => { state.html.push(values); return 'invite-email'; },
    },
    '../models/companyDomain.model': { findByDomain: async name => name === 'app.example.test' ? { domain_name: name, company_id: domainCompany } : null },
    '../utils/passwordPolicy': { assertStrongPassword: password => assert.equal(password, 'a-valid-password') },
    bcrypt: { hash: async () => 'hashed-password' },
    '../models/user.model': { create: async (data, trx) => { assert.equal(trx, db); const user = { ...data, id: 'member' }; state.users.push(user); return user; } },
  }).default;
  const input = { name: 'Member', email: 'member@example.test', phone_number: '919876543210', role: 'MEMBER',
    permission: ['inbox'], invite_sent_by: 'owner', company_id: 'company', domain_name: 'app.example.test' };
  return { state, service, input };
}

test('link mode creates a pending invite and reserves a seat without touching the email provider', async () => {
  const f = fixture({ mailFails: true });
  const result = await f.service.inviteTeam({ ...f.input, delivery_method: 'link' });
  assert.equal(result.success, true);
  assert.equal(result.data.email_sent, false);
  assert.equal(result.data.delivery_method, 'link');
  const url = new URL(result.data.invite_url);
  assert.equal(url.origin, 'https://app.example.test');
  assert.equal(url.pathname, '/team/setup-password');
  assert.match(url.searchParams.get('token'), /^[a-f0-9]{64}$/);
  assert.equal(url.searchParams.get('token'), f.state.invites[0].invite_token);
  assert.equal(f.state.invites[0].invite_status, 'sent');
  assert.equal(f.state.invites[0].role, 'member');
  assert.equal(f.state.invites[0].assigned_plan, 'actual-plan');
  assert.equal('delivery_method' in f.state.invites[0], false, 'transport option must not become an SQL column');
  assert.equal('invite_url' in f.state.invites[0], false);
  assert.deepEqual(f.state.reserved, [{ owner: 'owner', feature: 'TeamInvite' }]);
  assert.equal(f.state.mail.length, 0);
  assert.equal(f.state.html.length, 0);
});

test('omitting delivery_method keeps email behavior and returns the same URL used in the email', async () => {
  const f = fixture();
  const result = await f.service.inviteTeam(f.input);
  assert.equal(result.data.delivery_method, 'email');
  assert.equal(result.data.email_sent, true);
  assert.equal(f.state.mail.length, 1);
  assert.equal(f.state.mail[0][0], f.input.email);
  assert.equal(f.state.html[0].inviteUrl, result.data.invite_url);
});

test('email failure removes the pending invite and refunds its seat', async () => {
  const f = fixture({ mailFails: true });
  await assert.rejects(f.service.inviteTeam(f.input), /Mail unavailable/);
  assert.equal(f.state.invites.length, 0);
  assert.equal(f.state.refunded, 1);
});

test('invalid delivery methods and malformed destinations cannot reserve seats or send email', async () => {
  for (const method of ['', null, false, 'sms', {}]) {
    const f = fixture();
    await assert.rejects(f.service.inviteTeam({ ...f.input, delivery_method: method }), /delivery_method/);
    assert.equal(f.state.reserved.length, 0);
  }
  for (const domain of ['https://app.example.test', 'app.example.test/path', 'app.example.test?x=1', 'app.example.test#x', 'app.example.test@evil.test', 'app.example.test:443', 'app.example.test\\path', 'app.example.test\r\n.evil.test']) {
    const f = fixture();
    await assert.rejects(f.service.inviteTeam({ ...f.input, domain_name: domain, delivery_method: 'link' }), error => error.statusCode === 400);
    assert.equal(f.state.reserved.length, 0);
    assert.equal(f.state.mail.length, 0);
  }
});

test('supplied hostname builds the link without registration and binds acceptance to that saved host', async () => {
  const f = fixture();
  const result = await f.service.inviteTeam({ ...f.input, domain_name: ' ACER.SOFT7.IN ', delivery_method: 'link' });
  const url = new URL(result.data.invite_url);
  assert.equal(url.origin, 'https://acer.soft7.in');
  assert.equal(result.data.domain_name, 'acer.soft7.in');
  const token = url.searchParams.get('token');
  await assert.rejects(f.service.setUpTeammatePassword(token, 'a-valid-password', 'app.example.test'), /hostname/);
  assert.equal(f.state.users.length, 1);
  await f.service.setUpTeammatePassword(token, 'a-valid-password', 'acer.soft7.in');
  assert.equal(f.state.users[1].domain_name, 'acer.soft7.in');
  assert.equal(f.state.users[1].company_id, f.input.company_id);
  assert.equal(f.state.users[1].email, f.input.email);
  assert.equal(f.state.users[1].role, 'member');
});

test('legacy invitations without a saved hostname still require their company domain', async () => {
  for (const domainCompany of ['company', 'another-company']) {
    const f = fixture({ domainCompany });
    await f.service.inviteTeam({ ...f.input, delivery_method: 'link' });
    const invite = f.state.invites[0];
    delete invite.domain_name;
    const accept = () => f.service.setUpTeammatePassword(invite.invite_token, 'a-valid-password', f.input.domain_name);
    if (domainCompany === 'company') assert.equal((await accept()).success, true);
    else await assert.rejects(accept(), /company domain/);
  }
});

test('link mode preserves duplicate and plan-limit checks', async () => {
  const f = fixture();
  await f.service.inviteTeam({ ...f.input, delivery_method: 'link' });
  await assert.rejects(f.service.inviteTeam({ ...f.input, delivery_method: 'link' }), /already invited/);
  assert.equal(f.state.invites.length, 1);
  const full = fixture({ capacity: 0 });
  await assert.rejects(full.service.inviteTeam({ ...full.input, delivery_method: 'link' }), /limit reached/);
  assert.equal(full.state.invites.length, 0);
  assert.equal(full.state.mail.length, 0);
});

test('generated links use the existing company-bound, single-acceptance password setup flow', async () => {
  const f = fixture();
  const result = await f.service.inviteTeam({ ...f.input, delivery_method: 'link' });
  const token = new URL(result.data.invite_url).searchParams.get('token');
  await assert.rejects(f.service.setUpTeammatePassword(token, 'a-valid-password', 'evil.test'), /hostname/);
  const accepted = await f.service.setUpTeammatePassword(token, 'a-valid-password', f.input.domain_name);
  assert.equal(accepted.success, true);
  assert.equal(f.state.invites[0].invite_status, 'accepted');
  assert.equal(f.state.users[1].email, f.input.email);
  assert.equal(f.state.users[1].company_id, f.input.company_id);
  await assert.rejects(f.service.setUpTeammatePassword(token, 'a-valid-password', f.input.domain_name), /no longer pending/);
  assert.equal(f.state.users.length, 2);
});

test('controller forwards delivery mode and derives ownership from the authenticated request', async () => {
  const calls = [];
  const controller = loadSource('src/app/http/controllers/team.controller.ts', {
    '@surefy/utils/Controller': { tryCatchAsync: fn => fn, successResponse: (_req, res, message, data) => { res.result = { message, data }; } },
    '@surefy/console/services/team.service': { inviteTeam: async data => { calls.push(data); return { success: true, data: { invite_url: 'https://app.example.test/team/setup-password?token=test', email_sent: data.delivery_method !== 'link' } }; } },
    '../../models/user.model': { findByEmailPhone: async () => null },
  }).default;
  const f = fixture();
  for (const mode of ['link', undefined]) {
    const res = {};
    await controller.teamInvite({ body: { ...f.input, delivery_method: mode, invite_sent_by: 'attacker', company_id: 'foreign' },
      userId: 'member', ownerId: 'actual-owner', companyId: 'actual-company', assigned_plan: 'plan' }, res);
    assert.equal(calls.at(-1).company_id, 'actual-company');
    assert.equal(calls.at(-1).invite_sent_by, 'actual-owner');
    assert.equal(calls.at(-1).delivery_method, mode || 'email');
    assert.equal(res.result.data.email_sent, mode !== 'link');
    assert.match(res.result.message, mode === 'link' ? /link generated/ : /Invite sent/);
  }
});
