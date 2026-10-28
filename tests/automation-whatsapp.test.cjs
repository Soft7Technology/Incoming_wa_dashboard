const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const express = require('express');

const es = value => ({ __esModule: true, default: value });
function load(file, dependencies) {
  const exports = {};
  const code = require('typescript').transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { target: 7, module: 1, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : require(id),
    process, Buffer, URL, Date, console, setInterval, clearInterval, __dirname: path.dirname(path.resolve(file)) });
  return exports;
}
class CustomError extends Error {
  constructor(message, statusCode) { super(message); this.statusCode = statusCode; this.isOperational = true; }
}
const basicPhones = require('libphonenumber-js');
const utils = load('src/app/utils/automationFlow.ts', { '@surefy/exceptions/CustomError': { CustomError }, 'libphonenumber-js': {
  ...basicPhones, parsePhoneNumberFromString: (value, options) => basicPhones.parsePhoneNumberFromString(value, options ? { ...options } : undefined),
} });
const templates = load('src/app/utils/automationTemplate.ts', { './automationFlow': utils });
const phoneLibrary = require('libphonenumber-js/max');
const phones = load('src/app/utils/importPhone.ts', { 'libphonenumber-js/max': { ...phoneLibrary,
  parsePhoneNumberFromString: (value, options) => phoneLibrary.parsePhoneNumberFromString(value, options ? { ...options } : undefined),
} });

// Minimal in-memory query adapter; providers are isolated so no real messages or payments occur.
function memoryDatabase(state) {
  const db = table => {
    const predicates = []; let first = false, mutation, columns;
    const q = {
      where(field, operator, value) {
        if (typeof field === 'object') predicates.push(row => Object.entries(field).every(([key, v]) => row[key] === v));
        else predicates.push(row => operator === '>' ? row[field] > value : row[field] === operator);
        return q;
      },
      whereNull(field) { predicates.push(row => row[field] == null); return q; },
      select(...fields) { columns = fields; return q; },
      first(...fields) { first = true; if (fields.length) columns = fields; return q; },
      orderBy() { return q; }, forUpdate() { return q; }, skipLocked() { return q; },
      update(data) { mutation = data; return q; }, returning() { return q; },
      then(resolve, reject) { return Promise.resolve().then(() => {
        const rows = (state[table] || []).filter(row => predicates.every(check => check(row)));
        if (mutation) rows.forEach(row => Object.assign(row, mutation));
        const result = columns ? rows.map(row => Object.fromEntries(columns.map(key => [key, row[key]]))) : rows;
        return first ? result[0] : result;
      }).then(resolve, reject); },
    };
    return q;
  };
  db.fn = { now: () => new Date() };
  db.schema = { hasTable: async table => Object.hasOwn(state, table) };
  db.transaction = callback => callback(db);
  return db;
}

