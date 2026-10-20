const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs'), vm = require('node:vm'), ts = require('typescript');
const express = require('express');
function load(file, deps = {}) {
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: id => deps[id] || {}, Date, process: { env: {} },
    console: { log() {}, info() {}, warn() {}, error() {} } });
  return exports;
}
class HttpError extends Error { constructor({ message }) { super(message); } }
const errors = Object.fromEntries(['HTTP400Error', 'HTTP403Error', 'HTTP404Error'].map(key => [`@surefy/exceptions/${key}`, HttpError]));
const catalog = load('src/app/utils/chatbotTemplates.ts');
const messages = load('src/app/utils/chatbotMessage.ts');
const featureUtils = load('src/app/utils/planFeatures.ts', errors);
const choices = load('src/app/services/chatbot/interactiveChoice.ts');
const input = { name: 'My editable chatbot', customizations: { business_name: 'Acme "Business"', support_contact: 'support@example.invalid' } };
const actor = { userId: 'member', ownerId: 'owner', companyId: 'company' };
function fixture(limit = 2) {
  let state = { users: [{ id: 'owner', company_id: 'company' }],
    user_plans: [{ id: 'plan', user_id: 'owner', active: true, start_date: '2020-01-01', end_date: '2099-01-01',
      entitlement_version: 2, limits: { Chatbot: { limit, enabled: true } }, usage: {}, usage_periods: {} }],
    chat_bot: [], chat_bot_node: [], chat_bot_edge: [], activity_logs: [], chatbot_triggers: [] };
  let tail = Promise.resolve(), failedTable;
  const connection = draft => table => {
    const filters = []; let op, payload, first = false, count = false;
    const q = {
      where(value) { filters.push(row => Object.entries(value).every(([k, v]) => row[k] === v)); return q; },
      whereNull(key) { filters.push(row => row[key] == null); return q; },
      forUpdate() { return q; }, first() { first = true; return q; }, returning() { return q; },
      count() { count = true; return q; },
      insert(value) { op = 'insert'; payload = value; return q; }, update(value) { op = 'update'; payload = value; return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        if (op && failedTable === table) throw Error('injected write failure');
        let rows = draft[table].filter(row => filters.every(match => match(row)));
        if (op === 'insert') { rows = (Array.isArray(payload) ? payload : [payload]).map(value => ({ id: crypto.randomUUID(), ...value })); draft[table].push(...rows); }
        if (op === 'update') rows.forEach(row => Object.assign(row, payload));
        if (count) rows = [{ total: rows.length }];
        return first ? rows[0] : rows;
      }).then(resolve, reject); },
    }; return q;
  };
  const db = { transaction(callback) {
    const result = tail.then(async () => { const draft = structuredClone(state); const result = await callback(connection(draft)); state = draft; return result; });
    tail = result.catch(() => {}); return result;
  } };
  const quota = load('src/app/services/planUsage.service.ts', { ...errors, '@surefy/database': db, '../utils/planFeatures': featureUtils }).default;
  const api = load('src/app/services/chatbotTemplate.service.ts', { ...errors, uuid: { v4: crypto.randomUUID },
    './planUsage.service': quota, '../utils/chatbotTemplates': catalog, '../utils/chatbotMessage': messages,
    '../utils/activityContext': { markActivityRecorded() {} } }).default;
  return { api, state: () => state, fail(table) { failedTable = table; } };
}

test('nine industry templates expose previews with valid connected existing message nodes', () => {
  const f = fixture(), list = f.api.list();
  assert.equal(list.length, 9); assert.equal(f.api.categories().length, 9);
  assert.equal(f.api.list('travel').length, 1);
  assert.throws(() => f.api.list('unknown'), /Unknown/);
  assert.throws(() => f.api.detail('unknown'), /not found/);
  for (const item of list) {
    assert.equal(item.nodes, undefined); assert.equal(item.meta_approved, false);
    const graph = f.api.detail(item.id), ids = new Set(graph.nodes.map(node => node.id));
    assert.equal(ids.size, graph.nodes.length);
    assert.equal(graph.nodes.filter(node => node.type === 'trigger').length, 1);
    for (const node of graph.nodes) messages.validateChatbotMessage(node.data);
    for (const edge of graph.edges) assert.ok(ids.has(edge.source) && ids.has(edge.target));
    const visited = new Set(['trigger']);
    for (let pass = 0; pass < graph.nodes.length; pass++) for (const edge of graph.edges) if (visited.has(edge.source)) visited.add(edge.target);
    assert.equal(visited.size, graph.nodes.length);
    const menu = graph.nodes.find(node => node.id === 'menu');
    for (const row of menu.data.attributes.message.interactive.action.sections[0].rows) {
      assert.ok(row.title.length <= 24);
      const edge = choices.resolveInteractiveEdge(graph, 'menu', row.id, row.title);
      assert.ok(edge); assert.equal(graph.nodes.find(node => node.id === edge.target).data.key, '@whatsapp/ask-question');
    }
    graph.nodes[0].data.attributes.keywords.push('tenant-edit');
    assert.equal(f.api.detail(item.id).nodes[0].data.attributes.keywords.includes('tenant-edit'), false);
  }
});

