import MessageModel from '@surefy/console/models/message.model';
import PhoneNumberModel from '@surefy/console/models/phoneNumber.model';
import CompanyModel from '@surefy/console/models/company.model';
import { SendMessageDto, SendBulkMessageDto, MarkAsReadDto, MessageStatusUpdate, BulkSendMessageDto } from '@surefy/console/interfaces/message.interface';
import MetaService from '@surefy/console/services/meta.service';
import CreditService from '@surefy/console/services/credit.service';
import WebhookService from '@surefy/console/services/webhook.service';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import webhookService from '@surefy/console/services/webhook.service';
import { bulkMessageSendQueue } from '../../queues/bulkMessageSend.queue';
import { v4 as uuidv4, validate as uuidValidate } from "uuid";
import messageModel from '@surefy/console/models/message.model';
import userModel from '../models/user.model';


class MessageService {
  /**
   * Calculate message cost (simplified pricing)
   */
  private calculateMessageCost(type: string, category?: string): number {
    // Simplified pricing - adjust based on actual Meta pricing
    if (type === 'template') {
      if (category === 'MARKETING') return 0.99;
      if (category === 'UTILITY') return 0.14;
      if (category === 'AUTHENTICATION') return 0.14;
    }
    return 0.145; // Default for text messages
  }


    async getUserStats(userId:any){
      const userStats = await userModel.getUserStats(userId)
      return userStats
    }

  /**
   * Send message
   */
  async sendMessage(data: SendMessageDto) {
    const phoneNumber = await PhoneNumberModel.findByPhoneNumberId(data.phone_number_id);
    if (!phoneNumber) {
      throw new HTTP404Error({ message: 'Phone number not found' });
    }

    // Verify company has sufficient credits
    // const company = await CompanyModel.findById(data.company_id);
    // if (!company) {
    //   throw new HTTP404Error({ message: 'Company not found' });
    // }

    // const messageCost = this.calculateMessageCost(data.type);
    // if (company.credit_balance < messageCost) {
    //   throw new HTTP400Error({ message: 'Insufficient credits' });
    // }

    // Build Meta API payload
    const metaPayload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: data.to,
      type: data.type,
    };

    if (data.type === 'text' && data.text) {
      metaPayload.text = data.text;
    } else if (data.type === 'template' && data.template) {
      // Format template for Meta API - language must be an object with 'code' property
      metaPayload.template = {
        ...data.template,
        language: typeof data.template.language === 'string'
          ? { code: data.template.language }
          : data.template.language
      };
    } else if (data.type === 'image' && data.image) {
      metaPayload.image = data.image;
    } else if (data.type === 'video' && data.video) {
      metaPayload.video = data.video;
    } else if (data.type === 'document' && data.document) {
      metaPayload.document = data.document;
    } else if (data.type === 'audio' && data.audio) {
      metaPayload.audio = data.audio;
    } else if (data.type === 'interactive' && data.interactive) {
      metaPayload.interactive = data.interactive;
    } else if (data.type === 'location' && data.location) {
      metaPayload.location = data.location;
    } else if (data.type === 'contacts' && data.contacts) {
      metaPayload.contacts = data.contacts;
    } else if (data.type === 'sticker' && data.sticker) {
      metaPayload.sticker = data.sticker;
    } else if (data.type === 'reaction' && data.reaction) {
      metaPayload.reaction = data.reaction;
    }

    if (data.context) {
      metaPayload.context = data.context;
    }

    // const messageId = data?.messageUUID && uuidValidate(data.messageUUID) ? data.messageUUID : uuidv4();

    // Create message record
    const message = await MessageModel.create({
      id: data.messageUUID,
      user_id: data.user_id,
      campaign_id: data.campaign_id,
      phone_number_id: phoneNumber.id,
      profile_name: data.profile_name || "",
      direction: 'outbound',
      type: data.type,
      from_phone: phoneNumber.display_phone_number,
      to_phone: data.to,
      status: 'queued',
      content: metaPayload,
      // cost: messageCost,
      queued_at: new Date(),
    });


