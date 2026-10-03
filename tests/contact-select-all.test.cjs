const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');

function harness(sender = { id: 'internal', user_id: 'owner', company_id: 'company' }) {
  const calls = [];
  const rows = Array.from({ length: 55 }, (_, id) => ({ id: String(id) }));
  const query = {
    where(...args) { calls.push(args); return this; },
    clone() { return this; }, toSQL() { return { toNative: () => ({}) }; },
    count() { return this; }, first: async () => ({ count: rows.length }),
    orderBy() { return this; },
    limit() { throw new Error('Select all must not limit'); },
    offset() { throw new Error('Select all must not offset'); },
    then(resolve, reject) { return Promise.resolve(rows).then(resolve, reject); },
  };
  class HttpError extends Error { constructor({ message }) { super(message); } }
  const deps = {
    '../models/phoneNumber.model': { findByPhoneNumberId: async () => sender },
    '../models/contact.model': { findWithFilters: (owner, filters, phone) => {
      calls.push([owner, filters.onlyAssignedToUserId, phone]); return query;
    } },
    '../models/contactTagRelation.model': { getContactsWithTags: async () => [] },
    '../models/message.model': { findLatestForContacts: async () => [] },
    '@surefy/exceptions/HTTP400Error': HttpError,
    '@surefy/exceptions/HTTP404Error': HttpError,
  };
  const exports = {};
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/app/services/contact.service.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText, { exports, require: id => deps[id] || {}, console: { log() {} } });
  return { service: exports.default, calls };
}

test('select all returns more than one page, resolves sender and preserves scope and false preference', async () => {
  const { service, calls } = harness();
  const result = await service.getContacts('owner', {
    unpaginated: true, opt_in_status: 'true', is_opted_out: 'false', onlyAssignedToUserId: 'member',
  }, 'meta-id', 'company');
  assert.equal(result.contacts.length, 55);
  assert.equal(result.total, 55);
  assert.equal(result.pagination, undefined);
  assert.deepEqual(calls[0], ['owner', 'member', 'internal']);
  assert.ok(calls.some(call => call[0] === 'contacts.company_id' && call[1] === 'company'));
  assert.ok(calls.some(call => call[0] === 'contacts.is_opted_out' && call[1] === false));
});

test('rejects foreign senders, malformed preferences and conflicting preferences', async () => {
  await assert.rejects(harness({ id: 'foreign', user_id: 'other', company_id: 'company' }).service
    .getContacts('owner', { unpaginated: true }, 'meta-id', 'company'), /not found/);
  for (const filters of [{ is_opted_out: 'no' }, { opt_in_status: ['true'] },
    { opt_in_status: 'true', is_opted_out: 'true' }]) {
    await assert.rejects(harness().service.getContacts('owner', filters, 'meta-id', 'company'), /true or false|conflict/);
  }
});