function fixture() {
  const ids = Object.fromEntries(['user', 'company', 'peer', 'phone', 'otherPhone', 'waba', 'otherWaba', 'template', 'google', 'razor', 'flow', 'event', 'run', 'trigger', 'sheetStep', 'paymentStep', 'sendStep'].map(key => [key, crypto.randomUUID()]));
  const scope = { userId: ids.user, companyId: ids.company };
  const phone = { id: ids.phone, company_id: ids.company, user_id: ids.user, waba_id: ids.waba, status: 'active', display_phone_number: '+12025550124', access_token: 'never-expose-token' };
  const template = { id: ids.template, company_id: ids.company, waba_id: ids.waba, status: 'APPROVED', name: 'order_payment', language: 'en', category: 'UTILITY', components: [
    { type: 'BODY', text: 'Hello {{1}}, pay {{2}} here: {{3}}' },
  ] };
  const state = {
    users: [{ id: ids.user, company_id: ids.company, status: 'active', role: 'user' }, { id: ids.peer, company_id: ids.company, status: 'active', role: 'user' }],
    companies: [{ id: ids.company, status: 'active' }],
    phone_numbers: [phone, { ...phone, id: ids.otherPhone, user_id: ids.peer, waba_id: ids.otherWaba }],
    templates: [template], messages: [], contacts: [], automation_runs: [], automation_events: [], automation_flows: [],
    google_sheet_connections: [{ id: ids.google, company_id: ids.company, owner_id: ids.user }],
    automation_connections: [{ id: ids.razor, company_id: ids.company, user_id: ids.user, app_key: 'razorpay', status: 'connected', mode: 'test' }],
  };
  const db = memoryDatabase(state);
  const { AutomationFlowService } = load('src/app/services/automationFlow.service.ts', {
    '@surefy/database': db, '../utils/automationFlow': utils, '../utils/shopify': {}, '../utils/automationTemplate': templates,
  });
  const flowService = new AutomationFlowService(db);
  const sent = [], calls = []; let blocked = false, sendError;
  let quotaError, allocations = 0, quotaTail = Promise.resolve();
  const contactModel = {
    findOwnedByPhone: async (userId, number, phoneId, companyId) => state.contacts.find(contact => contact.user_id === userId && contact.company_id === companyId && contact.phone_number_id === phoneId && contact.phone_number === number && !contact.deleted_at),
    create: async (data, trx) => {
      assert.equal(trx, 'quota-transaction');
      const existing = await contactModel.findOwnedByPhone(data.user_id, data.phone_number, data.phone_number_id, data.company_id);
      if (existing) throw new CustomError('Duplicate contact', 400);
      const contact = { ...data, id: crypto.randomUUID(), is_opted_out: false };
      state.contacts.push(contact); return contact;
    },
  };
  const usage = { assert: async () => { if (quotaError) throw quotaError; }, run(userId, feature, create) {
    assert.equal(userId, ids.user); assert.equal(feature, 'Contact');
    const result = quotaTail.then(async () => { if (quotaError) throw quotaError; const contact = await create('quota-transaction'); allocations++; return contact; });
    quotaTail = result.catch(() => {}); return result;
  } };
  const { AutomationContactService } = load('src/app/services/automationContact.service.ts', {
    '../models/contact.model': es(contactModel), './planUsage.service': es(usage), '../utils/importPhone': phones, '../utils/automationFlow': utils,
  });
  const contacts = new AutomationContactService();
  const { AutomationWhatsAppService } = load('src/app/services/automationWhatsApp.service.ts', {
    '@surefy/database': db, '../utils/importPhone': phones, '../utils/automationFlow': utils, '../utils/automationTemplate': templates,
    './contactOptOut.service': es({ isBlocked: async () => blocked }),
    './automationContact.service': es(contacts),
    './message.service': es({ sendMessage: async (data, resolved) => {
      calls.push('whatsapp');
      if (sendError) throw sendError;
      sent.push({ data, resolved });
      const message = { id: data.messageUUID, wamid: 'wamid.test', status: 'sent', to_phone: data.to };
      state.messages.push(message); return message;
    } }),
  });
  const whatsapp = new AutomationWhatsAppService(db);
  const step = { _id: ids.sendStep, appKey: 'whatsapp', key: 'sendTemplate', connectionId: ids.phone };
  const parameters = { to: '+12025550123', template_id: ids.template, variables: { 'body.1': 'Asha', 'body.2': 500, 'body.3': 'https://rzp.io/i/test' } };
  return { ids, scope, phone, template, state, db, flowService, whatsapp, contacts, step, parameters, sent, calls,
    setBlocked(value) { blocked = value; }, setError(value) { sendError = value; }, setQuotaError(value) { quotaError = value; }, allocations: () => allocations };
}

