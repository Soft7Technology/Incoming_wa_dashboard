import MessageService from './message.service';
import CampaignService from './campaign.service';
import ContactModel from '../models/contact.model';

class WebhookHandlerService {
  /**
   * Handle Meta webhook events
   */
  async handleMetaWebhook(payload: any) {
    const entry = payload.entry?.[0];
    if (!entry) return;

    const changes = entry.changes?.[0];
    if (!changes) return;

    const value = changes.value;
    if (!value) return;

    // Handle message statuses
    if (value.statuses) {
      for (const status of value.statuses) {
        await this.handleMessageStatus(status);
      }
    }

    // Handle incoming messages
    if (value.messages) {
      for (const message of value.messages) {
        await this.handleIncomingMessage(message, value.metadata);
      }
    }

    // Handle errors
    if (value.errors) {
      for (const error of value.errors) {
        await this.handleError(error);
      }
    }
  }

  /**
   * Handle message status updates
   */
  private async handleMessageStatus(status: any) {
    const { id: wamid, status: messageStatus, timestamp, errors } = status;

    // Update message in database
    await MessageService.handleStatusUpdate({
      wamid,
      status: messageStatus,
      timestamp,
      error: errors?.[0],
    });

    // Update campaign message if applicable
    if (messageStatus) {
      await CampaignService.handleMessageStatusUpdate(wamid, messageStatus, new Date(timestamp * 1000));
    }

    // Handle failed messages - check for invalid numbers
    if (messageStatus === 'failed' && errors && errors.length > 0) {
      await this.handleFailedMessage(wamid, errors[0]);
    }
  }

  /**
   * Handle failed messages and detect invalid numbers
   */
  private async handleFailedMessage(wamid: string, error: any) {
    // WhatsApp error codes for invalid numbers
    const invalidNumberCodes = [
      1013, // Number not on WhatsApp
      131051, // Unsupported recipient
      131026, // Too many messages to this recipient
      131047, // Re-engagement message
      131008, // Message undeliverable
    ];

    if (invalidNumberCodes.includes(error.code)) {
      // Get message to find contact
      const MessageModel = (await import('../models/message.model')).default;
      const message = await MessageModel.findByWamid(wamid);

      if (message) {
        // Try to find contact by phone number
        const contact = await ContactModel.findByPhone(message.company_id, message.to_phone);

        if (contact) {
          // Determine reason
          let reason = 'other';
          if (error.code === 1013) {
            reason = 'not_whatsapp';
          } else if (error.code === 131051) {
            reason = 'invalid_format';
          } else if (error.code === 131026 || error.code === 131047) {
            reason = 'blocked';
          }

          // Mark contact as invalid
          await CampaignService.handleInvalidNumber(contact.id, reason);

          console.log(`Marked contact ${contact.phone_number} as invalid: ${reason}`);
        }
      }
    }
  }

  /**
   * Handle incoming messages
   */
  private async handleIncomingMessage(message: any, metadata: any) {
    await MessageService.saveIncomingMessage({
      phone_number_id: metadata.phone_number_id,
      message_id: message.id,
      from: message.from,
      type: message.type,
      content: this.extractMessageContent(message),
      context: message.context,
    });
  }

  /**
   * Handle errors from webhook
   */
  private async handleError(error: any) {
    console.error('Meta webhook error:', error);
    // Log error for monitoring
  }

  /**
   * Extract message content based on type
   */
  private extractMessageContent(message: any): any {
    const type = message.type;

    switch (type) {
      case 'text':
        return { body: message.text?.body };
      case 'image':
        return { id: message.image?.id, caption: message.image?.caption };
      case 'video':
        return { id: message.video?.id, caption: message.video?.caption };
      case 'document':
        return { id: message.document?.id, filename: message.document?.filename };
      case 'audio':
        return { id: message.audio?.id };
      case 'location':
        return message.location;
      case 'contacts':
        return message.contacts;
      default:
        return message;
    }
  }
}

export default new WebhookHandlerService();
