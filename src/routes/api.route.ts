import { Router } from 'express';
import AuthRoute from './auth.route';
import AdminRoute from './admin.route';
import ApiConsumerRoute from './apiConsumer.route';
import WebhookPublicRoute from './webhookPublic.route';

const ApiRoute = Router();

/**
 * Route Structure:
 * - /v1/auth/* - Authentication routes (login, register)
 * - /v1/admin/* - JWT-protected routes for admin/company dashboard users
 * - /v1/api/* - API key protected routes for external API consumers
 * - /v1/webhooks/* - Public webhook endpoints (Meta webhooks)
 *
 * User Flow:
 * 1. Admin creates company + initial user via POST /v1/admin/companies (JWT required, includes user credentials)
 * 2. Admin shares login credentials with company user
 * 3. Company user logs in via POST /v1/auth/login (gets JWT token)
 * 4. Company user connects WhatsApp Business account via POST /v1/admin/waba (JWT required)
 */

// Public routes - no authentication
ApiRoute.use('/auth', AuthRoute); // Login, register

// Public webhook routes - no authentication (Meta webhooks validated with their own signature)
ApiRoute.use('/webhooks', WebhookPublicRoute);

// Admin routes - JWT authentication required (for dashboard users)
ApiRoute.use('/admin', AdminRoute);

// API Consumer routes - API key authentication required (for programmatic access)
ApiRoute.use('/api', ApiConsumerRoute);



export default ApiRoute;
