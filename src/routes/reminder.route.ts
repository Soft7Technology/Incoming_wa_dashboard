import { Router } from 'express';
import { requireRole } from '@surefy/middleware/jwtAuth.middleware';
import { accountScope } from '../app/http/middleware/accountScope';
import ReminderController from '../app/http/controllers/reminder.controller';

const ReminderRoute = Router();
ReminderRoute.use(accountScope);

// Register static paths before the reminder ID routes.
ReminderRoute.get('/summary', ReminderController.getSummary);
ReminderRoute.get('/templates', ReminderController.getTemplates);
ReminderRoute.post('/preview', ReminderController.preview);
ReminderRoute.get('/', ReminderController.getReminders);
ReminderRoute.get('/:id/history', ReminderController.getHistory);
ReminderRoute.get('/:id', ReminderController.getReminder);

// Only account owners and team members may change reminder schedules.
ReminderRoute.post('/', requireRole('user', 'member'), ReminderController.createReminder);
ReminderRoute.put('/:id', requireRole('user', 'member'), ReminderController.updateReminder);
ReminderRoute.post('/:id/pause', requireRole('user', 'member'), ReminderController.pauseReminder);
ReminderRoute.post('/:id/resume', requireRole('user', 'member'), ReminderController.resumeReminder);
ReminderRoute.post('/:id/cancel', requireRole('user', 'member'), ReminderController.cancelReminder);

export default ReminderRoute;