    try {
      // Send via Meta API
      const metaResponse = await MetaService.sendMessage(phoneNumber.phone_number_id, metaPayload);

      // Update message with WAMID
      await MessageModel.update(message.id, {
        wamid: metaResponse.messages[0].id,
        status: 'sent',
        sent_at: new Date(),
      });

      // Deduct credits
      // await CreditService.deductCredit({
      //   company_id: data.company_id,
      //   amount: messageCost,
      //   reference_type: 'message',
      //   reference_id: message.id,
      //   description: `Message sent to ${data.to}`,
      // });

      // Trigger webhook
      // await WebhookService.triggerWebhook(data.company_id, 'message.sent', {
      //   message_id: message.id,
      //   wamid: metaResponse.messages[0].id,
      //   to: data.to,
      //   timestamp: new Date().toISOString(),
      // });

      return { ...message, wamid: metaResponse.messages[0].id };
    } catch (error: any) {
      // Update message as failed
      await MessageModel.update(message.id, {
        status: 'failed',
        failed_at: new Date(),
        error_message: error.message,
        error_code: error.code,
      });

      throw error;
    }
  }

  async bulkSendMessage(data: BulkSendMessageDto) {
    const phoneNumber = await PhoneNumberModel.findByPhoneNumberId(data.phone_number_id);
    if (!phoneNumber) {
      throw new HTTP404Error({ message: 'Phone number not found' });
    }

    // Verify company has sufficient credits
    const user = await userModel.findById(data.user_id);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }

    // const messageCost = this.calculateMessageCost(data.type);
    // if (company.credit_balance < messageCost) {
    //   throw new HTTP400Error({ message: 'Insufficient credits' });
    // }

    // Build Meta API payload
    const metaPayload: any = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: data.to,
      type: data.type,
    };

    if (data.type === 'text' && data.text) {
      metaPayload.text = data.text;
    } else if (data.type === 'template' && data.template) {
      // Format template for Meta API - language must be an object with 'code' property
      metaPayload.template = {
        ...data.template,
        language: typeof data.template.language === 'string'
          ? { code: data.template.language }
          : data.template.language
      };
    } else if (data.type === 'image' && data.image) {
      metaPayload.image = data.image;
    } else if (data.type === 'video' && data.video) {
      metaPayload.video = data.video;
    } else if (data.type === 'document' && data.document) {
      metaPayload.document = data.document;
    } else if (data.type === 'audio' && data.audio) {
      metaPayload.audio = data.audio;
    } else if (data.type === 'interactive' && data.interactive) {
      metaPayload.interactive = data.interactive;
    } else if (data.type === 'location' && data.location) {
      metaPayload.location = data.location;
    } else if (data.type === 'contacts' && data.contacts) {
      metaPayload.contacts = data.contacts;
    } else if (data.type === 'sticker' && data.sticker) {
      metaPayload.sticker = data.sticker;
    } else if (data.type === 'reaction' && data.reaction) {
      metaPayload.reaction = data.reaction;
    }

    if (data.context) {
      metaPayload.context = data.context;
    }

    // const messageId = data?.messageUUID && uuidValidate(data.messageUUID) ? data.messageUUID : uuidv4();

    // Create message record
    const message = await MessageModel.create({
      id: data.messageUUID,
      user_id: data.user_id,
      // campaign_id: data.campaign_id,
      phone_number_id: phoneNumber.id,
      direction: 'outbound',
      type: data.type,
      from_phone: phoneNumber.display_phone_number,
      to_phone: data.to,
      status: 'queued',
      content: metaPayload,
      // cost: messageCost,
      queued_at: new Date(),
    });



    try {
      // Send via Meta API
      const metaResponse = await MetaService.sendMessage(phoneNumber.phone_number_id, metaPayload);

      // Update message with WAMID
      await MessageModel.update(message.id, {
        wamid: metaResponse.messages[0].id,
        status: 'sent',
        sent_at: new Date(),
      });

      // Deduct credits
      // await CreditService.deductCredit({
      //   company_id: data.company_id,
      //   amount: messageCost,
      //   reference_type: 'message',
      //   reference_id: message.id,
      //   description: `Message sent to ${data.to}`,
      // });

      // Trigger webhook
      // await WebhookService.triggerWebhook(data.company_id, 'message.sent', {
      //   message_id: message.id,
      //   wamid: metaResponse.messages[0].id,
      //   to: data.to,
      //   timestamp: new Date().toISOString(),
      // });

      return { ...message, wamid: metaResponse.messages[0].id };
    } catch (error: any) {
      // Update message as failed
      await MessageModel.update(message.id, {
        status: 'failed',
        failed_at: new Date(),
        error_message: error.message,
        error_code: error.code,
      });

      throw error;
    }
  }

  /**
   * Mark message as read
   */
  async markAsRead(data: MarkAsReadDto) {
    const phoneNumber = await PhoneNumberModel.findByPhoneNumberId(data.phone_number_id);
    if (!phoneNumber) {
      throw new HTTP404Error({ message: 'Phone number not found' });
    }

    await MetaService.markAsRead(phoneNumber.phone_number_id, data.message_id);

    // Update local message if exists
    const message = await MessageModel.findByWamid(data.message_id);
    if (message) {
      await MessageModel.updateStatus(data.message_id, 'read');
    }

    return { success: true };
  }

  /**
   * Handle message status update from webhook
   */
  async handleStatusUpdate(statusUpdate: MessageStatusUpdate) {
    const message = await MessageModel.findByWamid(statusUpdate.wamid);
    if (!message) {
      console.warn(`Message not found for WAMID: ${statusUpdate.wamid}`);
      return;
    }

    await MessageModel.updateStatus(statusUpdate.wamid, statusUpdate.status, {
      error_message: statusUpdate.error?.message,
      error_code: statusUpdate.error?.code,
    });

    // Trigger webhook
    await WebhookService.triggerWebhook(message.company_id, `message.${statusUpdate.status}`, {
      message_id: message.id,
      wamid: statusUpdate.wamid,
      status: statusUpdate.status,
      timestamp: new Date(statusUpdate.timestamp * 1000).toISOString(),
      error: statusUpdate.error,
    });
  }


  /**
   * Save incoming message
   */
  async saveIncomingMessage(data: any) {
    console.log("Saving incoming message", data)
    const phoneNumber = await PhoneNumberModel.findByPhoneNumberId(data.phone_number_id);
    if (!phoneNumber) {
      console.warn(`Phone number not found: ${data.phone_number_id}`);
      return;
    }

    const message = await MessageModel.create({
      user_id: phoneNumber.user_id,
      profile_name: data.profile_name,
      phone_number_id: phoneNumber.id,
      wamid: data.message_id,
      direction: 'inbound',
      type: data.type,
      from_phone: data.from,
      to_phone: phoneNumber.display_phone_number,
      status: 'received',
      content: data.content,
      context: data.context,
      delivered_at: new Date(),
    });

    // const webhookPayload = webhookService.buildIncomingWebhookPayload(message, phoneNumber);
    // await WebhookService.triggerWebhook(
    //   phoneNumber.company_id,
    //   'message.received',
    //   webhookPayload
    // );


    return message;
  }

  /**
   * Get messages for company
   */
  async getMessages(companyId: string,userId:string, filters: any = {}) {
    return MessageModel.findByUserId(companyId,userId, filters);
  }


    /**
   * Handle Send ChatBot message
   */
  async sendChatBotMessage(phoneNumberId: string, to: string, response: any) {
    {
      try {
        let metaPayload: any = {
          messaging_product: "whatsapp",
          to: to,
        };

        // ✅ TEXT MESSAGE
        if (response.type === "text") {
          metaPayload.type = "text";
          metaPayload.text = {
            body: response.text,
          };
        }

        // ✅ INTERACTIVE BUTTON MESSAGE
        if (response.type === "interactive") {
          metaPayload.type = "interactive";
          metaPayload.interactive = {
            type: "button",
            body: {
              text: response.interactive.body.text,
            },
            action: {
              buttons: response.interactive.action.buttons.map((btn: any) => ({
                type: "reply",
                reply: {
                  id: btn.reply.id,
                  title: btn.reply.title,
                },
              })),
            },
          };
        }
        const metaResponse = await MetaService.sendMessage(phoneNumberId, metaPayload);
        console.log("✅ Message Sent:", metaResponse.data);
        return metaResponse.data;
      } catch (error: any) {
        console.error("❌ Send Message Error:", error?.response?.data || error.message);
        return null;
      }
    }
  }


  async bulkSendMessages(userId: string, messages: BulkSendMessageDto[]) {
    // Validate messages array length
    if (!messages || messages.length === 0) {
      throw new HTTP400Error({ message: 'Messages array cannot be empty' });
    }

    if (messages.length > 1000) {
      throw new HTTP400Error({ message: 'Maximum 1000 messages allowed per request' });
    }

    // Verify company exists
    const user = await userModel.findById(userId);
    if (!user) {
      throw new HTTP404Error({ message: 'User not found' });
    }

    // Validate all messages have required fields
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg.phone_number_id || !msg.to || !msg.type) {
        throw new HTTP400Error({
          message: `Message at index ${i}: Phone number ID, recipient, and message type are required`,
        });
      }
    }

    // Calculate total estimated cost
    // const totalEstimatedCost = messages.reduce((sum, msg) => {
    //   return sum + this.calculateMessageCost(msg.type);
    // }, 0);

    // Check if company has sufficient credits
    // if (company.credit_balance < totalEstimatedCost) {
    //   throw new HTTP400Error({
    //     message: `Insufficient credits. Required: ${totalEstimatedCost.toFixed(2)}, Available: ${company.credit_balance.toFixed(2)}`,
    //   });
    // }

    const normalizedMessages = messages.map((msg) => ({
      ...msg,
      messageUUID: msg.messageUUID && uuidValidate(msg.messageUUID) ? msg.messageUUID : uuidv4(),
    }));

    // Add job to queue
    const job = await bulkMessageSendQueue.add('bulk-send', {
      userId,
      messages: normalizedMessages,
    });

    return {
      job_id: job.id,
      total_messages: normalizedMessages.length,
      // estimated_cost: totalEstimatedCost,
      status: 'queued',
      message: 'Bulk message send job has been queued for processing',
      messages: normalizedMessages.map((msg) => ({
        message_id: msg.messageUUID,
        to: msg.to,
        status: 'queued',
      })),
    };
  }

  /**
   * Get message statistics
   */
  async getMessageStats(companyId: string, fromDate?: Date, toDate?: Date) {
    return MessageModel.getMessageStats(companyId, fromDate, toDate);
  }

  async getMessagesConversation(userId:string,phone_number_id:any){
    return MessageModel.getMessagesConversation(userId,phone_number_id)
  }

  async getLeadConversations(leadNumber:any,phone_number_id:any,userId:string){
    return MessageModel.getLeadConversations(leadNumber,phone_number_id,userId)
  }
}

export default new MessageService();