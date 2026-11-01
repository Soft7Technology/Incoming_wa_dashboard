import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync } from '@surefy/utils/Controller';
import { CustomError } from '@surefy/exceptions/CustomError';
import { uuidPattern } from '../../utils/facebook';
import facebookMessagingService from '../../services/facebookMessaging.service';

function readUuid(value: unknown, name: string): string {
  if (typeof value !== 'string' || !uuidPattern.test(value)) {
    throw new CustomError(`A valid ${name} is required.`, 400);
  }
  return value;
}

function readInteger(value: unknown, fallback: number, maximum: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)) {
    throw new CustomError(`${name} must be a positive integer.`, 400);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number > maximum) {
    throw new CustomError(`${name} must be between 1 and ${maximum}.`, 400);
  }
  return number;
}

function readPagination(req: JWTAuthRequest, defaultLimit: number) {
  const limit = readInteger(req.query.limit, defaultLimit, 100, 'limit');
  const page = readInteger(req.query.page, 1, Number.MAX_SAFE_INTEGER, 'page');
  if (!Number.isSafeInteger((page - 1) * limit)) {
    throw new CustomError('The requested page is too large.', 400);
  }
  return { page, limit };
}

function readScope(req: JWTAuthRequest) {
  if (!req.companyId || !req.userId) {
    throw new CustomError('Company and user context are required.', 403);
  }
  return { companyId: req.companyId, userId: req.userId, ownerId: req.ownerId || req.userId };
}

class FacebookMessagingController {
  sendMessage = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const id = readUuid(req.params.conversationId, 'conversationId');
    const requestId = readUuid(req.body?.client_request_id, 'client_request_id');
    const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
    if (!text || Array.from(text).length > 2000) {
      throw new CustomError('Message text must contain between 1 and 2000 characters.', 400);
    }
    const result = await facebookMessagingService.sendMessage(id, readScope(req), text, requestId);
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: result });
  });

  listConversations = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const id = readUuid(req.params.pageConnectionId, 'pageConnectionId');
    const result = await facebookMessagingService.listConversations(id, readScope(req), readPagination(req, 25));
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: result });
  });

  listMessages = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const id = readUuid(req.params.conversationId, 'conversationId');
    const result = await facebookMessagingService.listMessages(id, readScope(req), readPagination(req, 50));
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({ success: true, data: result });
  });
}

export default new FacebookMessagingController();