test('use creates an owned editable draft, remaps graph IDs, fills customization and consumes one chatbot slot', async () => {
  const f = fixture();
  const first = await f.api.use(actor, 'real-estate-starter', input);
  assert.equal(first.published, false); assert.equal(first.status, 'draft'); assert.equal(first.user_id, 'owner');
  assert.equal(first.company_id, 'company'); assert.equal(first.requires_phone_assignment, true);
  assert.equal(first.phoneNumberIds.length, 0); assert.equal(f.state().chatbot_triggers.length, 0);
  const payload = JSON.stringify(first.nodes);
  assert.ok(payload.includes('support@example.invalid')); assert.ok(payload.includes('Acme'));
  assert.equal(/\{\{business_name\}\}|\{\{support_contact\}\}/.test(payload), false);
  for (const edge of first.edges) assert.ok(first.nodes.some(node => node.id === edge.source) && first.nodes.some(node => node.id === edge.target));
  assert.equal(JSON.parse(f.state().user_plans[0].usage).Chatbot, 1);
  assert.equal(f.state().activity_logs[0].user_id, 'member');
  const second = await f.api.use(actor, 'real-estate-starter', input);
  assert.notEqual(first.id, second.id);
  assert.equal(second.nodes.some(node => first.nodes.some(original => original.id === node.id)), false);
  await assert.rejects(f.api.use(actor, 'travel-starter', input), /limit reached/);
  assert.equal(f.state().chat_bot.length, 2);
});

