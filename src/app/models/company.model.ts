import { BaseModel } from '@surefy/models/base.model';

class CompanyModel extends BaseModel {
  constructor() {
    super('companies');
  }

  async findById(id: string) {
    return this.query().where({ id }).whereNull('deleted_at').first();
  }

  async findAll(conditions: any = {}) {
    return this.query().where(conditions).whereNull('deleted_at');
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

        // this.query().from("users").where('user_id' , userId).as("user_details"),

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

  async userDetails(userId:string){

  }

  async updateCreditBalance(companyId: string, amount: number) {
    return this.query().where({ id: companyId }).increment('credit_balance', amount).returning('*');
  }

  async findCompanies(status:any){
    return this.query().where({status:status}).whereNull('deleted_at');
  }

  // async getDashboardStats(companyId: string,userId?:string,role?:string) {
  //   console.log("Fetching dashboard stats for companyId:", companyId); // Debug log
  //   return this.query()
  //     .select(
  //       // campaigns
  //       this.query().from('campaigns').count('*').where('company_id', companyId).as('campaigns_count'),

  //       //chatbots
  //       this.query().from("chat_bot").count("*").where("user_id",userId).as("chatbot_count"),

  //       // contacts
  //       this.query().from('contacts').count('*').where('company_id', companyId).as('contacts_count'),

  //       // contact_lists
  //       this.query().from('contact_lists').count('*').where('company_id', companyId).as('contact_lists_count'),

  //       // users
  //       this.query().from('users').count('*').where('company_id', companyId).as('users_count'),

  //       // Tags
  //       this.query().from('contact_tags').count('*').where('company_id', companyId).as('contact_tags_count'),

  //       // messages - SENT
  //       this.query()
  //         .from('messages')
  //         .count('*')
  //         .where('company_id', companyId)
  //         .andWhere('status', 'sent')
  //         .as('sent_count'),

  //       // messages - FAILED
  //       this.query()
  //         .from('messages')
  //         .count('*')
  //         .where('company_id', companyId)
  //         .andWhere('status', 'failed')
  //         .as('failed_count'),

  //       // messages - DELIVERED
  //       this.query()
  //         .from('messages')
  //         .count('*')
  //         .where('company_id', companyId)
  //         .andWhere('status', 'delivered')
  //         .as('delivered_count'),

  //       // template messages
  //       this.query()
  //         .from('messages')
  //         .count('*')
  //         .where('company_id', companyId)
  //         .andWhere('type', 'template')
  //         .as('message_template_count'),

  //       // unique contacts (distinct phone)
  //       this.query()
  //         .from('messages')
  //         .countDistinct('to_phone')
  //         .where('company_id', companyId)
  //         .as('unique_contacts_count'),

  //       // templates
  //       this.query().from('templates').count('*').where('company_id', companyId).as('templates_count'),
  //     )
  //     .first()
  //     .then((res: any) => ({
  //       ...res,
  //       total_messages: Number(res.sent_count) + Number(res.failed_count) + Number(res.delivered_count),
  //     }));
  // }

  async getDashboardStats(companyId?: string, userId?: string, role?: string) {
  const isSuperAdmin = role === 'superadmin';

  // 🔐 Safety: if NOT superadmin, companyId must exist
  if (!isSuperAdmin && !companyId) {
    throw new Error("company_id is required for non-superadmin users");
  }

  const applyCompanyFilter = (query: any) => {
    if (!isSuperAdmin) {
      query.where('company_id', companyId);
    }
    return query;
  };

  return this.query()
    .select(
      // campaigns
      applyCompanyFilter(
        this.query().from('campaigns').count('*')
      ).as('campaigns_count'),

      // chatbots
      this.query()
        .from("chat_bot")
        .modify((q: any) => {
          if (!isSuperAdmin) {
            q.where("user_id", userId); // or company आधारित भी कर सकते हो
          }
        })
        .count("*")
        .as("chatbot_count"),

      // contacts
      applyCompanyFilter(
        this.query().from('contacts').count('*')
      ).as('contacts_count'),

      // contact_lists
      applyCompanyFilter(
        this.query().from('contact_lists').count('*')
      ).as('contact_lists_count'),

      // users
      applyCompanyFilter(
        this.query().from('users').count('*')
      ).as('users_count'),

      // tags
      applyCompanyFilter(
        this.query().from('contact_tags').count('*')
      ).as('contact_tags_count'),

      // sent
      applyCompanyFilter(
        this.query().from('messages').count('*').where('status', 'sent')
      ).as('sent_count'),

      // failed
      applyCompanyFilter(
        this.query().from('messages').count('*').where('status', 'failed')
      ).as('failed_count'),

      // delivered
      applyCompanyFilter(
        this.query().from('messages').count('*').where('status', 'delivered')
      ).as('delivered_count'),

      // template messages
      applyCompanyFilter(
        this.query().from('messages').count('*').where('type', 'template')
      ).as('message_template_count'),

      // unique contacts
      applyCompanyFilter(
        this.query().from('messages').countDistinct('to_phone')
      ).as('unique_contacts_count'),

      // templates
      applyCompanyFilter(
        this.query().from('templates').count('*')
      ).as('templates_count'),
    )
    .first()
    .then((res: any) => ({
      ...res,
      total_messages:
        Number(res.sent_count) +
        Number(res.failed_count) +
        Number(res.delivered_count),
    }));
}
  
}

export default new CompanyModel();