test('templates expose and render positional, named, URL button and media fields', () => {
  const template = { name: 'receipt', language: 'en', components: [
    { type: 'HEADER', format: 'DOCUMENT' }, { type: 'BODY', text: '{{2}} for {{1}}, then {{2}}' },
    { type: 'BUTTONS', buttons: [{ type: 'PHONE_NUMBER' }, { type: 'URL', url: 'https://example.com/pay/{{1}}' }] },
  ] };
  assert.deepEqual(Array.from(templates.automationTemplateFields(template), field => field.key), ['header.media_url', 'body.1', 'body.2', 'button.1.1']);
  const rendered = templates.renderAutomationTemplate(template, { 'header.media_url': 'https://example.com/receipt.pdf', 'body.1': 'Asha', 'body.2': 500, 'button.1.1': 'order-123' });
  assert.equal(rendered.components[0].parameters[0].document.link, 'https://example.com/receipt.pdf');
  assert.equal(rendered.components[1].parameters[0].text, 'Asha');
  assert.equal(rendered.components[1].parameters[1].text, '500');
  assert.equal(rendered.components[2].index, '1'); assert.equal(rendered.components[2].sub_type, 'url');
  assert.equal(rendered.components[2].parameters[0].text, 'order-123');
  const named = { name: 'named', language: 'en', components: [{ type: 'BODY', text: '{{customer}}: {{paid}}' }] };
  const output = templates.renderAutomationTemplate(named, { 'body.customer': 'Asha', 'body.paid': false });
  assert.equal(output.components[0].parameters[0].parameter_name, 'customer');
  assert.equal(output.components[0].parameters[1].text, 'false');
  for (const values of [{}, { 'body.customer': null }, { 'body.customer': {} }, { 'body.customer': 'Asha', 'body.paid': true, extra: 'wrong' }])
    assert.throws(() => templates.renderAutomationTemplate(named, values), error => error.statusCode === 400);
  assert.throws(() => templates.renderAutomationTemplate(template, { 'header.media_url': 'http://example.com/file' }), /HTTPS/);
  assert.throws(() => templates.automationTemplateFields({ components: [{ type: 'CAROUSEL' }] }), /body/);
});

test('Sheets numeric cells map to template text without changing source data', () => {
  const f = fixture(), definition = utils.action('whatsapp', 'sendTemplate');
  const input = { to: '{{steps.sheet.values.0.0}}', template_id: f.ids.template, variables: { 'body.1': '{{steps.sheet.values.0.1}}', 'body.2': '{{steps.sheet.values.0.2}}', 'body.3': '{{steps.payment.short_url}}' } };
  const context = { steps: { sheet: { values: [[12025550123, 'Asha', 500]] }, payment: { short_url: 'https://rzp.io/i/test' } } };
  utils.validateParameters(definition, input, true);
  const result = utils.validateParameters(definition, utils.resolveParameters(input, context));
  assert.equal(result.to, '12025550123'); assert.equal(result.variables['body.2'], '500');
  assert.equal(typeof context.steps.sheet.values[0][2], 'number');
  for (const value of [null, {}, [], NaN]) assert.throws(() => utils.validateParameters(definition, { ...f.parameters, variables: { 'body.1': value } }));
  assert.throws(() => utils.validateParameters(definition, { ...f.parameters, to: Number.MAX_SAFE_INTEGER }));
  const payment = { event: 'payment.captured', payload: { payment: { entity: { id: 'pay_test123', amount: 500, contact: '+12025550123' } } } };
  const receipt = utils.validateParameters(definition, utils.resolveParameters({
    to: '{{trigger.payload.payment.entity.contact}}', template_id: f.ids.template,
    variables: { 'body.1': '{{trigger.payload.payment.entity.id}}', 'body.2': '{{trigger.payload.payment.entity.amount}}', 'body.3': 'Received' },
  }, { trigger: payment }));
  assert.equal(receipt.to, '+12025550123'); assert.equal(receipt.variables['body.1'], 'pay_test123'); assert.equal(receipt.variables['body.2'], '500');
});

