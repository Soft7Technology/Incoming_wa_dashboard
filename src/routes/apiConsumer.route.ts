import { Router } from 'express';
import { authMiddleware } from '@surefy/middleware/auth.middleware';
import CompanyRoute from './company.route';
import WabaRoute from './waba.route';
import TemplateRoute from './template.route';
import MessageRoute from './message.route';
import ContactRoute from './contact.route';
import CampaignRoute from './campaign.route';

const ApiConsumerRoute = Router();

// Apply API key authentication to all API consumer routes
ApiConsumerRoute.use(authMiddleware);

// Mount all API consumer routes
ApiConsumerRoute.use('/companies', CompanyRoute);
ApiConsumerRoute.use('/waba', WabaRoute);
ApiConsumerRoute.use('/templates', TemplateRoute);
ApiConsumerRoute.use('/messages', MessageRoute);
ApiConsumerRoute.use('/contacts', ContactRoute);
ApiConsumerRoute.use('/campaigns', CampaignRoute);

export default ApiConsumerRoute;
