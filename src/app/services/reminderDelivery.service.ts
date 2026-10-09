import ReminderModel from '../models/reminder.model';
import { MessageStatusUpdate } from '../interfaces/message.interface';

/** Store callback events even when Meta responds before the send result is saved. */
export async function recordReminderDelivery(update: MessageStatusUpdate): Promise<void> {
  await ReminderModel.recordDelivery(update);
}
