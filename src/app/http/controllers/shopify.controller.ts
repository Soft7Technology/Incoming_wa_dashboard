import { Request, Response, NextFunction } from 'express';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { tryCatchAsync } from '@surefy/utils/Controller';
import service from '../../services/shopify.service';
import messaging from '../../services/shopifyMessaging.service';
import flowWebhooks from '../../services/shopifyFlowWebhook.service';
import { configuration, topics, retentionDays, privacyIdentity } from '../../utils/shopify';

const scope = (req: JWTAuthRequest) => ({
  companyId: req.companyId!,
  ownerId: (req.ownerId ?? req.userId)!,
  userId: req.userId!,
});
export const noStore = (_req: Request, res: Response, next: NextFunction) => {
  res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', 'Referrer-Policy': 'no-referrer' });
  next();
};
const browser = (req: Request) =>
  req.headers.cookie
    ?.split(';')
    .map((s) => s.trim())
    .find((s) => s.startsWith('shopify_browser='))
    ?.slice('shopify_browser='.length);

class ShopifyController {
  createTestFlow = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.status(201).json({ success: true, data: await flowWebhooks.create(scope(req), req.params.id, req.body) }),
  );
  testFlowSettings = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await flowWebhooks.settings(scope(req), req.params.id, req.params.flowId) }),
  );
  receiveTestFlow = tryCatchAsync(async (req: Request, res: Response) => {
    const result = await flowWebhooks.receive(
      req.params.flowId,
      req.params.token,
      (req as Request & { rawBody?: Buffer }).rawBody,
      req.headers['x-shopify-hmac-sha256'],
      req.headers,
    );
    res.json({ success: true, data: result });
  });
  testFlowStatus = tryCatchAsync(async (req: Request, res: Response) => {
    const result = await flowWebhooks.status(req.params.flowId, req.params.token);
    if (req.query.format === 'json') return res.json({ success: true, data: result });
    const escape = (s: unknown) =>
      String(s).replace(
        /[&<>"']/g,
        (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
      );
    const eventLabel =
      result.expected_topic === '*' ? 'Order, customer, cart and checkout test events' : result.expected_topic;
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res
      .type('html')
      .send(
        `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shopify webhook test</title><link rel="stylesheet" href="/v1/integrations/shopify/test.css"></head><body><main><h1>Shopify webhook test</h1><section class="card"><p>Flow: <code>${escape(result.flow_id)}</code></p><p>Events: <strong>${escape(eventLabel)}</strong></p><p>Events received: <strong>${result.received}</strong></p><p>Last event: ${escape(result.last_received_topic || 'Waiting for your Shopify test')}</p><p>Last receipt: ${escape(result.last_received_at || 'Waiting for your Shopify test')}</p><p>Expires: ${escape(new Date(result.expires_at).toISOString())}</p><p>In Shopify, select a supported event and JSON, paste this page's URL and choose Send test. Refresh this page or the signed-in event inbox to check the receipt.</p><p>This flow records test receipts. It does not send WhatsApp messages or execute chatbot nodes. Customer details are available only in the signed-in owner's event inbox.</p></section></main></body></html>`,
      );
  });
  setup = tryCatchAsync(async (_req: Request, res: Response) => {
    let ready = true,
      issue: string | null = null,
      days: number | null = null;
    try {
      configuration();
      days = retentionDays();
    } catch (error) {
      ready = false;
      issue = error instanceof Error ? error.message : 'Invalid Shopify configuration.';
    }
    let testUrl: string | null = null;
    try {
      testUrl = new URL('/v1/integrations/shopify/test', process.env.SHOPIFY_REDIRECT_URI).toString();
    } catch {}
    res.json({
      success: true,
      data: {
        ready,
        issue,
        test_url: testUrl,
        app_url: testUrl?.replace(/\/test$/, '/app') || null,
        privacy_url: testUrl?.replace(/\/test$/, '/privacy') || null,
        retention_days: days,
        redirect_uri: process.env.SHOPIFY_REDIRECT_URI || null,
        login_domain:
          process.env.SHOPIFY_TEST_LOGIN_DOMAIN || (process.env.NODE_ENV !== 'production' ? 'localhost' : ''),
        scopes: (process.env.SHOPIFY_SCOPES || 'read_orders,read_customers').split(','),
        triggers: Object.entries(topics).map(([topic, value]) => ({
          topic,
          label: value.label,
          required_scope: value.scope,
        })),
      },
    });
  });
  start = tryCatchAsync(async (req: JWTAuthRequest, res: Response) => {
    const result = await service.start(scope(req), req.body),
      secure = configuration().secure;
    res.cookie('shopify_browser', result.browser, {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/v1/integrations/shopify',
      maxAge: 600000,
    });
    res.json({ success: true, data: { authorization_url: result.authorization_url } });
  });
  callback = tryCatchAsync(async (req: Request, res: Response) => {
    res.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    await service.callback(req.query as Record<string, unknown>, browser(req));
    const secure = configuration().secure;
    res.clearCookie('shopify_browser', {
      httpOnly: true,
      secure,
      sameSite: secure ? 'none' : 'lax',
      path: '/v1/integrations/shopify',
    });
    // Fixed relative destination: never reflect an OAuth query or a caller-supplied return URL.
    res.redirect(303, '/v1/integrations/shopify/app');
  });
  connections = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: { connections: await service.connections(scope(req)) } }),
  );
  triggers = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.saveTriggers(scope(req), req.params.id, req.body?.topics) }),
  );
  sync = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.sync(scope(req), req.params.id) }),
  );
  disconnect = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.disconnect(scope(req), req.params.id) }),
  );
  events = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.events(scope(req), req.params.id) }),
  );
  event = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.event(scope(req), req.params.id, req.params.eventId) }),
  );
  privacyRequests = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await service.privacyRequests(scope(req), req.params.id) }),
  );
  messagingSettings = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await messaging.settings(scope(req), req.params.id, req.query.phone_number_id) }),
  );
  messagingRule = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await messaging.saveRule(scope(req), req.params.id, req.body?.topic, req.body) }),
  );
  messagingJobs = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({ success: true, data: await messaging.jobs(scope(req), req.params.id) }),
  );
  privacyExport = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({
      success: true,
      data: await service.privacyExport(
        scope(req),
        req.params.id,
        req.params.requestId,
        req.query.after,
        req.query.section,
      ),
    }),
  );
  completePrivacyRequest = tryCatchAsync(async (req: JWTAuthRequest, res: Response) =>
    res.json({
      success: true,
      data: await service.completePrivacyRequest(scope(req), req.params.id, req.params.requestId, req.body?.delivered),
    }),
  );
  privacy = tryCatchAsync(async (_req: Request, res: Response) => {
    const identity = privacyIdentity();
    const escape = (value: string) =>
      value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'");
    res.type('html')
      .send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Shopify integration privacy | ${escape(identity.controller)}</title><link rel="stylesheet" href="/v1/integrations/shopify/test.css"></head><body><main>
      <a href="/v1/integrations/shopify/app">Back to the app</a><h1>Shopify integration privacy</h1>
      <p>Provided by ${escape(identity.controller)}. Updated 17 October 2026.</p>
      <section class="card"><h2>Data and purpose</h2><p>We process store connection information and merchant-selected order and customer events to show updates in the merchant's event inbox. Stored event contents are limited to resource and customer identifiers, order status and event timestamps. Customer names, addresses, contact values, notes and line items are excluded from that inbox. Shopify credentials and event contents are encrypted before storage.</p>
      <p>Keyed hashes of identifiers and any supplied email or phone values are retained solely to match customer access and deletion requests. These hashes are not readable contact values. Shopify and the hosting infrastructure process information necessary to operate this integration. This integration does not sell customer data, use it for advertising, or send marketing messages.</p>
      <h2>Optional WhatsApp order updates</h2><p>When the merchant enables an order-message rule, the integration uses the customer's default, customer-record or billing phone number to send an approved utility template through Meta's WhatsApp Business Platform. Your store must record customer consent to business order messages in the configured order attribute; a phone number or order alone is not consent. Existing opt-outs are respected.</p>
      <p>Queued recipient numbers, order fields and consent indicators are stored in encrypted message jobs. Sent messages also appear in the business's existing WhatsApp message history. Shopify-derived jobs and linked outbound history follow the integration's retention and customer-erasure controls. A message already transmitted to WhatsApp or its recipient cannot be recalled by deleting local data. Meta processes the recipient number and message content to provide delivery.</p></section>
      <section class="card"><h2>Retention and deletion</h2><p>Event data is scheduled for deletion after ${retentionDays()} days. Data needed to fulfil an outstanding privacy request is held until that request is completed. Completed request receipts and deletion-suppression hashes are retained for up to 30 days; protected-data access logs for up to 90 days. Deletion-suppression hashes prevent recently deleted data from being stored again. Expired data is hidden from the ordinary event inbox while cleanup runs. Privacy maintenance runs every minute when the API is running.</p>
      <p>Disconnecting stops subscriptions and clears credentials. Uninstalling clears credentials, and store records are removed on Shopify's shop-erasure request or by the scheduled 48-hour fallback. Backup retention and recovery must also respect the merchant's deletion request.</p></section>
      <section class="card"><h2>Customer rights</h2><p>Customers should contact their merchant to request access or deletion. The integration accepts Shopify's customer-access, customer-erasure and shop-erasure webhooks. The merchant account owner can download matching retained data and confirm delivery to the merchant. Requests must be completed within 30 days; pending and overdue requests appear in the app. Customer erasures are processed by scheduled maintenance.</p>
      <p>Contact ${escape(identity.controller)} at <a href="mailto:${escape(identity.email)}">${escape(identity.email)}</a> about this integration's data processing.</p></section>
      <p>This disclosure covers this Shopify integration. The merchant's own privacy policy and agreements describe the merchant's processing of customer data.</p>
      </main></body></html>`);
  });
  receive = tryCatchAsync(async (req: Request, res: Response) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody;
    const result = await service.receive(
      raw,
      req.headers['x-shopify-hmac-sha256'],
      req.headers,
      req.params.id,
      req.params.token,
    );
    res.status(200).json({ success: true, data: result });
  });
}
export default new ShopifyController();
