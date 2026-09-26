require('ts-node/register');
const phoneUtils = require('../src/app/utils/importPhone');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
class HttpError extends Error { constructor(data) { super(data.message); } }
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => deps[id] || (id === '../utils/importPhone' ? phoneUtils : HttpError), Date, console });
  return exports;
}
const source = 'src/app/services/planUsage.service.ts';
const checkUsage = load(source, {}).checkUsage;
const plan = (extra = {}) => ({ id: 'current', user_id: 'owner', active: true,
  start_date: '2020-01-01', end_date: '2099-01-01', limits: {}, usage: {}, ...extra });
test('missing usage starts at zero; zero limits deny; null and absent limits remain unlimited', () => {
  assert.equal(checkUsage(plan({ limits: { Contact: { limit: 1 } } }), 'Contact').used, 0);
  assert.throws(() => checkUsage(plan({ limits: { Contact: { limit: 0 } } }), 'Contact'), /limit reached/);
  assert.doesNotThrow(() => checkUsage(plan({ limits: { Contact: { limit: null } } }), 'Contact', 100));
  assert.doesNotThrow(() => checkUsage(plan(), 'Contact', 100));
  assert.throws(() => checkUsage(plan({ limits: { Contact: { limit: 2 } }, usage: { Contact: 1 } }), 'Contact', 2), /limit reached/);
});
test('expiry boundary, future start, inactive plan and malformed counts are rejected', () => {
  assert.throws(() => checkUsage(plan({ end_date: '2026-01-01' }), 'Campaign', 1, new Date('2026-01-01')), /expired/);
  assert.throws(() => checkUsage(plan({ start_date: '2098-01-01' }), 'Campaign'), /not started/);
  assert.throws(() => checkUsage(plan({ active: false }), 'Campaign'), /No active/);
  assert.throws(() => checkUsage(plan(), 'Campaign', -1), /non-negative/);
});
function harness({ usage = {}, limits = {}, seats = [] } = {}) {
  let state = { users: [{ id: 'owner' }], user_plans: [plan({ usage, limits }), plan({ id: 'old', active: false, usage: { Contact: 88 } })],
    contacts: [], user_team: seats };
  const locks = [];
  let tail = Promise.resolve();
  function connection(draft) {
    const trx = table => {
      let filters = [], first = false, counting = false, operation, values;
      const q = {
        where: value => { filters.push(row => Object.entries(value).every(([k, v]) => row[k] === v)); return q; },
        whereIn: (key, value) => { filters.push(row => value.includes(row[key])); return q; },
        forUpdate: () => { locks.push(table); return q; },
        first: () => { first = true; return q; }, count: () => { counting = true; return q; },
        insert: value => { operation = 'insert'; values = value; return q; },
        update: value => { operation = 'update'; values = value; return q; },
        delete: () => { operation = 'delete'; return q; },
        then: (resolve, reject) => Promise.resolve().then(() => {
          let rows = draft[table].filter(row => filters.every(f => f(row)));
          if (operation === 'insert') { rows = [values]; draft[table].push(values); }
          if (operation === 'update') for (const row of rows) {
            for (const [key, val] of Object.entries(values)) {
              row[key] = val?.seats !== undefined ? { ...(typeof row.usage === 'string' ? JSON.parse(row.usage) : row.usage), TeamInvite: val.seats } : val;
            }
          }
          if (operation === 'delete') draft[table] = draft[table].filter(row => !rows.includes(row));
          if (counting) rows = [{ total: rows.length }];
          return first ? rows[0] : rows;
        }).then(resolve, reject),
      };
      return q;
    };
    trx.raw = (sql, [seats]) => ({ seats });
    return trx;
  }
  // Emulate the serialized owner lock and transaction rollback; not a PostgreSQL load test.
  const db = { transaction: callback => {
    const result = tail.then(async () => {
      const draft = structuredClone(state);
      const value = await callback(connection(draft));
      state = draft;
      return value;
    });
    tail = result.catch(() => {});
    return result;
  } };
  const api = load(source, { '@surefy/database': db });
  return { service: api.default, syncTeamSeats: api.syncTeamSeats, state: () => state, db, locks };
}
test('concurrent last-slot creates allow one success and update only the current plan', async () => {
  const h = harness({ limits: { Contact: { limit: 1 } } });
  const create = id => h.service.run('owner', 'Contact', trx => trx('contacts').insert({ id }));
  const results = await Promise.allSettled([create('a'), create('b')]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(h.state().contacts.length, 1);
  assert.equal(JSON.parse(h.state().user_plans[0].usage).Contact, 1);
  assert.equal(h.state().user_plans[1].usage.Contact, 88);
  assert.deepEqual(h.locks.slice(0, 2), ['users', 'user_plans']);
});
test('failed creation rolls back both resource and usage', async () => {
  const h = harness();
  await assert.rejects(h.service.run('owner', 'Campaign', async trx => {
    await trx('contacts').insert({ id: 'partial' }); throw Error('recipient write failed');
  }), /recipient write failed/);
  assert.equal(h.state().contacts.length, 0);
  assert.equal(h.state().user_plans[0].usage.Campaign, undefined);
});
test('team limit uses pending plus accepted seats, ignores expired, and deletion releases a seat', async () => {
  const h = harness({ usage: { TeamInvite: 0 }, limits: { TeamInvite: { limit: 2 } }, seats: [
    { id: 'a', invite_sent_by: 'owner', invite_status: 'sent' },
    { id: 'b', invite_sent_by: 'owner', invite_status: 'accepted' },
    { id: 'c', invite_sent_by: 'owner', invite_status: 'expired' },
  ] });
  await assert.rejects(h.service.run('owner', 'TeamInvite', async () => {}), /limit reached/);
  await h.db.transaction(async trx => {
    await trx('user_team').where({ id: 'a' }).delete();
    await h.syncTeamSeats(trx, 'owner');
  });
  assert.equal(h.state().user_plans[0].usage.TeamInvite, 1);
  await h.service.run('owner', 'TeamInvite', trx => trx('user_team').insert({ id: 'd', invite_sent_by: 'owner', invite_status: 'sent' }));
  assert.equal(JSON.parse(h.state().user_plans[0].usage).TeamInvite, 2);
});
test('preflight middleware checks owner plan for team-member requests and forwards async failures', async () => {
  let queried, error;
  const api = load('library/surefy/src/middleware/plan.middleware.ts', {
    '@surefy/console/app/models/userPlans.model': { getPlanByUserId: async id => { queried = id; return plan(); } },
    '@surefy/console/app/services/planUsage.service': { checkUsage },
  });
  await api.checkPlanLimit('Contact')({ userId: 'member', ownerId: 'owner' }, {}, value => { error = value; });
  assert.equal(queried, 'owner'); assert.equal(error, undefined);
});

test('failed invitation email releases its reserved seat and removes the pending invitation', async () => {
  const h = harness({ limits: { TeamInvite: { limit: 1 } } });
  let sent = 0;
  const team = load('src/app/services/team.service.ts', {
    '@surefy/database': h.db,
    './planUsage.service': { __esModule: true, default: h.service, syncTeamSeats: h.syncTeamSeats },
    '@surefy/console/app/models/team.model': { create: async (data, trx) => {
      await trx('user_team').insert({ ...data, id: 'invite' }); return { ...data, id: 'invite' };
    } },
    '@surefy/console/utils': { __esModule: true, default: async () => { sent++; throw Error('mail failed'); }, generateInviteTemplate: () => 'html' },
    crypto: require('node:crypto'),
  }).default;
  await assert.rejects(team.inviteTeam({ name: 'Member', email: 'test@example.invalid', role: 'member', invite_sent_by: 'owner', domain_name: 'example.invalid' }), /mail failed/);
  assert.equal(sent, 1);
  assert.equal(h.state().user_team.length, 0);
  assert.equal(h.state().user_plans[0].usage.TeamInvite, 0);
});
test('contact service persists in the usage transaction without controller increments', async () => {
  const h = harness({ limits: { Contact: { limit: 1 } } });
  const contacts = load('src/app/services/contact.service.ts', {
    './planUsage.service': h.service,
    '../models/contact.model': { findOwnedByPhone: async () => null, create: async (data, trx) => {
      assert.equal(typeof trx, 'function'); await trx('contacts').insert(data); return data;
    } },
  }).default;
  const result = await contacts.createContact('owner', 'company', { phone_number: '9876543210', country_code: '91' });
  assert.equal(result.phone_number, '9876543210');
  assert.equal(JSON.parse(h.state().user_plans[0].usage).Contact, 1);
});
test('chatbot creation consumes the active plan in its persistence transaction', async () => {
  const h = harness({ limits: { Chatbot: { limit: 1 } } });
  const bots = load('src/app/services/chatbot.service.ts', {
    './planUsage.service': h.service,
    '../models/chatbot.model': { create: async (data, trx) => { assert.equal(typeof trx, 'function'); return data; } },
  }).default;
  await bots.createChatBot({ user_id: 'owner', company_id: 'company', name: ' Bot ' });
  assert.equal(JSON.parse(h.state().user_plans[0].usage).Chatbot, 1);
  await assert.rejects(bots.createChatBot({ user_id: 'owner', company_id: 'company', name: 'Second' }), /limit reached/);
});
