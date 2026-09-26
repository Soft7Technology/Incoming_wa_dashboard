require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const knex = require('knex');
const phone = require('../src/app/utils/importPhone');
const { auditContactPhones } = require('../src/app/utils/contactPhoneAudit');
const { uniqueCampaignRecipients } = require('../src/app/utils/campaignRecipients');
function load(file, deps) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => deps[id] || {}, process: { env: {} }, console: { log() {}, error() {} } });
  return exports;
}
class HttpError extends Error { constructor(data) { super(data.message); } }
const examples = [
  ['919372597458', '91', '9372597458'], ['6581234567', '65', '81234567'],
  ['447391166058', '44', '7391166058'], ['39066982', '39', '066982'],
];
test('webhook identifiers split and round-trip through stored fields into Meta recipients', () => {
  for (const [sender, code, national] of examples) {
    const result = phone.parseWhatsAppPhone(sender);
    assert.deepEqual(result, { country_code: code, phone_number: national });
    assert.equal(phone.buildRecipient(result.phone_number, result.country_code), sender);
  }
});
test('missing country context never guesses India or another country', () => {
  for (const value of ['9372597458', '81234567', '6581234567', '9522007000']) {
    assert.throws(() => phone.parseImportedPhone(value), /Country code is required/);
    assert.throws(() => phone.buildRecipient(value), /Country code is required/);
  }
  assert.throws(() => phone.buildRecipient('1234', '65'));
});
test('same national number under India and US remains two recipients', () => {
  const contacts = [{ id: 'in', country_code: '91', phone_number: '7579380000' },
    { id: 'us', country_code: '1', phone_number: '7579380000' }];
  assert.equal(uniqueCampaignRecipients([...contacts, { ...contacts[0], id: 'duplicate' }]).length, 2);
  assert.equal(phone.buildRecipient(contacts[0].phone_number, contacts[0].country_code), '917579380000');
  assert.equal(phone.buildRecipient(contacts[1].phone_number, contacts[1].country_code), '17579380000');
});
test('incoming lookup includes country, national number, company, owner and business phone', async () => {
  const db = knex({ client: 'pg' }), queries = [];
  db.client.runner = builder => ({ run: async () => { queries.push(builder.toSQL()); return undefined; } });
  class BaseModel { query() { return db('contacts'); } }
  const model = load('src/app/models/contact.model.ts', {
    '@surefy/models/base.model': { BaseModel }, '../utils/importPhone': phone,
    '@surefy/exceptions/HTTP400Error': HttpError,
  }).default;
  const created = [];
  model.create = async data => { created.push(data); return data; };
  try {
    for (const sender of ['917579380000', '17579380000', '6581234567']) {
      await model.findOrCreateIncoming({ user_id: 'owner', company_id: 'company', phone_number_id: 'business', phone_number: sender });
    }
    assert.deepEqual(created.map(c => [c.country_code, c.phone_number]), [['91', '7579380000'], ['1', '7579380000'], ['65', '81234567']]);
    for (let i = 0; i < queries.length; i++) {
      const query = queries[i];
      for (const column of ['country_code', 'phone_number', 'user_id', 'company_id', 'phone_number_id']) {
        assert.ok(query.sql.includes(`"${column}" = ?`));
      }
      for (const value of ['owner', 'company', 'business', created[i].country_code, created[i].phone_number]) assert.ok(query.bindings.includes(value));
      assert.ok(!query.sql.includes('LIKE'));
    }
  } finally { await db.destroy(); }
});
test('preflight reports ambiguous records and only same-scope same-country duplicates', () => {
  const base = { company_id: 'company', user_id: 'owner', phone_number_id: 'business', phone_number: '7579380000', country_code: '91' };
  const rows = [{ ...base, id: 'in' }, { ...base, id: 'us', country_code: '1' },
    { ...base, id: 'duplicate', phone_number: '+917579380000' },
    { ...base, id: 'other-business', phone_number_id: 'another' },
    { ...base, id: 'unknown', country_code: null }];
  const result = auditContactPhones(rows);
  assert.equal(result.issues.length, 2);
  assert.match(result.issues[0].reason, /Duplicate.*in/);
  assert.equal(result.issues[1].id, 'unknown');
  assert.equal(rows[4].country_code, null);
});
test('Meta receives international digits and invalid recipients fail before HTTP', async () => {
  const requests = [];
  const service = load('src/app/services/meta.service.ts', {
    '../utils/importPhone': phone,
    axios: { create: () => ({ post: async (url, payload) => { requests.push(payload); return { data: { ok: true } }; } }) },
    '@surefy/exceptions/HTTP400Error': HttpError,
  }).default;
  for (const [sender] of examples) await service.sendMessage('business', { to: '+' + sender, type: 'text' });
  assert.deepEqual(requests.map(r => r.to), examples.map(e => e[0]));
  await assert.rejects(service.sendMessage('business', { to: '1234' }), /Invalid international recipient/);
  assert.equal(requests.length, examples.length);
});
test('migration stops before data or index changes when clarification is required', async () => {
  const { up } = require('../src/database/migrations/20260926000001_normalize_contact_phone_identity');
  const statements = [];
  const db = () => ({ select: async () => [{ id: 'unknown', phone_number: '81234567' }] });
  db.raw = async sql => { statements.push(sql); };
  db.schema = { hasColumn: async () => true };
  await assert.rejects(up(db), /requires clarification/);
  assert.equal(statements.length, 1);
  assert.match(statements[0], /LOCK TABLE/);
});


