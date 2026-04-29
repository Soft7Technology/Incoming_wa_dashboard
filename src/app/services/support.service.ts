import axios, { AxiosInstance, AxiosRequestConfig } from 'axios';
import HTTP500Error from '@surefy/exceptions/HTTP500Error';
import { subscriptionPlans } from '../interfaces/subscription.interface';
import subscriptionModel from '../models/subscription.model';
import { RazorpayOrderRequest } from '../interfaces/razorpay.interface';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import CompanyService from './company.service';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import supportTicketModel from '../models/supportTicket.model';
import ticketConversationModel from '../models/ticketConversation';
import userModel from '../models/user.model';

class supportService {
  async createtTicket(userId: string, companyId: string, data: any) {
    const { message } = data;
    const companiesId = companyId || 'e8318a5a-e01c-41db-803b-80347051b00d';
    const generateTicket = await supportTicketModel.create({ ...data, user_id: userId, company_id: companiesId });
    if (generateTicket) {
      await ticketConversationModel.create({
        message,
        ticket_id: generateTicket.id,
        user_name: data.name,
        user_email: data.email,
        user_phone: data.phone,
        user_id: userId,
        company_id: companyId,
      });
    }
    return generateTicket;
  }

  async getTicketConversation(ticketId: string) {
    const conversation = await ticketConversationModel.findByTicketId(ticketId);
    if (!conversation) {
      throw new HTTP400Error({ message: 'No conversation found for this ticket' });
    }
    return conversation;
  }

  async getSupportTicket(supportTicketId: string) {
    const ticket = await supportTicketModel.findById(supportTicketId);
    if (!ticket) {
      throw new HTTP400Error({ message: 'Support Ticket not found' });
    }
    return ticket;
  }

  async replyToConversation(ticketId: string, userId: string, companyId: string, message: string,email:string,phone:string) {
    console.log('Ticket Id', ticketId);
    const ticket = await ticketConversationModel.findConversationByTicketId(ticketId);
    console.log('Conversation Ticket', ticket);
    if (!ticket) {
      throw new HTTP400Error({ message: 'Ticket Conversation not found' });
    }
    const user = await userModel.findById(userId);
    console.log('User Name', user);
    const reply = await ticketConversationModel.create({
      message, 
      ticket_id: ticket.ticket_id,
      user_name: user.name,
      user_email: email,
      user_phone: phone,
      user_id: userId,
      company_id: companyId,
    });
    return reply;
  }

  async getAllTickets(companyId: string) {
    const tickets = await supportTicketModel.findAllTicketByCompanyId(companyId);
    return tickets;
  }

  async resolveTicket(ticketId: string) {
    const resolvedTicket = await supportTicketModel.update(ticketId, { status: 'resolved' });
    return resolvedTicket;
  }

  async closeTicket(ticketId: string) {
    const closedTicket = await supportTicketModel.update(ticketId, { status: 'closed' });
    return closedTicket;
  }
}


export default new supportService();





// CREATE TABLE ticket_conversation (
//     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

//     message TEXT NOT NULL,

//     user_name VARCHAR(255),
//     user_id UUID,

//     company_id UUID NOT NULL,

//     created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
//     updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

//     CONSTRAINT fk_user
//         FOREIGN KEY (user_id) REFERENCES users(id)
//         ON DELETE SET NULL,

//     CONSTRAINT fk_company
//         FOREIGN KEY (company_id) REFERENCES companies(id)
//         ON DELETE CASCADE
// );

// ({ ...data, user_id: userId, company_id: companyId });