const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { loadSource } = require('./helpers/background-database.cjs');
class HttpError extends Error { constructor({ message }) { super(message); } }
const errors = Object.fromEntries(['HTTP400Error', 'HTTP401Error', 'HTTP404Error'].map(name => [`@surefy/exceptions/${name}`, HttpError]));
const validation = loadSource('src/app/utils/superAdminValidation.ts', errors);
const ledger = loadSource('src/app/utils/creditLedger.ts');

test('legacy credit endpoint rejects invalid amounts and non-superadmin callers', async () => {
  const service = loadSource('src/app/services/credit.service.ts', {
    ...errors, '@surefy/database': { transaction() { throw Error('unexpected write'); } },
    '../utils/superAdminValidation': validation,
    '../utils/creditLedger': ledger,
  }).default;
  for (const amount of [NaN, Infinity, 0, -1, '10junk', '1.001'])
    await assert.rejects(service.addCredit('actor', { company_id: 'c', amount, user_role: 'superadmin' }), /amount/);
  for (const user_role of [undefined, 'admin', 'company', 'user'])
    await assert.rejects(service.addCredit('actor', { company_id: 'c', amount: 10, user_role }), /superadmin/);
});

test('PostgreSQL grants, separate wallet histories, fee revenue and reversible historical repair',
  { skip: process.env.CREDIT_LEDGER_DATABASE_TEST !== 'true' }, async () => {
    require('dotenv').config({ quiet: true });
    const db = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL,
      pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });
    const schema = 'credit_ledger_test_' + randomUUID().replaceAll('-', '');
    const rollback = Error('ROLLBACK_CREDIT_LEDGER_TEST');
    try {
      await assert.rejects(db.transaction(async trx => {
        await trx.schema.createSchema(schema);
        await trx.raw('SET LOCAL search_path TO ??', [schema]);
        await trx.schema.createTable('companies', t => {
          t.uuid('id').primary(); t.string('name'); t.string('status'); t.decimal('credit_balance', 15, 2);
          t.timestamp('updated_at'); t.timestamp('created_at').defaultTo(trx.fn.now()); t.timestamp('deleted_at');
        });
        await trx.schema.createTable('users', t => {
          t.uuid('id').primary(); t.uuid('company_id'); t.string('role'); t.string('credit_balance');
          t.string('email'); t.string('name');
          t.timestamp('deleted_at');
        });
        await trx.schema.createTable('credit_transactions', t => {
          t.uuid('id').primary().defaultTo(trx.raw('gen_random_uuid()')); t.uuid('company_id'); t.uuid('user_id');
          t.string('company_name'); t.string('type'); t.decimal('amount', 15, 2);
          t.decimal('balance_before', 15, 2); t.decimal('balance_after', 15, 2);
          t.string('reference_type'); t.uuid('reference_id'); t.string('description'); t.string('created_by');
          t.uuid('balance_transafered_by'); t.jsonb('meta_data'); t.timestamp('created_at').defaultTo(trx.fn.now());
        });
        await trx.schema.createTable('company_payment_orders', t => {
          t.uuid('company_id'); t.uuid('user_id'); t.uuid('user_plan_id'); t.string('status');
          t.boolean('is_test'); t.string('currency'); t.integer('amount_paise'); t.timestamp('paid_at');
        });
        await trx.schema.createTable('user_plans', t => {
          t.uuid('id').primary(); t.uuid('company_id'); t.uuid('user_id'); t.string('plan_name');
          t.decimal('price', 15, 2); t.boolean('active'); t.string('status'); t.string('billing_cycle');
          t.timestamp('start_date'); t.timestamp('end_date'); t.integer('duration_days');
          t.timestamp('created_at').defaultTo(trx.fn.now());
        });
        const companyId = randomUUID(), platformId = randomUUID(), customerId = randomUUID();
        await trx('companies').insert({ id: companyId, name: 'Shared company', credit_balance: '100.00' });
        await trx('users').insert([
          { id: platformId, company_id: companyId, role: 'superadmin', credit_balance: '500.00' },
          { id: customerId, company_id: companyId, role: 'user' },
        ]);
        class BaseModel {
          constructor(tableName) { this.tableName = tableName; this.db = trx; }
          query() { return trx(this.tableName); }
        }
        const model = loadSource('src/app/models/creditTransaction.model.ts', {
          '@surefy/models/base.model': { BaseModel }, '../utils/creditLedger': ledger,
        }).default;
        const service = loadSource('src/app/services/credit.service.ts', {
          ...errors, '@surefy/database': trx, '../utils/superAdminValidation': validation,
          '../utils/creditLedger': ledger,
          '@surefy/console/models/creditTransaction.model': model,
          '@surefy/console/models/company.model': { findById: id => trx('companies').where({ id }).first() },
        }).default;
        const grant = await service.addCredit(platformId, { company_id: companyId, amount: '25.50', user_role: 'superadmin' });
        assert.equal(grant.transaction.type, 'credit');
        assert.equal(grant.transaction.balance_before, '100.00');
        assert.equal(grant.company.credit_balance, '125.50');
        assert.equal((await trx('users').where({ id: platformId }).first()).credit_balance, '500.00');
        assert.equal((await trx('credit_transactions')).length, 1);
        // Database failure must roll back the wallet update too.
        await trx.raw("ALTER TABLE credit_transactions ADD CONSTRAINT reject_test_grant CHECK (amount <> 2.00)");
        await assert.rejects(service.addCredit(platformId, { company_id: companyId, amount: '2.00', user_role: 'superadmin' }));
        assert.equal((await trx('companies').where({ id: companyId }).first()).credit_balance, '125.50');
        const entry = { company_id: companyId, balance_before: '100.00', balance_after: '110.00', amount: '10.00', type: 'credit' };
        for (const reference_type of ledger.PLATFORM_FEE_TYPES) {
          await trx('credit_transactions').insert([
            { ...entry, user_id: platformId, reference_type },
            { ...entry, user_id: customerId, type: 'debit', amount: '-10.00', balance_before: '110.00', balance_after: '100.00', reference_type },
          ]);
        }
        await trx('credit_transactions').insert([
          { ...entry, user_id: platformId, reference_type: 'subscription' },
          { ...entry, user_id: null, reference_type: null },
          { ...entry, user_id: null, type: 'refund', reference_type: 'transaction' },
        ]);
        const companyHistory = await model.getCompanyTransaction(companyId, { limit: 100 });
        assert.equal(companyHistory.pagination.total, 6);
        assert.ok(companyHistory.data.every(row => row.user_id !== platformId));
        const platformHistory = await model.getCompanyTransaction(companyId, {}, platformId);
        assert.equal(platformHistory.pagination.total, 3);
        assert.ok(platformHistory.data.every(row => row.user_id === platformId && row.type === 'credit'));
        assert.equal((await model.transactionHistory(platformId)).length, 3);
        assert.equal(await model.getTotalCredits(companyId), 45.5);
        assert.equal(await model.getTotalDebits(companyId), 30);
        assert.equal(await model.getBalance(companyId), 15.5);
        assert.equal((await service.getBalance(companyId, platformId)).balance, '500.00');
        assert.equal((await service.getBalance(companyId, platformId)).platform_fee_total, 30);
        const reports = loadSource('src/app/models/superAdminOperations.model.ts', {
          ...errors, '@surefy/models/base.model': { BaseModel }, '../utils/creditLedger': ledger,
        }).default;
        const revenue = await reports.revenue({ page: 1, limit: 10 });
        assert.equal(Number(revenue.platform_commission.amount), 30);
        const byCompany = await reports.revenue({ page: 1, limit: 10 }, true);
        assert.equal(Number(byCompany.items[0].platform_commission.amount), 30);
        const companies = loadSource('src/app/models/superAdmin.model.ts', {
          ...errors, '@surefy/models/base.model': { BaseModel }, '../utils/creditLedger': ledger,
        }).default;
        const companyCredits = await companies.collection('credits', { company_id: companyId, page: 1, limit: 100 });
        assert.equal(companyCredits.pagination.total, 6);
        const plans = loadSource('src/app/models/userPlans.model.ts', {
          ...errors, '@surefy/models/base.model': { BaseModel }, '../utils/creditLedger': ledger,
        }).default;
        assert.equal((await plans.findCompanyActiveSubscriptions(platformId, companyId, 'superadmin')).stats.total_revenue, 30);
        await trx('user_plans').insert({ id: randomUUID(), company_id: companyId, user_id: customerId,
          price: '9999.00', active: true });
        const superStats = (await plans.findCompanyActiveSubscriptions(platformId, companyId, 'superadmin')).stats;
        assert.equal(superStats.total_revenue, 30);
        assert.equal(superStats.revenue_basis, 'recorded_platform_fees');
        assert.equal((await plans.findCompanyActiveSubscriptions(customerId, companyId, 'admin')).stats.total_revenue, 9999);
        // Repair only known manual grants, keeping metadata, balances and unrelated rows.
        const repair = loadSource('src/database/migrations/20261028000001_correct_manual_credit_types.ts');
        await trx('credit_transactions').insert([
          { ...entry, type: 'debit', reference_type: 'manual', created_by: platformId, meta_data: { keep: true } },
          { ...entry, type: 'debit', reference_type: 'manual', created_by: customerId },
          { ...entry, type: 'debit', reference_type: 'manual', created_by: platformId, balance_after: '90.00' },
        ]);
        const balanceBefore = (await trx('companies').where({ id: companyId }).first()).credit_balance;
        assert.equal((await repair.manualTopups(trx)).length, 1);
        await repair.up(trx);
        await repair.up(trx);
        assert.equal((await repair.manualTopups(trx)).length, 0);
        const repaired = await trx('credit_transactions').where({ type: 'credit', reference_type: 'manual', created_by: platformId }).whereNotNull('meta_data').first();
        assert.equal(repaired.meta_data.keep, true);
        assert.equal(repaired.meta_data[repair.REPAIR_KEY].previous_type, 'debit');
        assert.equal((await trx('companies').where({ id: companyId }).first()).credit_balance, balanceBefore);
        await repair.down(trx);
        assert.equal((await repair.manualTopups(trx)).length, 1);
        throw rollback;
      }), error => error === rollback);
    } finally { await db.destroy(); }
  });
