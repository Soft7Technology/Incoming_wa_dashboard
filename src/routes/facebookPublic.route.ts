import { Router } from 'express';
import facebookOAuthController from '../app/http/controllers/facebookOAuth.controller';
import facebookWebhookController from '../app/http/controllers/facebookWebhook.controller';
// import facebookPrivacyController from '../app/http/controllers/facebookPrivacy.controller';

const facebookPublicRoute = Router();

facebookPublicRoute.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  res.set('Referrer-Policy', 'no-referrer');
  next();
});

// OAuth callbacks
facebookPublicRoute.get(
  '/leads/oauth/callback',
  facebookOAuthController.leadsCallback,
);


// Webhook verification
facebookPublicRoute.get(
  '/leads/webhook',
  facebookWebhookController.verifyLeads,
);

// Webhook events
facebookPublicRoute.post(
  '/leads/webhook',
  facebookWebhookController.receiveLeads,
);


facebookPublicRoute.get(
  '/messaging/oauth/callback',
  facebookOAuthController.messagingCallback,
);


facebookPublicRoute.get(
  '/messaging/webhook',
  facebookWebhookController.verifyMessaging,
);

facebookPublicRoute.post(
  '/messaging/webhook',
  facebookWebhookController.receiveMessaging,
);

// // App removal
// facebookPublicRoute.post(
//   '/leads/deauthorize',
//   facebookPrivacyController.deauthorizeLeads,
// );

// facebookPublicRoute.post(
//   '/messaging/deauthorize',
//   facebookPrivacyController.deauthorizeMessaging,
// );

// // Data deletion
// facebookPublicRoute.post(
//   '/leads/data-deletion',
//   facebookPrivacyController.deleteLeadsData,
// );

// facebookPublicRoute.post(
//   '/messaging/data-deletion',
//   facebookPrivacyController.deleteMessagingData,
// );

// facebookPublicRoute.get(
//   '/leads/data-deletion/status/:confirmation',
//   facebookPrivacyController.leadsDeletionStatus,
// );

// facebookPublicRoute.get(
//   '/messaging/data-deletion/status/:confirmation',
//   facebookPrivacyController.messagingDeletionStatus,
// );

export default facebookPublicRoute;