test('template picker HTTP endpoint scopes sender and approved templates and never exposes credentials', async () => {
  const f = fixture();
  f.state.templates.push(
    { ...f.template, id: crypto.randomUUID(), status: 'PENDING' },
    { ...f.template, id: crypto.randomUUID(), waba_id: f.ids.otherWaba },
    { ...f.template, id: crypto.randomUUID(), deleted_at: new Date() },
    { ...f.template, id: crypto.randomUUID(), components: [{ type: 'BODY', text: 'Hello' }, { type: 'CAROUSEL' }] },
  );
  const helpers = { tryCatchAsync: fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next),
    successResponse: (_req, res, _message, data) => res.json({ success: true, data }) };
  const controller = load('src/app/http/controllers/automationFlow.controller.ts', { '@surefy/utils/Controller': helpers, '../../services/automationFlow.service': es(f.flowService) });
  const route = load('src/routes/automationFlow.route.ts', { '../app/http/controllers/automationFlow.controller': controller }).default;
  const app = express(); app.use((req, _res, next) => { req.userId = f.scope.userId; req.companyId = f.scope.companyId; next(); });
  app.use('/flows', route); app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = 'http://127.0.0.1:' + server.address().port + '/flows';
    const response = await fetch(base + '/connections/' + f.ids.phone + '/templates');
    assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'no-store');
    const { data } = await response.json(); assert.equal(data.length, 2);
    assert.equal(data[0].supported, true); assert.deepEqual(data[0].required_variables, ['body.1', 'body.2', 'body.3']);
    assert.equal(data[1].supported, false); assert.match(data[1].reason, /Unsupported/);
    assert.equal((await fetch(base + '/connections/' + f.ids.otherPhone + '/templates')).status, 404);
    const apps = await (await fetch(base + '/apps')).json();
    const whatsapp = apps.data.find(app => app.appKey === 'whatsapp');
    assert.equal(whatsapp.connection_api, null); assert.ok(whatsapp.templates_api);
    assert.ok(whatsapp.actions.some(action => action.key === 'sendTemplate'));
    const connections = await (await fetch(base + '/connections')).json();
    assert.equal(connections.data.filter(connection => connection.appKey === 'whatsapp').length, 1);
    assert.equal(JSON.stringify(connections).includes('never-expose-token'), false);
    f.phone.status = 'inactive';
    assert.equal((await fetch(base + '/connections/' + f.ids.phone + '/templates')).status, 404);
  } finally { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
});

test('sending enforces ownership, approval, opt-out, valid recipient and template variables', async () => {
  const f = fixture(), execute = () => f.whatsapp.execute(f.scope, f.phone, f.step, f.parameters, f.ids.run);
  f.setBlocked(true); await assert.rejects(execute(), error => error.statusCode === 409);
  f.setBlocked(false); f.template.status = 'REJECTED'; await assert.rejects(execute(), /approved template/);
  f.template.status = 'APPROVED'; f.template.waba_id = f.ids.otherWaba; await assert.rejects(execute(), /approved template/);
  f.template.waba_id = f.ids.waba;
  for (const number of ['+1234', 'wrong', '', '+12025550123 ext 9']) {
    f.parameters.to = number; await assert.rejects(execute(), /Invalid recipient/);
  }
  f.parameters.to = '+12025550123'; delete f.parameters.variables['body.3']; await assert.rejects(execute(), /body.3/);
  f.parameters.variables['body.3'] = 'https://rzp.io/i/test';
  f.phone.user_id = f.ids.peer; await assert.rejects(execute(), error => error.statusCode === 404);
  f.phone.user_id = f.ids.user; f.phone.deleted_at = new Date(); await assert.rejects(execute(), error => error.statusCode === 404);
  f.phone.deleted_at = null; assert.equal(f.sent.length, 0);
  f.parameters.to = '2025550123'; f.parameters.country_code = '1';
  const result = await execute(); assert.equal(result.to, '12025550123'); assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].resolved.source, 'automation'); assert.equal(f.sent[0].resolved.templateRecord.id, f.ids.template);
});

test('same run and step never resend confirmed or uncertain attempts', async () => {
  const f = fixture();
  const execute = () => f.whatsapp.execute(f.scope, f.phone, f.step, f.parameters, f.ids.run);
  const sent = await execute(), replay = await execute();
  assert.equal(sent.message_id, replay.message_id); assert.equal(replay.replayed, true); assert.equal(f.sent.length, 1);
  f.state.messages[0].wamid = null;
  await assert.rejects(execute(), error => error.statusCode === 409 && /already attempted/.test(error.message));
  assert.equal(f.sent.length, 1);
  await f.whatsapp.execute(f.scope, f.phone, f.step, f.parameters, crypto.randomUUID());
  assert.equal(f.sent.length, 2); assert.notEqual(f.sent[0].data.messageUUID, f.sent[1].data.messageUUID);
});

