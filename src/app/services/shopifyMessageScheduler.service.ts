import * as cron from 'node-cron';
import db from '@surefy/database';
import service from './shopifyMessaging.service';

class ShopifyMessageScheduler {
  private task?: cron.ScheduledTask;
  private running?: Promise<void>;
  private stopping = false;
  private warned = false;
  start() {
    if (this.task) return;
    this.stopping = false;
    const run = () => {
      if (!this.running && !this.stopping)
        this.running = this.tick().finally(() => {
          this.running = undefined;
        });
    };
    this.task = cron.schedule('*/5 * * * * *', run);
    run();
  }
  private async tick() {
    try {
      if (!(await db.schema.hasTable('shopify_whatsapp_jobs'))) {
        if (!this.warned) console.warn('[Shopify WhatsApp] Apply migration 20261017000002 before enabling messaging.');
        this.warned = true;
        return;
      }
      this.warned = false;
      await service.recoverStale();
      for (let i = 0; i < 25 && !this.stopping; i++) {
        const job = await service.claim();
        if (!job) return;
        await service.process(job);
      }
    } catch {
      console.error(
        '[Shopify WhatsApp] Processing failed. Check database/schema availability. Uncertain sends are not retried automatically.',
      );
    }
  }
  async stop() {
    this.stopping = true;
    this.task?.stop();
    this.task?.destroy();
    this.task = undefined;
    await this.running;
  }
}
export default new ShopifyMessageScheduler();
