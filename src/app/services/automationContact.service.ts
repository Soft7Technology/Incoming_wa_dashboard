import ContactModel from '../models/contact.model';
import planUsage from './planUsage.service';
import { parseStoredContactPhone } from '../utils/importPhone';
import { FlowScope, fail } from '../utils/automationFlow';

/** Find/create in the same owner + company + sending-number scope as Contacts. */
export class AutomationContactService {
  constructor(private readonly contacts = ContactModel, private readonly usage = planUsage) {}

  private lookup(scope: FlowScope, phone: any, to: string) {
    if (!scope.userId || !scope.companyId || phone.user_id !== scope.userId || phone.company_id !== scope.companyId || phone.status !== 'active' || phone.deleted_at)
      fail(404, 'Select an active WhatsApp number from your account');
    const identity = parseStoredContactPhone(`+${to}`);
    if (!identity.is_valid) fail(400, 'A valid international recipient number is required');
    const find = () => this.contacts.findOwnedByPhone(scope.userId!, identity.phone_number, phone.id, scope.companyId!, identity.country_code);
    return { identity, find };
  }

  private reused(contact: any) {
    if (contact.is_opted_out) fail(409, 'The recipient has opted out of messages from this number');
    return { contact, created: false };
  }

  /** Check capacity without creating anything during flow preflight. */
  async check(scope: FlowScope, phone: any, to: string) {
    const { find } = this.lookup(scope, phone, to);
    const existing = await find();
    if (existing) return this.reused(existing);
    await this.usage.assert(scope.userId!, 'Contact');
    return null;
  }

  async ensure(scope: FlowScope, phone: any, to: string, details: { name?: string; email?: string } = {}) {
    const { identity, find } = this.lookup(scope, phone, to);
    const existing = await find();
    if (existing) return this.reused(existing);

    try {
      const contact = await this.usage.run(scope.userId!, 'Contact', trx => this.contacts.create({
        user_id: scope.userId,
        company_id: scope.companyId,
        phone_number_id: phone.id,
        phone_number: identity.phone_number,
        country_code: identity.country_code,
        name: details.name || identity.phone_number,
        ...(details.email ? { email: details.email } : {}),
        source: 'whatsApp',
        attributes: { source: 'automation' },
      }, trx));
      return { contact, created: true };
    } catch (error: any) {
      // Model.create serializes duplicate phone identities. A concurrent create
      // can also use the final plan slot before our quota transaction starts.
      if ([400, 403].includes(error?.statusCode) || error?.code === '23505') {
        const concurrent = await find();
        if (concurrent) return this.reused(concurrent);
      }
      throw error;
    }
  }
}

export default new AutomationContactService();
