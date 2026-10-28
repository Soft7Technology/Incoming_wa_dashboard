require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildPlan, snapshotHash, applyReport } = require('../scripts/repair-contact-duplicates.cjs');
const { parseStoredContactPhone } = require('../src/app/utils/importPhone');
const contact = (id, extra = {}) => ({ id, company_id: 'company', user_id: 'owner', phone_number_id: null,
  phone_number: '+919876543210', country_code: '91', deleted_at: null, notes: `Notes ${id}`, ...extra });
test('repair keeps the first/oldest contact and archives only other copies without editing fields', () => {
  const groups = [{ contacts: [contact('old'), contact('new', { phone_number: '+91 98765 43210' })] }];
  const before = structuredClone(groups);
  const result = buildPlan(groups, parseStoredContactPhone);
  assert.deepEqual(result.archive.map(row => [row.keeper_id, row.contact_id]), [['old', 'new']]);
  assert.equal(result.review.length, 0); assert.deepEqual(groups, before);
});
test('unresolved numbers and conflicting international identities always require review', () => {
  const unresolved = buildPlan([{ contacts: [contact('a', { phone_number: '1234', country_code: null }), contact('b', { phone_number: '1234', country_code: null })] }], parseStoredContactPhone);
  assert.equal(unresolved.archive.length, 0); assert.equal(unresolved.review.length, 1);
  const split = buildPlan([{ contacts: [contact('in', { phone_number: '7579380000', country_code: '91' }), contact('us', { phone_number: '7579380000', country_code: '1' })] }], parseStoredContactPhone);
  assert.equal(split.archive.length, 0); assert.match(split.review[0].reason, /different international/);
});
test('identical unresolved customer data can be archived without inventing a country', () => {
  const row = contact('a', { phone_number: '+1234', country_code: null, notes: '', is_valid: false });
  const result = buildPlan([{ contacts: [row, { ...row, id: 'b' }] }], parseStoredContactPhone);
  assert.equal(result.review.length, 0); assert.equal(result.archive[0].keeper_id, 'a');
});
function fixture({ stale = false, fail = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'contact-repair-test-'));
  const reportPath = path.join(directory, 'report.json');
  const groups = [{ contacts: [contact('a'), contact('b')] }];
  fs.writeFileSync(reportPath, JSON.stringify({ version: 1, snapshot_hash: snapshotHash(groups), original_contacts: groups }));
  let state = structuredClone(groups), updates = [];
  const db = { transaction: async fn => {
    const draft = structuredClone(state);
    const trx = () => {
      const q = { whereIn(column, ids) { assert.equal(column, 'id'); updates = ids; return q; },
        whereNull(column) { assert.equal(column, 'deleted_at'); return q; },
        update(value) { assert.deepEqual(Object.keys(value), ['deleted_at']); draft[0].contacts[1].deleted_at = value.deleted_at; return q; },
        returning: async () => { if (fail) throw Error('Injected failure'); return [{ id: 'b' }]; } };
      return q;
    };
    trx.raw = async sql => {
      if (!sql.startsWith('SELECT')) return {};
      if (draft[0].contacts[1].deleted_at) return { rows: [] };
      return { rows: stale ? [{ contacts: [contact('a'), contact('changed')] }] : draft };
    };
    const result = await fn(trx); state = draft; return result;
  } };
  return { db, reportPath, state: () => state, updates: () => updates,
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }) };
}
test('apply backs up the operation, soft-archives a duplicate and preserves its original notes', async () => {
  const f = fixture();
  try {
    const result = await applyReport(f.db, parseStoredContactPhone, f.reportPath);
    assert.equal(result.archived, 1); assert.deepEqual(f.updates(), ['b']);
    assert.equal(f.state()[0].contacts[0].deleted_at, null);
    assert.equal(f.state()[0].contacts[1].notes, 'Notes b');
    assert.ok(f.state()[0].contacts[1].deleted_at);
    const receipt = JSON.parse(fs.readFileSync(result.receiptPath, 'utf8'));
    assert.deepEqual(receipt.archived_contact_ids, ['b']);
  } finally { f.cleanup(); }
});
test('stale snapshots and database failures cannot commit contact changes', async () => {
  for (const options of [{ stale: true }, { fail: true }]) {
    const f = fixture(options);
    try {
      await assert.rejects(applyReport(f.db, parseStoredContactPhone, f.reportPath));
      assert.equal(f.state()[0].contacts[1].deleted_at, null);
    } finally { f.cleanup(); }
  }
});
test('edited snapshots are rejected before opening a database transaction', async () => {
  const f = fixture();
  try {
    const report = JSON.parse(fs.readFileSync(f.reportPath));
    report.original_contacts[0].contacts[1].id = 'tampered';
    fs.writeFileSync(f.reportPath, JSON.stringify(report));
    await assert.rejects(applyReport(f.db, parseStoredContactPhone, f.reportPath), /modified repair snapshot/);
    assert.deepEqual(f.updates(), []);
  } finally { f.cleanup(); }
});

test('migration reports duplicate groups before attempting any DDL', async () => {
  const migration = require('../src/database/migrations/20260920000001_scope_contact_identity_to_owner');
  const queries = [];
  await assert.rejects(migration.up({ raw: async sql => {
    queries.push(sql); return { rows: [{ groups: 52 }] };
  } }), /52 duplicate contact groups.*repair-contact-duplicates/);
  assert.equal(queries.length, 1); assert.ok(queries.every(sql => !sql.includes('CREATE INDEX')));
});