test('template sending creates a missing contact with dynamic details and reuses its normalized number', async () => {
  const f = fixture();
  const parameters = { ...f.parameters, to: '2025550123', country_code: '1', contact_name: ' Asha ', contact_email: ' asha@example.test ' };
  await f.whatsapp.prepare(f.scope, f.phone, f.step, parameters);
  assert.equal(f.state.contacts.length, 0, 'preflight must not create a contact');
  const output = await f.whatsapp.execute(f.scope, f.phone, f.step, parameters, f.ids.run);
  assert.equal(f.state.contacts.length, 1); assert.equal(f.allocations(), 1);
  const contact = f.state.contacts[0];
  assert.equal(contact.phone_number, '+12025550123'); assert.equal(contact.country_code, '1');
  assert.equal(contact.phone_number_id, f.ids.phone); assert.equal(contact.user_id, f.ids.user); assert.equal(contact.company_id, f.ids.company);
  assert.equal(contact.name, 'Asha'); assert.equal(contact.email, 'asha@example.test');
  assert.equal(contact.source, 'whatsApp'); assert.equal(contact.attributes.source, 'automation');
  assert.equal(output.contact_id, contact.id); assert.equal(output.contact_created, true);
  assert.equal(f.sent[0].data.profile_name, 'Asha');
  f.setQuotaError(new CustomError('Contact plan limit reached', 403));
  const reused = await f.whatsapp.execute(f.scope, f.phone, f.step, { ...f.parameters, to: '+1 (202) 555-0123', contact_name: 'Different name', contact_email: 'different@example.test' }, crypto.randomUUID());
  assert.equal(f.state.contacts.length, 1); assert.equal(f.allocations(), 1);
  assert.equal(reused.contact_created, false); assert.equal(reused.contact_id, contact.id);
  assert.equal(contact.name, 'Asha'); assert.equal(contact.email, 'asha@example.test');
});

test('contact lookup is scoped to owner and sender, and concurrent creates consume one contact slot', async () => {
  const f = fixture();
  f.state.contacts.push({ id: 'other-owner', user_id: f.ids.peer, company_id: f.ids.company, phone_number_id: f.ids.phone, phone_number: '+12025550123' },
    { id: 'other-sender', user_id: f.ids.user, company_id: f.ids.company, phone_number_id: f.ids.otherPhone, phone_number: '+12025550123' });
  const results = await Promise.all([f.contacts.ensure(f.scope, f.phone, '12025550123'), f.contacts.ensure(f.scope, f.phone, '12025550123')]);
  assert.equal(results[0].contact.id, results[1].contact.id);
  assert.equal(results.filter(result => result.created).length, 1); assert.equal(f.allocations(), 1);
  assert.equal(f.state.contacts.length, 3); assert.equal(results[0].contact.name, '+12025550123');
  await assert.rejects(f.contacts.ensure(f.scope, { ...f.phone, user_id: f.ids.peer }, '12025550123'), error => error.statusCode === 404);
});

test('invalid details, opted-out contacts and contact quota failures do not send a message', async () => {
  const f = fixture(), execute = parameters => f.whatsapp.execute(f.scope, f.phone, f.step, parameters, f.ids.run);
  await assert.rejects(execute({ ...f.parameters, contact_email: 'not-email' }), /contact_email/);
  await assert.rejects(execute({ ...f.parameters, contact_name: 'x'.repeat(256) }), /contact_name/);
  assert.equal(f.state.contacts.length, 0);
  f.setQuotaError(new CustomError('Contact plan limit reached', 403));
  await assert.rejects(execute(f.parameters), /Contact plan limit/);
  assert.equal(f.state.contacts.length, 0); assert.equal(f.sent.length, 0);
  f.state.contacts.push({ id: 'blocked', user_id: f.ids.user, company_id: f.ids.company, phone_number_id: f.ids.phone, phone_number: '+12025550123', is_opted_out: true });
  await assert.rejects(execute(f.parameters), /opted out/); assert.equal(f.sent.length, 0);
  assert.equal(f.state.contacts[0].is_opted_out, true);
});

test('a failed message keeps the created contact and a new send reuses it', async () => {
  const f = fixture(); f.setError(new Error('provider rejected'));
  await assert.rejects(f.whatsapp.execute(f.scope, f.phone, f.step, f.parameters, f.ids.run));
  assert.equal(f.state.contacts.length, 1); assert.equal(f.allocations(), 1);
  f.setError(null);
  const output = await f.whatsapp.execute(f.scope, f.phone, f.step, f.parameters, crypto.randomUUID());
  assert.equal(output.contact_created, false); assert.equal(f.state.contacts.length, 1); assert.equal(f.allocations(), 1);
});

