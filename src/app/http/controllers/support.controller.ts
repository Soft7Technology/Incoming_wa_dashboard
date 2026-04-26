import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import chatBotService from '../../services/chatbot.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import wabaModel from '../../models/waba.model';
import phoneNumberModel from '../../models/phoneNumber.model';
import supportService from '../../services/support.service';
import sendEmail from '../../utils';


class supporController {
  /**
   * POST /v1/support
   * Create Chatbot support
   */
  async createTicket(req: AuthRequest, res: Response) {
    const { name, email, phone, message } = req.body;
    const createTicket = await supportService.createtTicket(req.userId!, req.companyId!, {
      name,
      email,
      message,
      phone,
    });
    if(createTicket){
      await sendEmail(
        email,
       'Support Ticket Created',
       `Your support ticket has been created successfully. Our team will get back to you shortly.\n\nTicket Details:\nName: ${name}\nEmail: ${email}\nPhone: ${phone}\nMessage: ${message}`,
      )
    }
    successResponse(req, res, 'Ticket Raised Sucesfully', createTicket, HttpStatusCode.OK);
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
      const { message,email,phone } = req.body;

      if (!ticketId) {
        throw new HTTP400Error({ message: 'Ticket Id is required' });
      }

      if (!message) {
        throw new HTTP400Error({ message: 'Message is required' });
      }

      const reply = await supportService.replyToConversation(ticketId, req.userId!, req.companyId!, message,email,phone);
      console.log('Reply:', reply);

      if(reply){
        sendEmail(
          email,
         'Support Ticket Update',
         `${message}`,
        )
      }

      return successResponse(req, res, 'Reply sent successfully', reply, HttpStatusCode.OK);
    } catch (error: any) {
      console.error('Reply Error:', error);

      // If it's your custom error
      if (error instanceof HTTP400Error) {
        return res.status(400).json({
          success: false,
          message: error.message,
        });
      }

      // fallback error
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

  async getAllTickets(req: AuthRequest, res: Response) {
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
}

export default new supporController()






// -- CREATE TABLE support_tickets (
// --     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

// --     name VARCHAR(255) NOT NULL,
// --     email VARCHAR(255) NOT NULL,
// --     phone VARCHAR(20),

// --     message TEXT NOT NULL,

// --     user_id UUID,
// --     company_id UUID NOT NULL,

// --     status VARCHAR(50) DEFAULT 'open',  -- open, in_progress, closed

// --     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
// --     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

// --     CONSTRAINT fk_user
// --         FOREIGN KEY (user_id) REFERENCES users(id)
// --         ON DELETE SET NULL,

// --     CONSTRAINT fk_company
// --         FOREIGN KEY (company_id) REFERENCES companies(id)
// --         ON DELETE CASCADE
// -- );
