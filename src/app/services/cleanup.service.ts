import { Knex } from 'knex';
import db from '../../database';

class CleanupService {
  async cleanupData(range: string) {
    let cutoff = new Date();
    switch (range) {
      case 'day':
        cutoff.setHours(cutoff.getHours() - 24);
        break;
      case 'week':
        cutoff.setDate(cutoff.getDate() - 7);
        break;
      case 'month':
        cutoff.setDate(cutoff.getDate() - 30);
        break;
      case '3months':
        cutoff.setDate(cutoff.getDate() - 90);
        break;
      case '6months':
        cutoff.setDate(cutoff.getDate() - 180);
        break;
      case 'year':
        cutoff.setDate(cutoff.getDate() - 365);
        break;
      default:
        throw new Error('Invalid range parameter');
    }

    return await db.transaction(async (trx: Knex.Transaction) => {
      // 1. Delete dependent/child records first to prevent foreign key constraint violations
      const ticketConvDeleted = await trx('ticket_conversation').where('created_at', '<', cutoff).del();
      const supportTicketsDeleted = await trx('support_tickets').where('created_at', '<', cutoff).del();
      const messagesDeleted = await trx('messages').where('created_at', '<', cutoff).del();
      const webhookLogsDeleted = await trx('webhook_logs').where('created_at', '<', cutoff).del();
      const creditTransactionsDeleted = await trx('credit_transactions').where('created_at', '<', cutoff).del();
      
      const chatSessionDeleted = await trx('chat_session').where('created_at', '<', cutoff).del();
      const chatSessionsDeleted = await trx('chat_sessions').where('created_at', '<', cutoff).del();
      
      const activityLogsDeleted = await trx('activity_logs').where('created_at', '<', cutoff).del();
      const auditLogsDeleted = await trx('audit_logs').where('created_at', '<', cutoff).del();

      return {
        ticketConversationCount: ticketConvDeleted,
        supportTicketsCount: supportTicketsDeleted,
        messagesCount: messagesDeleted,
        webhookLogsCount: webhookLogsDeleted,
        creditTransactionsCount: creditTransactionsDeleted,
        chatSessionCount: chatSessionDeleted,
        chatSessionsCount: chatSessionsDeleted,
        activityLogsCount: activityLogsDeleted,
        auditLogsCount: auditLogsDeleted,
      };
    });
  }
}

export default new CleanupService();
