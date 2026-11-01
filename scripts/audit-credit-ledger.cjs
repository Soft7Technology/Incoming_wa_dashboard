// Read-only by default. --repair-manual changes only proven mislabeled grants.
require('dotenv').config({ quiet: true });
require('ts-node/register');
const fs = require('node:fs');
const path = require('node:path');
const knex = require('knex');
const { manualTopups, up } = require('../src/database/migrations/20261028000001_correct_manual_credit_types');
const args = process.argv.slice(2);
if (args.some(arg => arg !== '--repair-manual')) throw Error('Only --repair-manual is supported');
const repair = args.includes('--repair-manual');
const db = knex({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 1 },
  acquireConnectionTimeout: 15000 });
const fees = ['subscription_commission', 'subscription_extension', 'plan_addon'];
const cents = value => {
  const match = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw Error('Invalid ledger amount');
  return (match[1] ? -1n : 1n) * (BigInt(match[2]) * 100n + BigInt((match[3] || '').padEnd(2, '0')));
};
const money = value => {
  const sign = value < 0n ? '-' : '';
  const abs = value < 0n ? -value : value;
  return `${sign}${abs / 100n}.${String(abs % 100n).padStart(2, '0')}`;
};
const sum = rows => rows.reduce((total, row) => total + cents(row.amount), 0n);
function findings(rows, accounts, companies) {
  const superadmins = new Set(accounts.filter(user => user.role === 'superadmin').map(user => user.id));
  const platform = rows.filter(row => superadmins.has(row.user_id));
  const target = accounts.find(user => user.email.toLowerCase() === 'soft7admin@gmail.com');
  const targetCompany = companies.find(company => company.id === target?.company_id);
  const company = rows.filter(row => row.company_id === target?.company_id && !superadmins.has(row.user_id));
  const signed = row => (row.type === 'debit' ? -1n : 1n) * (cents(row.amount) < 0n ? -cents(row.amount) : cents(row.amount));
  const invalid = rows.filter(row => cents(row.balance_after) - cents(row.balance_before) !== signed(row));
  const comparison = fees.map(type => {
    const received = sum(platform.filter(row => row.type === 'credit' && row.reference_type === type));
    const charged = rows.filter(row => !superadmins.has(row.user_id) && row.type === 'debit' && row.reference_type === type)
      .reduce((total, row) => total - signed(row), 0n);
    return { reference_type: type, platform_credits: money(received), company_debits: money(charged), difference: money(received - charged) };
  });
  return {
    platform_fees: comparison,
    platform_fee_total: money(sum(platform.filter(row => row.type === 'credit' && fees.includes(row.reference_type)))),
    platform_wallets: accounts.filter(user => user.role === 'superadmin').map(user => {
      const ledger = platform.filter(row => row.user_id === user.id);
      return { user_id: user.id, current_balance: user.credit_balance,
        first_recorded_opening_balance: ledger[0]?.balance_before ?? null,
        recorded_credits: money(sum(ledger.filter(row => row.type === 'credit'))),
        legacy_subscription_receipts: money(sum(ledger.filter(row => row.reference_type === 'subscription'))),
        latest_recorded_balance: ledger.at(-1)?.balance_after ?? null };
    }),
    target_company: targetCompany ? { id: targetCompany.id, email: target.email, current_balance: targetCompany.credit_balance,
      topups: money(sum(company.filter(row => row.type === 'credit' && ['manual', 'superadmin_manual'].includes(row.reference_type)))),
      recorded_net_movement: money(company.reduce((total, row) => total + signed(row), 0n)),
      latest_recorded_balance: company.at(-1)?.balance_after ?? null,
      invalid_snapshot_ids: invalid.filter(row => row.company_id === target.company_id && !superadmins.has(row.user_id)).map(row => row.id) } : null,
    invalid_snapshot_count: invalid.length,
    invalid_snapshots: invalid.map(row => ({ id: row.id, company_id: row.company_id, reference_type: row.reference_type,
      amount: row.amount, balance_before: row.balance_before, balance_after: row.balance_after })),
    note: 'Opening balances and historical gaps are not assumed to be revenue. Invalid historical snapshots require source evidence; no wallet balances are rewritten.',
  };
}

(async () => {
  try {
    const result = await db.transaction(async trx => {
      await trx.raw('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ' + (repair ? '' : ', READ ONLY'));
      await trx.raw("SET LOCAL statement_timeout = '20s'");
      const candidates = await (repair ? manualTopups(trx).forUpdate() : manualTopups(trx));
      const rows = await trx('credit_transactions').orderBy('created_at').orderBy('id');
      const accounts = await trx('users').where('role', 'superadmin').orWhereRaw('lower(email) = ?', ['soft7admin@gmail.com'])
        .select('id', 'company_id', 'email', 'role', 'credit_balance');
      const companies = await trx('companies').select('id', 'name', 'credit_balance');
      const before = findings(rows, accounts, companies);
      const directory = path.resolve(__dirname, '../backups/credit-ledger');
      fs.mkdirSync(directory, { recursive: true });
      const backup = path.join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}${repair ? '-repair' : '-audit'}.json`);
      fs.writeFileSync(backup, JSON.stringify({ captured_at: new Date().toISOString(), mode: repair ? 'repair' : 'read_only',
        candidates, accounts, companies, transactions: rows, findings: before }, null, 2), { flag: 'wx' });
      if (repair) await up(trx);
      const after = repair ? findings(await trx('credit_transactions').orderBy('created_at').orderBy('id'), accounts, companies) : before;
      const report = backup.replace(/\.json$/, '-report.json');
      fs.writeFileSync(report, JSON.stringify(after, null, 2), { flag: 'wx' });
      return { mode: repair ? 'repair' : 'read_only', manual_topups: candidates.length,
        backup, report, platform_fee_total: after.platform_fee_total,
        platform_fees: after.platform_fees, platform_wallets: after.platform_wallets,
        target_company: after.target_company, invalid_snapshot_count: after.invalid_snapshot_count };
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(JSON.stringify({ code: error.code, message: error.message }));
    process.exitCode = 1;
  } finally { await db.destroy(); }
})();