function messageHarness(contacts = []) {
  const sent = [], saved = [], incoming = [];
  const business = { id: 'business', phone_number_id: 'meta', user_id: 'owner', company_id: 'company' };
  const service = load('src/app/services/message.service.ts', {
    '../utils/importPhone': phone,
    '../utils/campaignPhone': require('../src/app/utils/campaignPhone'),
    '@surefy/console/models/phoneNumber.model': { findByPhoneNumberId: async () => business },
    '../models/contact.model': {
      findCampaignPhoneCandidates: async (owner, company) => { assert.equal(owner, 'owner'); assert.equal(company, 'company'); return contacts; },
      findOrCreateIncoming: async data => { incoming.push(data); return data; },
    },
    '@surefy/console/models/message.model': { create: async data => { saved.push(data); return { ...data, id: 'message' }; }, update: async () => {} },
    '@surefy/console/services/meta.service': { sendMessage: async (id, data) => { sent.push(data); return { messages: [{ id: 'wamid' }] }; } },
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
    './socket-bridge': { publishSocketEvent: async () => {} },
  }).default;
  return { service, sent, saved, incoming };
}
const sendData = { user_id: 'owner', company_id: 'company', phone_number_id: 'business', type: 'text', text: { body: 'Hello' } };
test('outbound service builds recipients from saved country fields without modifying the contact', async () => {
  const contact = { id: 'sg', phone_number_id: 'business', phone_number: '81234567', country_code: '65' };
  const env = messageHarness([contact]);
  await env.service.sendMessage({ ...sendData, to: '81234567' });
  assert.equal(env.sent[0].to, '6581234567');
  assert.equal(env.saved[0].to_phone, '6581234567');
  assert.equal(contact.phone_number, '81234567');
  await env.service.sendMessage({ ...sendData, to: '9372597458', country_code: '91' });
  assert.equal(env.sent[1].to, '919372597458');
});
test('outbound ambiguous or unscoped national recipients fail before message creation and Meta', async () => {
  const contacts = ['91', '1'].map(country_code => ({ id: country_code, phone_number_id: 'business', country_code, phone_number: '7579380000' }));
  const env = messageHarness(contacts);
  await assert.rejects(env.service.sendMessage({ ...sendData, to: '7579380000' }), /Multiple contacts/);
  assert.equal(env.sent.length, 0);
  assert.equal(env.saved.length, 0);
  await env.service.sendMessage({ ...sendData, to: '+17579380000' });
  assert.equal(env.sent[0].to, '17579380000');
  const other = messageHarness([{ id: 'sg', phone_number_id: 'other-business', phone_number: '81234567', country_code: '65' }]);
  await assert.rejects(other.service.sendMessage({ ...sendData, to: '81234567' }), /Country code is required/);
  assert.equal(other.saved.length, 0);
});
test('incoming service persists split sender identity within the receiving company and phone scope', async () => {
  const env = messageHarness();
  await env.service.saveIncomingMessage({ phone_number_id: 'meta', from: '6581234567', type: 'text', content: { text: { body: 'Hello' } } });
  const contact = env.incoming[0];
  assert.equal(contact.country_code, '65');
  assert.equal(contact.phone_number, '81234567');
  assert.equal(contact.phone_number_id, 'business');
  assert.equal(contact.company_id, 'company');
  assert.equal(contact.user_id, 'owner');
  assert.equal(env.saved[0].from_phone, '6581234567');
});
