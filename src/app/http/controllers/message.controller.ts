import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import MessageService from '@surefy/console/services/message.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { v4 as uuidv4, validate as uuidValidate } from "uuid";
import { handleIncomingMessageChatBot } from  "@surefy/console/app/services/chatbot/chatbot.service"
import activityLogsModel from '../../models/activityLogs.model';

class MessageController {
  /**
   * POST /v1/messages/send
   * Send a message
   */
  sendMessage = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { phone_number_id, to, type, profile_name, text, template, image, video, document, audio, interactive, location, contacts, sticker, reaction, context, campaign_id } = req.body;

    if (!phone_number_id || !to || !type) {
      throw new HTTP400Error({ message: 'Phone number ID, recipient, and message type are required' });
    }

    // Send under the owner's account so message is attributed to Aakanksha's data
    const effectiveUserId = req.ownerId ?? req.userId!;

    const message = await MessageService.sendMessage({
      messageUUID: uuidv4(),
      user_id: effectiveUserId,
      company_id: req.companyId!,
      campaign_id: campaign_id || undefined,
      phone_number_id,
      profile_name,
      to,
      type,
      text,
      template,
      image,
      video,
      document,
      audio,
      interactive,
      location,
      contacts,
      sticker,
      reaction,
      context,
    });

    const { data } = message

    await activityLogsModel.create({
      user_id: effectiveUserId,
      company_id: req.companyId!,
      action: 'SEND',
      entity_type: 'MESSAGE',
      entity_id: data?.id,
      read: false,
      description: `Sent ${type} message to ${to}`,
      new_data: {
        recipient: to,
        message_type: type,
        campaign_id: campaign_id || null,
        phone_number_id,
        whatsapp_message_id: data?.whatsapp_message_id
      },
      ip_address: (req.headers['x-forwarded-for'] as string) || req.socket.remoteAddress || '',
      user_agent: req.headers['user-agent'] || '',
      request_method: req.method,
      api_endpoint: req.originalUrl,
      status: 'SUCCESS'
    });

    return successResponse(req, res, 'Message sent successfully', message, HttpStatusCode.CREATED);
  });

  /**
   * POST /v1/messages/mark-read
   * Mark message as read
   */
  markAsRead = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { phone_number_id, message_id } = req.body;

    if (!phone_number_id || !message_id) {
      throw new HTTP400Error({ message: 'Phone number ID and message ID are required' });
    }

    const result = await MessageService.markAsRead({
      company_id: req.companyId!,
      phone_number_id,
      message_id,
    });

    return successResponse(req, res, 'Message marked as read', result);
  });

  /**
   * GET /v1/messages
   * Get messages for company with pagination, filtering, and search
   */
  getMessages = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const {
      status,
      direction,
      type,
      phone_number_id,
      from_date,
      to_date,
      search,
      page,
      limit,
      sort_by,
      sort_order
    } = req.query;

    const effectiveUserId = req.ownerId ?? req.userId!;

    const result = await MessageService.getMessages(req.companyId!, effectiveUserId, {
      status,
      direction,
      type,
      phone_number_id,
      from_date: from_date ? new Date(from_date as string) : undefined,
      to_date: to_date ? new Date(to_date as string) : undefined,
      search,
      page,
      limit,
      sort_by,
      sort_order,
    });

    return successResponse(req, res, 'Messages retrieved successfully', result);
  });

  /**
   * GET /v1/messages/stats
   * Get message statistics
   */
  getStats = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { from_date, to_date } = req.query;

    const stats = await MessageService.getMessageStats(
      req.companyId!,
      from_date ? new Date(from_date as string) : undefined,
      to_date ? new Date(to_date as string) : undefined,
    );

    return successResponse(req, res, 'Message statistics retrieved successfully', stats);
  });

  /**
   * POST /v1/webhook
   * Handle Meta webhook callbacks
   */
  handleWebhook = tryCatchAsync(async (req: Request, res: Response) => {
    console.log(
      "🔥 META WEBHOOK RECEIVED",
      JSON.stringify(req.body, null, 2)
    );

    const { entry } = req.body;

    for (const item of entry || []) {
      for (const change of item.changes || []) {
        if (change.field === 'messages') {
          const value = change.value;

          // Handle status updates
          for (const status of value.statuses || []) {
            await MessageService.handleStatusUpdate({
              wamid: status.id,
              status: status.status,
              timestamp: status.timestamp,
              error: status.errors?.[0],
            });
          }

          // Handle incoming messages
          for (const message of value.messages || []) {
            console.log("📩 INCOMING MESSAGE:", message)
            await MessageService.saveIncomingMessage({
              phone_number_id: value.metadata.phone_number_id,
              profile_name: value.contacts?.[0]?.profile?.name || "",
              message_id: message.id,
              from: message.from,
              type: message.type,
              content: message,
              context: message.context ? message.context.id : null,
            });

            await handleIncomingMessageChatBot(value.metadata.phone_number_id, message)
          }
        }
      }
    }

    return res.status(200).json({ success: true });
  });

  /**
   * GET /v1/webhook
   * Verify Meta webhook
   */
  verifyWebhook = tryCatchAsync(async (req: Request, res: Response) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode === 'subscribe' && token === process.env.META_WEBHOOK_VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send('Forbidden');
    }
  });

  /**
   * POST /v1/messages/bulk-send
   * Send multiple messages in bulk (max 1000 per request)
   */
  bulkSendMessages = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const { messages } = req.body;

    console.log("Bulk send messages request received", messages);

    if (!messages || !Array.isArray(messages)) {
      throw new HTTP400Error({ message: 'Messages array is required' });
    }

    const effectiveUserId = req.ownerId ?? req.userId!;
    const result = await MessageService.bulkSendMessages(effectiveUserId, messages);

    return successResponse(req, res, 'Bulk messages queued for sending', result, HttpStatusCode.ACCEPTED);
  });

  getMessagesConversations = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { phone_number_id } = req.query
    const effectiveUserId = req.ownerId ?? req.userId!;
    const userMessages = await MessageService.getMessagesConversation(effectiveUserId, phone_number_id)
    return successResponse(req, res, 'Message Retrived succesfully', userMessages);
  })

  getLeadConversations = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { phone_number_id, leadNumber } = req.query
    const effectiveUserId = req.ownerId ?? req.userId!;
    const userMessages = await MessageService.getLeadConversations(leadNumber, phone_number_id, effectiveUserId)
    return successResponse(req, res, "Lead Message Retreived Succesfuly", userMessages)
  })

  getUserStats = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    // Use ownerId so team members see the account owner's stats
    const effectiveUserId = req.ownerId ?? req.userId!
    console.log("Effective User Id (ownerId ?? userId)", effectiveUserId)
    const { time_frame } = req.query
    const userStats = await MessageService.getUserStats(effectiveUserId, time_frame)
    return successResponse(req, res, 'User Stats retrieved successfully', userStats)
  })

}

export default new MessageController();