require('ts-node/register');
require('tsconfig-paths/register');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const phone = require('../../src/app/utils/importPhone');
const policy = require('../../src/app/utils/whatsappPreference');
class HttpError extends Error { constructor(data) { super(data.message); this.details = data.details; } }
function load(file, deps, extra = {}) {
  const exports = {};
  const code = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  vm.runInNewContext(code, { exports, require: id => deps[id] || {}, Date, Buffer, process: { env: {} },
    console: { log() {}, warn() {}, error() {}, info() {} }, ...extra });
  return exports;
}
function harness() {
  let state = Object.fromEntries(['contacts', 'messages', 'templates', 'phone_numbers', 'whatsapp_preferences',
    'whatsapp_preference_events', 'whatsapp_inbound_receipts', 'whatsapp_consent_requests'].map(t => [t, []]));
  let nextId = 0, tail = Promise.resolve();
  const sql = [];
  class Query {
    constructor(table) { this.table = table; this.predicates = []; this.orders = []; }
    where(key, op, value) {
      if (typeof key === 'object') { for (const [k, v] of Object.entries(key)) this.where(k, v); return this; }
      if (value === undefined) { value = op; op = '='; }
      this.predicates.push(row => op === '=' ? row[key] === value : op === '>' ? row[key] > value : row[key] < value);
      return this;
    }
    whereNull(key) { this.predicates.push(row => row[key] == null); return this; }
    whereRaw(text, bindings) { sql.push(text); this.predicates.push(row => String(row.from_phone).replace(/\D/g, '') === bindings[0]); return this; }
    forUpdate() { return this; }
    first() { this.single = true; return this; }
    distinctOn(key) { this.distinct = key; return this; }
    orderBy(key, dir = 'asc') { this.orders.push([key, dir]); return this; }
    limit(n) { this.count = n; return this; }
    clone() { const q = new Query(this.table); Object.assign(q, this, { predicates: [...this.predicates], orders: [...this.orders] }); return q; }
    insert(row) { this.insertRow = row; return this; }
    update(row) { this.updateRow = row; return this; }
    onConflict(keys) { this.conflict = Array.isArray(keys) ? keys : [keys]; return this; }
    ignore() { this.ignoreConflict = true; return this; }
    merge(data) { this.mergeRow = data; return this; }
    returning() { return this; }
    then(resolve, reject) { return Promise.resolve().then(() => this.run()).then(resolve, reject); }
    normalize(row) {
      const result = { ...row };
      for (const key of ['evidence', 'content', 'context']) if (typeof result[key] === 'string') {
        try { result[key] = JSON.parse(result[key]); } catch {}
      }
      return result;
    }
    run() {
      const rows = state[this.table];
      if (this.insertRow) {
        const conflict = this.conflict && rows.find(r => this.conflict.every(k => r[k] === this.insertRow[k]));
        if (conflict) {
          if (this.mergeRow) Object.assign(conflict, this.normalize(this.mergeRow));
          return this.ignoreConflict ? [] : [{ ...conflict }];
        }
        const row = this.normalize({ id: String(++nextId), created_at: new Date(), updated_at: new Date(),
          handled: false, reply_status: 'none', ...this.insertRow });
        rows.push(row); return [{ ...row }];
      }
      let found = rows.filter(r => this.predicates.every(p => p(r)));
      if (this.updateRow) { found.forEach(r => Object.assign(r, this.normalize(this.updateRow))); return found.map(r => ({ ...r })); }
      found.sort((a, b) => { for (const [key, dir] of this.orders) {
        const av = key === 'event_id' || key === 'id' ? Number(a[key]) : a[key];
        const bv = key === 'event_id' || key === 'id' ? Number(b[key]) : b[key];
        if (av < bv) return dir === 'asc' ? -1 : 1;
        if (av > bv) return dir === 'asc' ? 1 : -1;
      } return 0; });
      if (this.distinct) { const seen = new Set(); found = found.filter(r => { if (seen.has(r[this.distinct])) return false; seen.add(r[this.distinct]); return true; }); }
      if (this.count) found = found.slice(0, this.count);
      return this.single ? found[0] && { ...found[0] } : found.map(r => ({ ...r }));
    }
  }
  const db = table => new Query(table);
  db.raw = async (text, bindings) => { sql.push({ text, bindings }); };
  db.fn = { now: () => new Date() };
  db.transaction = fn => {
    const run = tail.then(async () => { const before = structuredClone(state); try { return await fn(db); } catch (e) { state = before; throw e; } });
    tail = run.catch(() => {}); return run;
  };
  const service = new (load('src/app/services/whatsappPreference.service.ts', {
    '@surefy/database': db, crypto: require('node:crypto'), '../utils/importPhone': phone,
    '../utils/whatsappPreference': policy, '@surefy/exceptions/HTTP400Error': HttpError, '@surefy/exceptions/HTTP404Error': HttpError,
  }).WhatsAppPreferenceService)(db);
  const contact = { id: 'contact-a', company_id: 'company-a', user_id: 'owner', phone_number_id: 'phone-a', phone_number: '81234567', country_code: '65' };
  state.contacts.push(contact);
  state.phone_numbers.push({ id: 'phone-a', company_id: 'company-a', user_id: 'owner', phone_number_id: 'meta-a', waba_id: 'waba' });
  state.templates.push({ company_id: 'company-a', waba_id: 'waba', name: 'sale', language: 'en', category: 'MARKETING' },
    { company_id: 'company-a', waba_id: 'waba', name: 'update', language: 'en', category: 'UTILITY' });
  const incoming = async (body, wamid = 'in-' + (++nextId), who = contact, extra = {}) => {
    const raw = { id: wamid, from: who.country_code + who.phone_number, type: 'text', text: { body }, ...extra };
    return service.persistIncoming(who, { user_id: who.user_id, company_id: who.company_id, phone_number_id: who.phone_number_id,
      wamid, direction: 'inbound', from_phone: raw.from, to_phone: 'business', type: raw.type, status: 'received', content: raw,
    }, raw);
  };
  const template = (name = 'sale', to = '6581234567') => ({ to, type: 'template', template: { name, language: { code: 'en' } } });
  return { service, db, state: () => state, contact, incoming, template, sql };
}
module.exports = { harness, load, phone, policy, HttpError };
