import * as cron from 'node-cron';
import db from '@surefy/database';
import service from './shopify.service';
import { retentionDays } from '../utils/shopify';

class ShopifyPrivacyScheduler {
  private task?: cron.ScheduledTask;
  private running = false;
  private warned = false;
  start() {
    if (this.task || !process.env.SHOPIFY_CLIENT_ID) return;
    retentionDays();
    this.task = cron.schedule('* * * * *', () => this.tick());
    void this.tick();
  }
  async tick() {
    if (this.running) return;
    this.running = true;
    try {
      if (!(await db.schema.hasTable('shopify_privacy_requests'))) {
        if (!this.warned)
          console.warn('[Shopify privacy] Migration 20261017000001 is required; maintenance has not run.');
        this.warned = true;
        return;
      }
      const counts = await service.maintainPrivacy();
      console.info('[Shopify privacy] Maintenance completed', counts);
      if (counts.overdue) console.warn('[Shopify privacy] Overdue requests require account-owner action.');
      if (counts.failed)
        console.error(
          '[Shopify privacy] Some stores could not be maintained. Check stored-data integrity and the encryption key.',
        );
      this.warned = false;
    } catch {
      // Do not print query bindings, database URLs or decrypted privacy payloads.
      console.error(
        '[Shopify privacy] Maintenance failed. Check database availability, migrations and the encryption key.',
      );
    } finally {
      this.running = false;
    }
  }
  stop() {
    this.task?.stop();
    this.task?.destroy();
    this.task = undefined;
  }
}
export default new ShopifyPrivacyScheduler();
