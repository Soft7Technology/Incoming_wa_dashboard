import * as cron from 'node-cron';
import db from '@surefy/database';
import repository from '../models/wabaOnboarding.model';
import service from './wabaOnboarding.service';

/** PostgreSQL-backed jobs: cron only wakes the consumer; leases/backoff/progress live in the database. */
class WabaOnboardingScheduler {
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
    this.task = cron.schedule('*/5 * * * * *', run);
    run();
  }
  async tick() {
    try {
      if (!await db.schema.hasTable('waba_onboardings')) {
        if (!this.warned) console.warn('[WhatsApp onboarding] Apply migration 20261019000006 before starting setup jobs.');
        this.warned = true; return;
      }
      this.warned = false;
      for (let i = 0; i < 5 && !this.stopping; i++) {
        const job = await repository.claim();
        if (!job) return;
        await service.process(job);
      }
    } catch {
      // Do not log HTTP errors, request objects, query bindings or saved credentials.
      console.error('[WhatsApp onboarding] Job processing paused. Check database/schema availability; persisted jobs resume on the next worker cycle.');
    }
  }
  async stop() {
    this.stopping = true; this.task?.stop(); this.task?.destroy(); this.task = undefined; await this.running;
  }
}
export default new WabaOnboardingScheduler();
