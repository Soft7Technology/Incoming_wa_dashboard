import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import supportService from '../../services/support.service';
import sendEmail from '../../utils';
import supportTicketModel from '../../models/supportTicket.model';
import ticketConversation from '../../models/ticketConversation';

class supporController {
  /**
   * POST /v1/support
   * Create Chatbot support
   */
  async createTicket(req: AuthRequest, res: Response) {
    try {
      const { name, email, phone, message } = req.body;

      // Basic validation (avoid undefined crashes)
      if (!name || !email || !message) {
        return res.status(400).json({
          success: false,
          message: 'Name, email and message are required',
        });
      }

      // Create ticket
      const ticket = await supportService.createtTicket(req.userId!, req.companyId!, { name, email, message, phone });

      if (!ticket) {
        return res.status(500).json({
          success: false,
          message: 'Failed to create ticket',
        });
      }

      // Send email (DO NOT break flow if email fails)
      try {
        await sendEmail(
          email,
          'Support Ticket Created',
          `Your support ticket has been created successfully. Our team will get back to you shortly.

Ticket Details:
Name: ${name}
Email: ${email}
Phone: ${phone}
Message: ${message}`,
        );
      } catch (emailError) {
        console.error('Email sending failed:', emailError);
        // Don't throw — ticket is already created
      }

      return successResponse(req, res, 'Ticket Raised Successfully', ticket, HttpStatusCode.OK);
    } catch (error: any) {
      console.error('Create Ticket Error:', error);

      return res.status(500).json({
        success: false,
        message: error?.message || 'Internal Server Error',
      });
    }
  }

  /**
   * GET /v1/support/conversation
   * Get all conversation of a ticket
   */
  async getTicketConversation(req: AuthRequest, res: Response) {
    const { ticketId } = req.params;
    if (!ticketId) {
      throw new HTTP400Error({ message: 'Ticket Id is required' });
    }
    const conversation = await supportService.getTicketConversation(ticketId);
    successResponse(req, res, 'Conversation retrieved successfully', conversation, HttpStatusCode.OK);
  }

  async replyToConversation(req: AuthRequest, res: Response) {
    try {
      const { ticketId } = req.params;
      const { message, email, phone } = req.body;

      if (!ticketId) {
        throw new HTTP400Error({ message: 'Ticket Id is required' });
      }

      if (!message) {
        throw new HTTP400Error({ message: 'Message is required' });
      }

      const reply = await supportService.replyToConversation(
        ticketId,
        req.userId!,
        req.companyId!,
        message,
        email,
        phone,
      );
      console.log('Reply:', reply);

      // Email should NEVER crash API
      if (reply && email) {
        try {
          await sendEmail(email, 'Support Ticket Update', `${message}`);
          console.log('Email sent successfully');
        } catch (emailError: any) {
          console.error('Email Sending Failed:', emailError.message);
        }
      }

      return successResponse(req, res, 'Reply sent successfully', reply, HttpStatusCode.OK);
    } catch (error: any) {
      console.error('Reply Error:', error);

      if (error instanceof HTTP400Error) {
        return res.status(400).json({ success: false, message: error.message });
      }

      return res.status(500).json({
        success: false,
        message: error.message || 'Something went wrong',
      });
    }
  }

  async getSupportTicket(req: AuthRequest, res: Response) {
    const { supportTicket } = req.params;
    if (!supportTicket) {
      throw new HTTP400Error({ message: 'Support Ticket Id is required' });
    }
    const conversation = await supportService.getSupportTicket(supportTicket);
    successResponse(req, res, 'Support Ticket retrieved successfully', conversation, HttpStatusCode.OK);
  }

  async getAllTickets(req: JWTAuthRequest, res: Response) {
    // Members should see tickets scoped to the owner's company context
    const effectiveUserId = req.ownerId ?? req.userId!;
    const tickets = await supportService.getAllTickets(req.companyId!);
    successResponse(req, res, 'Tickets retrieved successfully', tickets, HttpStatusCode.OK);
  }

  async resolveTicket(req: AuthRequest, res: Response) {
    const { ticketId } = req.params;
    if (!ticketId) {
      throw new HTTP400Error({ message: 'Ticket Id is required' });
    }
    const resolvedTicket = await supportService.resolveTicket(ticketId);
    successResponse(req, res, 'Ticket resolved successfully', resolvedTicket, HttpStatusCode.OK);
  }

  async closeTicket(req: AuthRequest, res: Response) {
    const { ticketId } = req.params;
    if (!ticketId) {
      throw new HTTP400Error({ message: 'Ticket Id is required' });
    }
    const closedTicket = await supportService.closeTicket(ticketId);
    successResponse(req, res, 'Ticket closed successfully', closedTicket, HttpStatusCode.OK);
  }

  async forwardTicketToSuperAdmin(req: JWTAuthRequest, res: Response) {
    const { ticketId } = req.params;
    if (!ticketId) {
      throw new HTTP400Error({ message: 'Ticket Id is required' });
    }
    const effectiveUserId = req.ownerId ?? req.userId!;
    const forwardTicket = await supportService.fowardTicketToSuperAdmin(effectiveUserId, ticketId);
    successResponse(req, res, 'Ticket forward to superadmin successfully', forwardTicket, HttpStatusCode.OK);
  }

  async forwardTicketConversations(req: AuthRequest, res: Response) {
    const { ticketId } = req.params;
    const superAdminId = '5a66df74-92d4-4bcd-814b-13d6318d4116';
    const forwardTicketConversations = await ticketConversation.forwardTicketConversations(ticketId, superAdminId);
    successResponse(req, res, 'Forward Ticket Conversation', forwardTicketConversations, HttpStatusCode.OK);
  }

  async forwardTicketReply(req: AuthRequest, res: Response) {
    try {
      const { ticketId } = req.params;
      const { message, email, phone } = req.body;

      if (!ticketId) {
        throw new HTTP400Error({ message: 'Ticket Id is required' });
      }

      if (!message) {
        throw new HTTP400Error({ message: 'Message is required' });
      }

      const reply = await supportService.replyToForwardTicket(
        ticketId,
        req.userId!,
        req.companyId!,
        message,
        email,
        phone,
      );
      console.log('Reply:', reply);

      if (reply) {
        sendEmail(email, 'Support Ticket Update', `${message}`);
      }

      return successResponse(req, res, 'Reply sent successfully', reply, HttpStatusCode.OK);
    } catch (error: any) {
      console.error('Reply Error:', error);

      if (error instanceof HTTP400Error) {
        return res.status(400).json({ success: false, message: error.message });
      }

      return res.status(500).json({
        success: false,
        message: error.message || 'Something went wrong',
      });
    }
  }

  async getAllforwardTickets(req: JWTAuthRequest, res: Response) {
    try {
      const effectiveUserId = req.ownerId ?? req.userId!;
      const tickets = await supportService.getAllforwardTickets(effectiveUserId);
      successResponse(req, res, 'Tickets retrieved successfully', tickets, HttpStatusCode.OK);
    } catch (error: any) {
      console.error('Reply Error:', error);

      if (error instanceof HTTP400Error) {
        return res.status(400).json({ success: false, message: error.message });
      }

      return res.status(500).json({
        success: false,
        message: error.message || 'Something went wrong',
      });
    }
  }

  async deleteSupportTicket(req: AuthRequest, res: Response) {
    const { ticketId } = req.params;
    await supportService.deleteSupportTicket(ticketId);
    return successResponse(req, res, 'Ticket deleted successfully');
  }
}

export default new supporController();
