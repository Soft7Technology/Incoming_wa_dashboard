import { Router } from 'express';
import UserRoute from './user.route';
import supportController from '../app/http/controllers/support.controller';

const supportRoute = Router()

supportRoute.get("/tickets",supportController.getAllTickets) // This will be used to get all the tickets of a user by user id and company id
supportRoute.get("/:ticketId/conversation",supportController.getTicketConversation)
supportRoute.get('/:supportTicket',supportController.getSupportTicket) // This will be used to get all the conversation of a ticket by ticket id and user id and company id
supportRoute.post('/ticket',supportController.createTicket)
supportRoute.post('/:ticketId/reply',supportController.replyToConversation) // This will be used to create a new conversation in the ticket conversation table with the same ticket id and user id and company id
supportRoute.put('/:ticketId/resolve',supportController.resolveTicket)
supportRoute.put('/:ticketId/close',supportController.closeTicket) // This will be used to close a ticket by changing the status of the ticket to closed in the support ticket table by ticket id and user id and company id
supportRoute.delete('/:ticketId',supportController.deleteSupportTicket)


/**
 * SuperAdmin Forward Tickets
 */
supportRoute.get('/tickets/forward',supportController.getAllforwardTickets)
supportRoute.post('/:ticketId/forward',supportController.forwardTicketToSuperAdmin)
supportRoute.get('/:ticketId/forward',supportController.forwardTicketConversations)
supportRoute.post('/:ticketId/forward/reply',supportController.forwardTicketReply)



// supportRoute.get()

export default supportRoute