test('preflight validates every action and contact column before any provider write', async () => {
  const priorKey = process.env.AUTOMATION_ENCRYPTION_KEY, priorQueue = process.env.AUTOMATION_QUEUE_NAME;
  process.env.AUTOMATION_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64'); delete process.env.AUTOMATION_QUEUE_NAME;
  try {
    const cases = [
      { name: 'unknown action', change: (_f, steps) => { steps[2].key = 'unknown'; }, error: /Unsupported integration action/ },
      { name: 'missing contact field', change: (_f, steps) => { steps[2].parameters.to = '{{trigger.customer.missing}}'; }, error: /Mapping value is unavailable/ },
      { name: 'null required phone', change: (_f, steps) => { steps[2].parameters.to = '{{trigger.missing_phone}}'; }, error: /to must contain/ },
      { name: 'invalid phone', change: (_f, steps) => { steps[2].parameters.to = '+1234'; }, error: /Invalid recipient/ },
      { name: 'missing template variable', change: (_f, steps) => { delete steps[2].parameters.variables['body.1']; }, error: /body.1/ },
      { name: 'forward action reference', change: (_f, steps) => { steps[1].parameters.values[0][0] = '{{steps.' + steps[2]._id + '.to}}'; }, error: /earlier action/ },
      { name: 'object in Sheet cell', change: (_f, steps) => { steps[1].parameters.values[0][0] = '{{trigger.customer}}'; }, error: /primitive cells/ },
    ];
    for (const scenario of cases) {
      const f = fixture(), writes = [];
      const steps = [
        { _id: f.ids.trigger, type: 'trigger' },
        { _id: f.ids.sheetStep, type: 'action', appKey: 'google-sheets', key: 'appendRows', connectionId: f.ids.google, parameters: { spreadsheet_id: 'orders_sheet', range: 'Orders!A1:C', values: [['{{contact.name}}', '{{contact.phone}}']] } },
        { ...f.step, type: 'action', parameters: { ...f.parameters, variables: { ...f.parameters.variables }, to: '{{contact.phone}}' } },
      ];
      scenario.change(f, steps);
      f.state.automation_flows.push({ id: f.ids.flow, user_id: f.ids.user, company_id: f.ids.company, status: 'inactive' });
      f.state.automation_events.push({ id: f.ids.event, flow_id: f.ids.flow, app_key: 'shopify', expires_at: new Date(Date.now() + 60000), payload_ciphertext: utils.encrypt({ customer: { first_name: 'Asha', phone: '+12025550123' }, missing_phone: null }, `event:${f.ids.event}`) });
      f.state.automation_runs.push({ id: f.ids.run, flow_id: f.ids.flow, event_id: f.ids.event, kind: 'manual', status: 'queued', definition: steps });
      const { AutomationRunner } = load('src/app/services/automationRunner.service.ts', { './automationFlow.service': { AutomationFlowService: class {} }, './automationProvider.service': { AutomationProvider: class {} }, '../utils/automationFlow': utils });
      const runner = new AutomationRunner(f.flowService, { execute: async (...args) => { writes.push(args); return {}; }, validate: async (scope, step, parameters) => {
        if (step.appKey === 'whatsapp') await f.whatsapp.prepare(scope, f.phone, step, parameters);
      } });
      await runner.processNext();
      assert.equal(f.state.automation_runs[0].status, 'failed', scenario.name);
      assert.match(f.state.automation_runs[0].error, scenario.error, scenario.name);
      assert.equal(writes.length, 0, scenario.name + ' must not append a Sheet row');
      const results = utils.decrypt(f.state.automation_runs[0].results_ciphertext, `run:${f.ids.run}`);
      assert.equal(results[0].status, 'failed'); assert.ok(results[0].step_id);
    }
  } finally {
    if (priorKey === undefined) delete process.env.AUTOMATION_ENCRYPTION_KEY; else process.env.AUTOMATION_ENCRYPTION_KEY = priorKey;
    if (priorQueue === undefined) delete process.env.AUTOMATION_QUEUE_NAME; else process.env.AUTOMATION_QUEUE_NAME = priorQueue;
  }
});

