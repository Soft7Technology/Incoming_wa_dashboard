import axios from 'axios';
import { FlowScope, fail } from '../utils/automationFlow';
import { AutomationFlowService } from './automationFlow.service';

export class AutomationProvider {
  constructor(private readonly flows: AutomationFlowService) {}
  async execute(scope: FlowScope, step: any, parameters: Record<string, any>, runId: string) {
    const connection = await this.flows.connectionFor(scope, step.appKey, step.connectionId);
    const ownerScope = { companyId: scope.companyId!, ownerId: scope.userId!, userId: scope.userId! };
    if (step.appKey === 'shopify') return (await import('./shopify.service')).default.automation(ownerScope, connection.id, step.key, parameters);
    if (step.appKey === 'google-sheets') return (await import('./googleSheets.service')).default.automation(ownerScope, connection.id, step.key, parameters);
    if (step.appKey !== 'razorpay') fail(400, 'Unsupported flow integration');
    const credentials = this.flows.credentials(connection);
    const create = step.key === 'createPaymentLink';
    if (!create && step.key !== 'getPaymentLink') fail(400, 'Unsupported Razorpay flow action');
    if (!create && (typeof parameters.payment_link_id !== 'string' || !/^plink_[A-Za-z0-9]+$/.test(parameters.payment_link_id))) fail(400, 'Invalid Razorpay payment link ID');
    if (create && parameters.amount_paise < 100) fail(400, 'Payment link amount must be at least 100 paise');
    const { hash } = await import('../utils/automationFlow');
    const reference = `af_${hash(`${runId}:${step._id}`).slice(0, 32)}`;
    let result: any;
    try {
      const response = await axios.request({
        method: create ? 'POST' : 'GET', baseURL: 'https://api.razorpay.com/v1', url: create ? '/payment_links' : `/payment_links/${encodeURIComponent(parameters.payment_link_id)}`,
        auth: { username: credentials.key_id, password: credentials.key_secret }, timeout: 20000, maxRedirects: 0, maxContentLength: 256 * 1024, maxBodyLength: 128 * 1024,
        ...(create ? { data: { amount: parameters.amount_paise, currency: 'INR', accept_partial: false, description: parameters.description,
          reference_id: reference, notify: { sms: false, email: false }, reminder_enable: false,
          customer: { ...(parameters.customer_name ? { name: parameters.customer_name } : {}), ...(parameters.customer_email ? { email: parameters.customer_email } : {}), ...(parameters.customer_contact ? { contact: parameters.customer_contact } : {}) },
        } } : {}),
      });
      result = response.data;
    } catch { return fail(502, 'Razorpay action failed; check the connection and provider dashboard before retrying a write'); }
    if (!result || typeof result.id !== 'string' || !/^plink_[A-Za-z0-9]+$/.test(result.id) || (create && (result.amount !== parameters.amount_paise || result.currency !== 'INR' || result.reference_id !== reference))) fail(502, 'Razorpay returned an unexpected payment link response');
    return { id: result.id, short_url: result.short_url, status: result.status, amount: result.amount, amount_paid: result.amount_paid, currency: result.currency, reference_id: result.reference_id, created_at: result.created_at, mode: connection.mode };
  }
}
