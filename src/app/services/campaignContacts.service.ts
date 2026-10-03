import ContactModel from '../models/contact.model';
import PhoneNumberModel from '../models/phoneNumber.model';
import contactOptOut from './contactOptOut.service';
import { parseCampaignContactQuery } from '../utils/campaignContactFilters';
import { campaignRecipientNumber } from '../utils/campaignPhone';
import { uniqueCampaignRecipients } from '../utils/campaignRecipients';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';

class CampaignContactsService {
  async eligible(userId: string, companyId: string, actorId: string, query: Record<string, unknown>) {
    if (!userId || !companyId || !actorId) throw new HTTP400Error({ message: 'User and company context are required' });
    const selection = parseCampaignContactQuery(query);
    const phone = await PhoneNumberModel.findByPhoneNumberId(selection.phoneNumberId);
    if (!phone || phone.deleted_at || phone.user_id !== userId || phone.company_id !== companyId)
      throw new HTTP404Error({ message: 'Selected sending phone number is not connected to your user account' });
    if (actorId !== userId) selection.filters.onlyAssignedToUserId = actorId;
    const [rows, excludedNumbers] = await Promise.all([
      ContactModel.findCampaignSelection(userId, companyId, phone.id, selection),
      contactOptOut.excluded(companyId, userId, phone.id),
    ]);
    const contacts = uniqueCampaignRecipients(rows.filter(contact =>
      !excludedNumbers.has(campaignRecipientNumber(contact.phone_number, contact.country_code))));
    return { total: contacts.length, contacts };
  }
}

export default new CampaignContactsService();
