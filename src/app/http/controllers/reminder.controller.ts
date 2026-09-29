import { Response } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync, successResponse } from '@surefy/utils/Controller';
import ReminderService from '../../services/reminder.service';
import { ReminderScope } from '../../interfaces/reminder.interface';

/** Keep authentication context separate from client-supplied schedule fields. */
function requestScope(req: JWTAuthRequest): ReminderScope {
  return { companyId: req.companyId!, ownerId: (req.ownerId ?? req.userId)!, actorId: req.userId! };
}

class ReminderController {
  getTemplates = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.templates(scope, req.query.phone_number_id as string);
    return successResponse(req, res, 'Approved reminder templates', result);
  });

  preview = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.preview(scope, req.body);
    return successResponse(req, res, 'Reminder preview', result);
  });

  getReminders = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.list(scope, req.query);
    return successResponse(req, res, 'Reminders retrieved', result);
  });

  getReminder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.get(scope, req.params.id);
    return successResponse(req, res, 'Reminder retrieved', result);
  });

  createReminder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = Object.prototype.hasOwnProperty.call(req.body ?? {}, 'contact_ids')
      ? await ReminderService.createBulk(scope, req.body)
      : await ReminderService.create(scope, req.body);
    return successResponse(req, res, 'Reminder created', result);
  });

  updateReminder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.update(scope, req.params.id, req.body);
    return successResponse(req, res, 'Reminder updated', result);
  });

  getHistory = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.history(scope, req.params.id, req.query);
    return successResponse(req, res, 'Reminder history retrieved', result);
  });

  pauseReminder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.action(scope, req.params.id, 'pause');
    return successResponse(req, res, 'Reminder paused', result);
  });

  resumeReminder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.action(scope, req.params.id, 'resume');
    return successResponse(req, res, 'Reminder resumed', result);
  });

  cancelReminder = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const scope = requestScope(req);
    const result = await ReminderService.action(scope, req.params.id, 'cancel');
    return successResponse(req, res, 'Reminder cancelled', result);
  });
}
export default new ReminderController();