test('concurrent copies cannot exceed the last available chatbot slot', async () => {
  const f = fixture(1);
  const results = await Promise.allSettled([f.api.use(actor, 'education-starter', input), f.api.use(actor, 'it-saas-starter', input)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(f.state().chat_bot.length, 1);
});

test('copy errors roll back the bot, graph, audit and quota; foreign owners and client identities are rejected', async () => {
  for (const table of ['chat_bot_node', 'chat_bot_edge', 'activity_logs']) {
    const f = fixture(), before = structuredClone(f.state()); f.fail(table);
    await assert.rejects(f.api.use(actor, 'travel-starter', input), /injected/);
    assert.deepEqual(f.state(), before);
  }
  const f = fixture(), before = structuredClone(f.state());
  await assert.rejects(f.api.use({ ...actor, companyId: 'other-company' }, 'travel-starter', input), /authenticated company/);
  for (const bad of [undefined, [], {}, { ...input, published: true }, { ...input, user_id: 'other' },
    { ...input, nodes: [] }, { ...input, name: '' }, { ...input, customizations: { business_name: '{{secret}}' } },
    { ...input, customizations: { business_name: 'Test', api_key: 'not-allowed' } }])
    await assert.rejects(f.api.use(actor, 'travel-starter', bad));
  await assert.rejects(f.api.use({}, 'travel-starter', input), /Authenticated/);
  assert.deepEqual(f.state(), before);
});

test('all nine copies run every menu branch and collect answers through the current menu and execution engine', async () => {
  const f = fixture(20);
  for (const item of f.api.list()) {
    const bot = await f.api.use(actor, item.id, input);
    const builder = load('src/app/utils.ts', { './utils/chatbotMessage': messages, nodemailer: { createTransport: () => ({}) } }).buildResponse;
    const rows = bot.nodes.find(node => node.data.key === '@whatsapp/send-list-message').data.attributes.message.interactive.action.sections[0].rows;
    for (const row of rows) {
      const menu = bot.nodes.find(node => node.data.key === '@whatsapp/send-list-message');
      const session = { id: 'session', active: true, current_node_id: menu.id, variables: {} };
      const sessions = { update: async (_id, changes) => { Object.assign(session, changes); return session; } };
      const execute = load('src/app/services/chatbot/engine/executeNode.ts', {
        '@surefy/console/app/models/chatSession.model': sessions, '@surefy/console/utils': { buildResponse: builder },
      }).executeNode;
      const flow = load('src/app/services/chatbot/flows/menu.flow.ts', {
        '@surefy/console/app/models/chatSession.model': sessions,
        '@surefy/console/services/chatbot/engine/executeNode': { executeNode: execute },
        '../interactiveChoice': choices,
      }).menuFlow;
      const welcome = await execute({ bot, session, currentNode: menu });
      assert.equal(welcome.interactive.type, 'list');
      let reply = await flow({ bot, session, incomingId: row.id, incomingText: row.title });
      let answered = 0;
      while (session.active) {
        const node = bot.nodes.find(node => node.id === session.current_node_id);
        assert.equal(node.data.key, '@whatsapp/ask-question');
        assert.equal(typeof reply.text, 'string');
        const variable = node.data.attributes.variable;
        reply = await flow({ bot, session, incomingText: 'Customer answer' });
        assert.equal(session.variables[variable], 'Customer answer');
        assert.ok(++answered < 10, 'branch must reach its end');
      }
      assert.ok(answered >= 1); assert.ok(reply.text.includes('support@example.invalid'));
    }
  }
});

test('copies can be saved using the existing flow API with phone assignment and preserved list reply handles', async () => {
  const f = fixture(), bot = await f.api.use(actor, 'real-estate-starter', input), writes = [];
  const trx = table => {
    const q = { where() { return q; }, whereIn() { return q; }, whereNot() { return q; }, whereRaw() { return q; }, leftJoin() { return q; }, forUpdate() { return q; },
      first: async () => bot, select: async () => [], delete: async () => {}, update: async () => {},
      insert: async value => writes.push({ table, value }) }; return q;
  }; trx.raw = async () => {};
  const api = load('src/app/services/chatbot.service.ts', { ...errors, uuid: { v4: crypto.randomUUID },
    '@surefy/database': { transaction: callback => callback(trx) }, '../utils/chatbotMessage': messages,
    '../models/chatbot.model': { findById: async () => bot },
    '../models/phoneNumber.model': { findByPhoneNumberId: async () => ({ id: 'phone-uuid', phone_number_id: 'meta-id', user_id: 'owner' }) },
  }).default;
  const saved = await api.createFlow('owner', { chatBotId: bot.id, name: 'Edited flow', nodes: bot.nodes, edges: bot.edges, phoneNumberIds: ['meta-id'] });
  assert.equal(saved.name, 'Edited flow');
  const nodes = writes.find(write => write.table === 'chat_bot_node').value;
  const edges = writes.find(write => write.table === 'chat_bot_edge').value;
  const menu = nodes.find(node => JSON.parse(node.data).key === '@whatsapp/send-list-message');
  for (const row of JSON.parse(menu.data).attributes.message.interactive.action.sections[0].rows)
    assert.equal(edges.filter(edge => edge.source === menu.id && JSON.parse(edge.data).sourceHandle === row.id).length, 1);
  assert.ok(writes.some(write => write.table === 'chatbot_triggers' && write.value.active === false));
});

test('template endpoints precede chatbot-ID routes and create returns an unpublished editable graph', async () => {
  const f = fixture();
  const controller = load('src/app/http/controllers/chatbot.controller.ts', {
    '../../services/chatbotTemplate.service': f.api,
    '@surefy/utils/Controller': { tryCatchAsync: callback => (req, res, next) => Promise.resolve(callback(req, res)).catch(next),
      successResponse: (_req, res, message, data, status = 200) => res.status(status).json({ success: true, message, data }) },
    '@surefy/utils/HttpStatusCode': { HttpStatusCode: { CREATED: 201 } },
  }).default;
  const route = load('src/routes/chatbot.route.ts', { express, '../app/http/controllers/chatbot.controller': controller,
    '@surefy/middleware/plan.middleware': { checkPlanLimit: () => (_req, _res, next) => next() } }).default;
  const app = express(); app.use(express.json()); app.use((req, _res, next) => { Object.assign(req, actor); next(); });
  app.use('/v1/admin/chatbot', route); app.use((error, _req, res, _next) => res.status(400).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  try {
    const base = `http://127.0.0.1:${server.address().port}/v1/admin/chatbot/templates`;
    assert.equal((await (await fetch(base + '/categories')).json()).data.length, 9);
    assert.equal((await (await fetch(base + '?category=health-care')).json()).data[0].id, 'health-care-starter');
    assert.ok((await (await fetch(base + '/travel-starter')).json()).data.nodes.length > 0);
    const response = await fetch(base + '/travel-starter/use', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 201); assert.equal((await response.json()).data.published, false);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('PostgreSQL template copy uses the existing schema and persists a private graph and quota atomically',
  { skip: process.env.CHATBOT_TEMPLATES_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true }); require('ts-node/register');
    const config = require('../library/surefy/src/config/knex.config').default.development;
    const db = require('knex')({ ...config, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const schema = 'chatbot_template_test_' + crypto.randomUUID().replaceAll('-', '');
    const marker = Error('ROLLBACK_CHATBOT_TEMPLATE_TEST');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema); await trx.raw('SET LOCAL search_path TO ??', [schema]);
        // Clone actual production-shaped columns/defaults instead of inventing a test schema.
        // Foreign keys are not copied by LIKE, so all fixtures stay inside this isolated schema.
        for (const table of ['users', 'user_plans', 'chat_bot', 'chat_bot_node', 'chat_bot_edge', 'activity_logs', 'chatbot_triggers'])
          await trx.raw('CREATE TABLE ?? (LIKE ?? INCLUDING DEFAULTS INCLUDING CONSTRAINTS)', [`${schema}.${table}`, `public.${table}`]);
        const ownerId = crypto.randomUUID(), companyId = crypto.randomUUID();
        await trx('users').insert({ id: ownerId, company_id: companyId, name: 'Rollback-only template owner',
          email: `template-${ownerId}@example.invalid`, password: 'not-a-real-login', status: 'active', role: 'user' });
        await trx('user_plans').insert({ id: crypto.randomUUID(), user_id: ownerId, company_id: companyId,
          plan_name: 'Pro', price: 200, billing_cycle: 'Monthly', active: true, status: 'COMPLETED',
          start_date: '2020-01-01', end_date: '2099-01-01', entitlement_version: 2,
          limits: JSON.stringify({ Chatbot: { limit: 2, enabled: true } }), usage: '{}', usage_periods: '{}' });
        const testDb = { transaction: callback => trx.transaction(callback) };
        const quota = load('src/app/services/planUsage.service.ts', { ...errors, '@surefy/database': testDb, '../utils/planFeatures': featureUtils }).default;
        const api = load('src/app/services/chatbotTemplate.service.ts', { ...errors, uuid: { v4: crypto.randomUUID },
          './planUsage.service': quota, '../utils/chatbotTemplates': catalog, '../utils/chatbotMessage': messages,
          '../utils/activityContext': { markActivityRecorded() {} } }).default;
        const copied = await api.use({ userId: ownerId, companyId }, 'education-starter', input);
        const bot = await trx('chat_bot').where({ id: copied.id }).first();
        assert.equal(bot.published, false); assert.equal(bot.user_id, ownerId); assert.equal(bot.company_id, companyId);
        const nodes = await trx('chat_bot_node').where({ chatBotId: bot.id });
        const edges = await trx('chat_bot_edge').where({ chatBotId: bot.id });
        assert.equal(nodes.length, copied.nodes.length); assert.equal(edges.length, copied.edges.length);
        assert.ok(nodes.every(node => node.user_id === ownerId && typeof node.data === 'object'));
        const menu = nodes.find(node => node.data.key === '@whatsapp/send-list-message');
        assert.ok(menu.data.attributes.message.interactive.body.text.includes('Acme "Business"'));
        for (const row of menu.data.attributes.message.interactive.action.sections[0].rows)
          assert.equal(edges.filter(edge => edge.source === menu.id && edge.data.sourceHandle === row.id).length, 1);
        assert.equal((await trx('user_plans').where({ user_id: ownerId }).first()).usage.Chatbot, 1);
        assert.equal(Number((await trx('chatbot_triggers').count('* as total').first()).total), 0);
        assert.equal((await trx('activity_logs').first()).new_data.template_id, 'education-starter');
        await assert.rejects(api.use({ userId: ownerId, companyId: crypto.randomUUID() }, 'education-starter', input), /authenticated company/);
        throw marker;
      }), error => error === marker);
      assert.equal((await db.raw('SELECT 1 FROM pg_namespace WHERE nspname = ?', [schema])).rows.length, 0);
    } finally { await db.destroy(); }
  });
