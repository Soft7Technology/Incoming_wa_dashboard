import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { Response } from 'express';
import { tryCatchAsync, successResponse } from '@surefy/utils/Controller';
import service, { OptOutScope } from '../../services/contactOptOut.service';

function requestScope(req: JWTAuthRequest): OptOutScope {
  return { companyId: req.companyId || '', ownerId: req.ownerId ?? req.userId ?? '', actorId: req.userId || '' };
}

class ContactOptOutController {
  getKeywords = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const settings = await service.getKeywords(requestScope(req), String(req.params.phoneNumberId));
    return successResponse(req, res, 'Opt-in/out keywords', settings);
  });

  updateKeywords = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const settings = await service.updateKeywords(requestScope(req), String(req.params.phoneNumberId), req.body);
    return successResponse(req, res, 'Keywords updated', settings);
  });

  updateContact = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const contact = await service.updateContact(requestScope(req), String(req.params.id), req.body?.is_opted_out);
    return successResponse(req, res, 'Contact preference updated', contact);
  });
}
export default new ContactOptOutController();
