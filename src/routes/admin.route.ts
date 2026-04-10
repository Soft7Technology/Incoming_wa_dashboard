import { Router } from 'express';
import { jwtAuthMiddleware } from '@surefy/middleware/jwtAuth.middleware';
import WabaRoute from './waba.route';
import TemplateRoute from './template.route';
import MessageRoute from './message.route';
import CreditRoute from './credit.route';
import ContactRoute from './contact.route';
import CampaignRoute from './campaign.route';
import WebhookRoute from './webhook.route';
import UserRoute from './company.route';
import chatBotRoute from './chatbot.route';

const AdminRoute = Router();

// Apply JWT authentication to all admin routes
AdminRoute.use(jwtAuthMiddleware);

// Mount all admin routes
AdminRoute.use('/users', UserRoute);
AdminRoute.use('/waba', WabaRoute);
AdminRoute.use('/templates', TemplateRoute);
AdminRoute.use('/messages', MessageRoute);
AdminRoute.use('/credits', CreditRoute);
AdminRoute.use('/contacts', ContactRoute);
AdminRoute.use('/campaigns', CampaignRoute);
AdminRoute.use('/webhooks', WebhookRoute);
AdminRoute.use('/chatbot',chatBotRoute ); 


export default AdminRoute;
