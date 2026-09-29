import { Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import activityLogsModel from '../models/activityLogs.model';
import { activityContext } from '../utils/activityContext';

const RESOURCE_ENTITY_TYPES: Readonly<Record<string, string>> = {
  contacts: 'CONTACT',
  campaigns: 'CAMPAIGN',
  chatbot: 'CHATBOT',
  team: 'TEAM',
  subscription: 'SUBSCRIPTION',
  users: 'USER',
  companies: 'COMPANY',
  messages: 'MESSAGE',
  templates: 'TEMPLATE',
  waba: 'WABA',
  webhooks: 'WEBHOOK',
  credits: 'WALLET',
  support: 'SUPPORT',
  'api-keys': 'API_KEY',
};

// Detailed domain logs take priority. Fill gaps for successful authenticated mutations.
export function recordActivity(req: JWTAuthRequest, res: Response, next: NextFunction) {
  if (!req.userId || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const endpoint = req.originalUrl.split('?')[0];
  if (/\/activity(?:\/|$)/.test(endpoint)) return next();
  const context = {
    userId: req.userId,
    companyId: req.companyId,
    recorded: false,
    request_method: req.method,
    api_endpoint: endpoint,
    ip_address: req.ip || req.socket.remoteAddress || '',
    user_agent: (req.headers['user-agent'] || '').slice(0, 500),
  };
  activityContext.run(context, () => {
    // Fallback persistence is best-effort after the response. Critical audit records
    // must be written with their domain transaction; an outbox is needed for guaranteed delivery.
    res.once('finish', () => {
      if (context.recorded || res.statusCode < 200 || res.statusCode >= 300) return;
      const action = req.method === 'DELETE' ? 'DELETE' : req.method === 'POST' ? 'CREATE' : 'UPDATE';
      const resource = endpoint.match(/\/(?:admin|api)\/([^/]+)/)?.[1] || '';
      // Do not record request/response bodies, query strings, tokens, or passwords.
      void activityLogsModel
        .create({
          user_id: context.userId,
          company_id: context.companyId,
          action,
          entity_type: RESOURCE_ENTITY_TYPES[resource] || 'API_REQUEST',
          read: false,
          status: 'SUCCESS',
          description: `${req.method} ${endpoint}`,
          request_method: context.request_method,
          api_endpoint: endpoint,
          ip_address: context.ip_address,
          user_agent: context.user_agent,
        })
        .catch((error: unknown) =>
          console.error('Failed to record request activity:', error instanceof Error ? error.message : 'Unknown error'),
        );
    });
    next();
  });
}
