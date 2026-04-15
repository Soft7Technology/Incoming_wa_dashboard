import { BaseModel } from '@surefy/models/base.model';

class CompanyModel extends BaseModel {
  constructor() {
    super('companies');
  }

  async findByApiKey(apiKey: string) {
    return this.query().where({ api_key: apiKey, status: 'active' }).first();
  }

  async findByEmail(email: string) {
    return this.query().where({ email }).first();
  }

  async getUserStats(userId: string) {
    return this.query()
      .select(
        // campaigns
        this.query().from('campaigns').count('*').where('user_id', userId).as('campaigns_count'),

        // contact_lists
        this.query().from('contacts').count('*').where('user_id', userId).as('contacts_count'),

        // contact_lists
        this.query().from('contact_lists').count('*').where('user_id', userId).as('contact_lists_count'),

        // messages - SENT
        this.query().from('messages').count('*').where('user_id', userId).andWhere('status', 'sent').as('sent_count'),

        // messages - FAILED
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('status', 'failed')
          .as('failed_count'),

        // messages - DELIVERED
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('status', 'delivered')
          .as('delivered_count'),

        // messages - SENT
        this.query()
          .from('messages')
          .count('*')
          .where('user_id', userId)
          .andWhere('type', 'template')
          .as('message_template_count'),

        this.query().from('messages').countDistinct('to_phone').where('user_id', userId).as('unique_contacts_count'),

        // templates
        this.query()
          .from('templates')
          .count('*')
          .where('user_id', (qb: any) => {
            qb.select('user_id').from('users').where('user_id', userId).limit(1);
          })
          .as('templates_count'),
      )
      .first()
      .then((res: any) => ({
        ...res,
        total_messages: Number(res.sent_count) + Number(res.failed_count) + Number(res.delivered_count),
      }));
  }

  async updateCreditBalance(companyId: string, amount: number) {
    return this.query().where({ id: companyId }).increment('credit_balance', amount).returning('*');
  }

  async getDashboardStats(companyId: string) {
    return this.query()
      .select(
        // campaigns
        this.query().from('campaigns').count('*').where('company_id', companyId).as('campaigns_count'),

        // contacts
        this.query().from('contacts').count('*').where('company_id', companyId).as('contacts_count'),

        // contact_lists
        this.query().from('contact_lists').count('*').where('company_id', companyId).as('contact_lists_count'),

        // users
        this.query().from('users').count('*').where('company_id', companyId).as('users_count'),

        // messages - SENT
        this.query()
          .from('messages')
          .count('*')
          .where('company_id', companyId)
          .andWhere('status', 'sent')
          .as('sent_count'),

        // messages - FAILED
        this.query()
          .from('messages')
          .count('*')
          .where('company_id', companyId)
          .andWhere('status', 'failed')
          .as('failed_count'),

        // messages - DELIVERED
        this.query()
          .from('messages')
          .count('*')
          .where('company_id', companyId)
          .andWhere('status', 'delivered')
          .as('delivered_count'),

        // template messages
        this.query()
          .from('messages')
          .count('*')
          .where('company_id', companyId)
          .andWhere('type', 'template')
          .as('message_template_count'),

        // unique contacts (distinct phone)
        this.query()
          .from('messages')
          .countDistinct('to_phone')
          .where('company_id', companyId)
          .as('unique_contacts_count'),

        // templates
        this.query().from('templates').count('*').where('company_id', companyId).as('templates_count'),
      )
      .first()
      .then((res: any) => ({
        ...res,
        total_messages: Number(res.sent_count) + Number(res.failed_count) + Number(res.delivered_count),
      }));
  }
}

export default new CompanyModel();
