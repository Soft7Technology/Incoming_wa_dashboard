import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/support.service';

const scope = (req: JWTAuthRequest) => ({ userId: req.userId, companyId: req.companyId });

/** Existing support URLs retain their response envelopes and use the live authorization rules. */
class SupportController {
  createTicket = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Ticket raised successfully', await service.create(scope(req), req.body, 'ticket')));
  getAllTickets = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.list(scope(req), { ...req.query, limit: req.query.limit ?? '100' });
    return successResponse(req, res, 'Tickets retrieved successfully', result.items);
  });
  getSupportTicket = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Support ticket retrieved successfully', await service.get(scope(req), req.params.supportTicket)));
  getTicketConversation = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.messages(scope(req), req.params.ticketId, { ...req.query, limit: req.query.limit ?? '100' });
    return successResponse(req, res, 'Conversation retrieved successfully', result.items);
  });
  replyToConversation = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Reply sent successfully', await service.reply(scope(req), req.params.ticketId, req.body)));
  resolveTicket = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Ticket resolved successfully', await service.status(scope(req), req.params.ticketId, 'resolved')));
  closeTicket = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Ticket closed successfully', await service.status(scope(req), req.params.ticketId, 'closed')));
  deleteSupportTicket = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    successResponse(req, res, 'Ticket deleted successfully', await service.remove(scope(req), req.params.ticketId)));
}

export default new SupportController();
