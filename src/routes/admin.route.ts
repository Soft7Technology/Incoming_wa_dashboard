import { Router } from 'express';
import { jwtAuthMiddleware } from '@surefy/middleware/jwtAuth.middleware';
import WabaRoute from './waba.route';
import TemplateRoute from './template.route';
import MessageRoute from './message.route';
import CreditRoute from './credit.route';
import ContactRoute from './contact.route';
import CampaignRoute from './campaign.route';
import WebhookRoute from './webhook.route';
import UserRoute from './user.route';
import chatBotRoute from './chatbot.route';
import companyRoute from './company.route';
import SubscriptionRoute from './subscription.route';
import supportRoute from './support.route';
import teamInviteRoute from './team.route';
import ColumnRoute from './column.route';
import activityRoute from './activity.route';
import cleanupRoute from './cleanup.route';

const AdminRoute = Router();

// Apply JWT authentication to all admin routes
AdminRoute.use(jwtAuthMiddleware);

// Mount all admin routes
AdminRoute.use('/companies', companyRoute);
AdminRoute.use("/support",supportRoute)
AdminRoute.use('/subscription', SubscriptionRoute);
AdminRoute.use('/users', UserRoute);
AdminRoute.use('/waba', WabaRoute);
AdminRoute.use('/templates', TemplateRoute);
AdminRoute.use('/messages', MessageRoute);  
AdminRoute.use('/credits', CreditRoute);
AdminRoute.use('/contacts', ContactRoute);
AdminRoute.use('/campaigns', CampaignRoute);
AdminRoute.use('/webhooks', WebhookRoute);
AdminRoute.use('/chatbot',chatBotRoute ); 
AdminRoute.use('/team',teamInviteRoute)
AdminRoute.use('/columns',ColumnRoute)
AdminRoute.use('/activity',activityRoute )
AdminRoute.use('/cleanup', cleanupRoute);

export default AdminRoute;