test('a named local queue cannot be claimed by the legacy queue and remains queued in API responses', async () => {
  const priorQueue = process.env.AUTOMATION_QUEUE_NAME, priorKey = process.env.AUTOMATION_ENCRYPTION_KEY;
  process.env.AUTOMATION_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
  process.env.AUTOMATION_QUEUE_NAME = 'local';
  try {
    const f = fixture();
    assert.equal(utils.queuedStatus(), 'queued:local');
    assert.equal(f.flowService.publicRun({ id: 'run', status: 'queued:local' }).status, 'queued');
    f.state.automation_runs.push({ id: f.ids.run, status: 'queued' });
    const { AutomationRunner } = load('src/app/services/automationRunner.service.ts', { './automationFlow.service': { AutomationFlowService: class {} }, './automationProvider.service': { AutomationProvider: class {} }, '../utils/automationFlow': utils });
    const runner = new AutomationRunner(f.flowService, { execute: async () => { throw Error('Must not execute another queue'); } });
    assert.equal(await runner.processNext(), false);
    assert.equal(f.state.automation_runs[0].status, 'queued');
    f.state.automation_runs.push({ id: crypto.randomUUID(), flow_id: crypto.randomUUID(), status: 'queued:local' });
    assert.equal(await runner.processNext(), true);
    assert.equal(f.state.automation_runs[0].status, 'queued');
    assert.equal(f.state.automation_runs[1].status, 'cancelled');
    process.env.AUTOMATION_QUEUE_NAME = '../bad'; assert.throws(() => utils.queuedStatus(), /AUTOMATION_QUEUE_NAME/);
  } finally {
    if (priorQueue === undefined) delete process.env.AUTOMATION_QUEUE_NAME; else process.env.AUTOMATION_QUEUE_NAME = priorQueue;
    if (priorKey === undefined) delete process.env.AUTOMATION_ENCRYPTION_KEY; else process.env.AUTOMATION_ENCRYPTION_KEY = priorKey;
  }
});

test('preflight checks known fields even alongside values from earlier action outputs', () => {
  const context = { trigger: { id: 123, name: 'Asha' }, contact: { phone: '+12025550123' } };
  const input = { to: '{{contact.phone}}', variables: { 'body.1': '{{trigger.name}}', 'body.2': '{{steps.payment.short_url}}' } };
  const result = utils.resolveAvailableParameters(input, context);
  assert.equal(result.to, '+12025550123'); assert.equal(result.variables['body.1'], 'Asha');
  assert.equal(result.variables['body.2'], '{{steps.payment.short_url}}');
  assert.throws(() => utils.resolveAvailableParameters('{{trigger.missing}} {{steps.payment.id}}', context), /Mapping value is unavailable/);
});

