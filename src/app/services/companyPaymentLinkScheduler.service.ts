import * as cron from 'node-cron';
import db from '@surefy/database';
import payments from './companyPayment.service';

// The database holds the retry schedule. A crash releases work after its lease;
// multiple API instances claim different orders, and fulfillment locks the order.
class CompanyPaymentLinkScheduler {
  private task?: cron.ScheduledTask;
  private running?: Promise<void>;
  private stopping = false;
  private warned = false;

  start() {
    if (this.task) return;
    this.stopping = false;
    const run = () => {
      if (!this.running && !this.stopping) this.running = this.tick().finally(() => { this.running = undefined; });
    };
    this.task = cron.schedule('*/10 * * * * *', run);
    run();
  }

  async tick() {
    try {
      if (!await db.schema.hasColumn('company_payment_orders', 'next_check_at')) {
        if (!this.warned) console.warn('[Company payment links] Apply migration 20261104000002 to enable automatic verification.');
        this.warned = true;
        return;
      }
      this.warned = false;
      for (let i = 0; i < 10 && !this.stopping; i++) {
        const lease = new Date(Date.now() + 120000);
        const order = await db.transaction(async trx => {
          const row = await trx('company_payment_orders').where({ payment_flow: 'link' })
            .where('next_check_at', '<=', new Date()).orderBy('next_check_at')
            .forUpdate().skipLocked().first();
          if (row) await trx('company_payment_orders').where({ id: row.id }).update({ next_check_at: lease });
          return row;
        });
        if (!order) return;
        let complete = false;
        try {
          const result = await payments.verify({ companyId: order.company_id, userId: order.user_id, userRole: 'admin' }, order.id);
          complete = Boolean(result.fulfilled_at || (result.status === 'paid' && result.is_test) ||
            ['cancelled', 'expired'].includes(result.link_status));
        } catch {
          // Never log provider errors: they can contain credentials or customer data.
          console.warn('[Company payment links] Verification will retry for purchase', order.id);
        }
        // Only release our unchanged lease; do not overwrite a webhook wake-up or
        // a concurrent verifier's successful completion/schedule.
        await db('company_payment_orders').where({ id: order.id, next_check_at: lease }).update({
          last_checked_at: new Date(),
          next_check_at: complete ? null : new Date(Date.now() + 300000),
        });
      }
    } catch {
      console.error('[Company payment links] Reconciliation paused; check schema and database availability.');
    }
  }

  stop() {
    this.stopping = true;
    this.task?.stop(); this.task?.destroy(); this.task = undefined;
  }
}

export default new CompanyPaymentLinkScheduler();
