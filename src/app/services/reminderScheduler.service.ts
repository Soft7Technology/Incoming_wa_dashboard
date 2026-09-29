import * as cron from 'node-cron';
import ReminderModel from '../models/reminder.model';
import { ReminderRecord } from '../interfaces/reminder.interface';
import ReminderService from './reminder.service';
import MessageService from './message.service';
import ContactOptOutService from './contactOptOut.service';
import { nextSend } from '../utils/reminder';

class ReminderScheduler {
  private task?: cron.ScheduledTask;
  private running?: Promise<void>;
  private stopping = false;

  start() {
    if (this.task) return;
    this.stopping = false;
    this.task = cron.schedule('*/10 * * * * *', () => {
      if (!this.running)
        this.running = this.tick()
          .catch((error) => console.error('[Reminders]', error))
          .finally(() => {
            this.running = undefined;
          });
    });
  }

  async stop() {
    this.stopping = true;
    this.task?.stop();
    this.task?.destroy();
    this.task = undefined;
    await this.running;
  }

  async tick() {
    // Never retry an uncertain send after a process crash: Meta may have accepted it.
    await ReminderModel.recoverStaleClaims();
    for (let index = 0; index < 25 && !this.stopping; index++) {
      const claimed = await ReminderModel.claimNextDue();
      if (!claimed) return;
      await this.send(claimed.row, claimed.attemptId);
    }
  }

  private async send(row: ReminderRecord, attemptId: string) {
    let failure: string | null = null;
    let wamid: string | null = null;
    // Keep long network calls from being treated as a crashed sender by another process.
    const heartbeat = setInterval(() => {
      void ReminderModel.refreshClaim(row.id).catch((error) => console.error('[Reminders] heartbeat failed', error));
    }, 60000);
    try {
      const scope = { companyId: row.company_id, ownerId: row.user_id, actorId: row.user_id };
      const prepared = await ReminderService.prepare(scope, row, false);
      if (await ContactOptOutService.isBlocked(prepared.phone, prepared.recipient.whatsapp_number))
        throw new Error('Contact opted out');
      await ReminderModel.saveAttemptSnapshot(attemptId, {
        ...row,
        recipient: prepared.recipient,
        sending_number: prepared.sending_number,
        template: prepared.template,
        preview: prepared.preview,
      });
      const result = await MessageService.sendMessage(
        {
          user_id: row.user_id,
          company_id: row.company_id,
          messageUUID: attemptId,
          campaign_id: null,
          phone_number_id: row.phone_number_id,
          to: prepared.recipient.phone_number,
          country_code: prepared.recipient.country_code,
          profile_name: prepared.recipient.name || '',
          type: 'template',
          template: prepared.template,
        },
        { phoneNumber: prepared.phone, templateRecord: prepared.templateRecord },
      );
      wamid = result.wamid;
    } catch (error: any) {
      failure = error.response?.data?.error?.message || error.message || 'Reminder send failed';
    } finally {
      clearInterval(heartbeat);
    }
    // Commit completion separately from the network call. A DB failure leaves the occurrence
    // claimed for manual reconciliation, rather than sending it a second time.
    const next = row.frequency === 'yearly' ? nextSend(row.local_datetime, row.timezone, 'yearly', new Date()) : null;
    await ReminderModel.completeAttempt(row, attemptId, wamid, failure, next);
  }
}
export default new ReminderScheduler();