test('worker runs Sheets then Razorpay then dynamic WhatsApp template and halts after uncertain send', async () => {
  const prior = process.env.AUTOMATION_ENCRYPTION_KEY;
  process.env.AUTOMATION_ENCRYPTION_KEY = Buffer.alloc(32, 4).toString('base64');
  try {
    const f = fixture();
    const payment = f.state.automation_connections[0];
    payment.credentials_ciphertext = utils.encrypt({ key_id: 'rzp_test_fake', key_secret: 'private-secret' }, `connection:${f.ids.company}:${f.ids.user}:${f.ids.razor}`);
    const { AutomationProvider } = load('src/app/services/automationProvider.service.ts', {
      './automationFlow.service': {}, '../utils/automationFlow': utils,
      './googleSheets.service': es({ automation: async (_scope, id, key, parameters) => { f.calls.push('google-sheets'); assert.equal(id, f.ids.google); assert.equal(key, 'appendRows'); assert.equal(parameters.values[0][0], 'Asha'); return { updates: { updatedRows: 1 } }; } }),
      './automationWhatsApp.service': es(f.whatsapp),
      axios: es({ request: async request => { f.calls.push('razorpay'); assert.equal(request.data.amount, 500); return { data: { ...request.data, id: 'plink_test123', short_url: 'https://rzp.io/i/test', status: 'created' } }; } }),
    });
    const definition = [
      { _id: f.ids.trigger, type: 'trigger', appKey: 'razorpay', key: 'payment_captured', connectionId: f.ids.razor, parameters: {}, status: 'complete' },
      { _id: f.ids.sheetStep, type: 'action', appKey: 'google-sheets', key: 'appendRows', connectionId: f.ids.google, status: 'complete', parameters: { spreadsheet_id: 'orders_sheet', range: 'Orders!A1:C', values: [['{{trigger.customer.name}}', '{{trigger.amount}}']] } },
      { _id: f.ids.paymentStep, type: 'action', appKey: 'razorpay', key: 'createPaymentLink', connectionId: f.ids.razor, status: 'complete', parameters: { amount_paise: '{{trigger.amount}}', description: 'Order for {{trigger.customer.name}}' } },
      { ...f.step, type: 'action', status: 'complete', parameters: { to: '{{trigger.customer.phone}}', template_id: f.ids.template, variables: { 'body.1': '{{trigger.customer.name}}', 'body.2': '{{trigger.amount}}', 'body.3': '{{steps.' + f.ids.paymentStep + '.short_url}}' } } },
    ];
    await f.flowService.validateReady(f.scope, { steps: definition });
    const savedVariables = definition[3].parameters.variables;
    definition[3].parameters.variables = {};
    await assert.rejects(f.flowService.validateReady(f.scope, { steps: definition }), /body.1/);
    definition[3].parameters.variables = savedVariables;
    f.template.status = 'DISABLED'; await assert.rejects(f.flowService.validateReady(f.scope, { steps: definition }), /approved template/); f.template.status = 'APPROVED';
    f.state.automation_flows.push({ id: f.ids.flow, user_id: f.ids.user, company_id: f.ids.company, status: 'active' });
    f.state.automation_events.push({ id: f.ids.event, flow_id: f.ids.flow, app_key: 'razorpay', expires_at: new Date(Date.now() + 60000), payload_ciphertext: utils.encrypt({ amount: 500, customer: { phone: 12025550123, name: 'Asha' } }, `event:${f.ids.event}`) });
    f.state.automation_runs.push({ id: f.ids.run, flow_id: f.ids.flow, event_id: f.ids.event, kind: 'automatic', status: 'queued', definition });
    const { AutomationRunner } = load('src/app/services/automationRunner.service.ts', { './automationFlow.service': { AutomationFlowService: class {} }, './automationProvider.service': { AutomationProvider: class {} }, '../utils/automationFlow': utils });
    const runner = new AutomationRunner(f.flowService, new AutomationProvider(f.flowService));
    await runner.processNext();
    assert.equal(f.state.automation_runs[0].status, 'succeeded'); assert.deepEqual(f.calls, ['google-sheets', 'razorpay', 'whatsapp']);
    const payload = f.sent[0].data.template;
    assert.equal(payload.name, 'order_payment'); assert.equal(payload.components[0].parameters[2].text, 'https://rzp.io/i/test');
    assert.equal(payload.components[0].parameters[1].text, '500');
    const outputs = utils.decrypt(f.state.automation_runs[0].results_ciphertext, `run:${f.ids.run}`);
    assert.equal(outputs[2].output.wamid, 'wamid.test'); assert.equal(JSON.stringify(outputs).includes('private-secret'), false);
    await runner.processNext(); assert.equal(f.sent.length, 1);
    f.setError(new Error('provider-private-internals'));
    const failedId = crypto.randomUUID();
    f.state.automation_runs.push({ id: failedId, flow_id: f.ids.flow, event_id: f.ids.event, kind: 'automatic', status: 'queued', definition: [...definition, { ...definition[1], _id: crypto.randomUUID() }] });
    await runner.processNext();
    assert.equal(f.state.automation_runs[1].status, 'requires_review');
    assert.deepEqual(f.calls.slice(3), ['google-sheets', 'razorpay', 'whatsapp']);
    assert.equal(f.state.automation_runs[1].error.includes('provider-private-internals'), false);
  } finally { if (prior === undefined) delete process.env.AUTOMATION_ENCRYPTION_KEY; else process.env.AUTOMATION_ENCRYPTION_KEY = prior; }
});
