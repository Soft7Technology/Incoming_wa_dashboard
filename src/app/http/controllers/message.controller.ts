import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import MessageService from '@surefy/console/services/message.service';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { v4 as uuidv4, validate as uuidValidate } from "uuid";

class MessageController {
  /**
   * POST /v1/messages/send
   * Send a message
   */
  sendMessage = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { phone_number_id, to, type, text, template, image, video, document, audio, interactive, location, contacts, sticker, reaction, context, campaign_id } = req.body;

    if (!phone_number_id || !to || !type) {
      throw new HTTP400Error({ message: 'Phone number ID, recipient, and message type are required' });
    }

    const message = await MessageService.sendMessage({
      messageUUID: uuidv4(),
      company_id: req.companyId!,
      user_id: req.userId!,
      campaign_id: campaign_id || undefined,
      phone_number_id,
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

    const result = await MessageService.getMessages(req.companyId!, {
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
            await MessageService.saveIncomingMessage({
              phone_number_id: value.metadata.phone_number_id,
              profile_name: value.contacts?.[0]?.profile?.name || "",
              message_id: message.id,
              from: message.from,
              type: message.type,
              content: message,
              context: message.context,
            });
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
  bulkSendMessages = tryCatchAsync(async (req: AuthRequest, res: Response) => {
    const { messages } = req.body;


    console.log("Bulk send messages request received", messages);

    if (!messages || !Array.isArray(messages)) {
      throw new HTTP400Error({ message: 'messages array is required' });
    }

    const result = await MessageService.bulkSendMessages(req.companyId!, messages);

    return successResponse(req, res, 'Bulk messages queued for sending', result, HttpStatusCode.ACCEPTED);
  });
}

export default new MessageController();