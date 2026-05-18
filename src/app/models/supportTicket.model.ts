import { BaseModel } from '@surefy/models/base.model';

class suppportTicketModel extends BaseModel {
  constructor() {
    super('support_tickets');
  }

  async findAllTicketByCompanyId(companyId:string){
    return this.query().where({company_id:companyId}).orderBy('created_at', 'desc')
  }

  async findForwardTicket(userId:string){
    return this.query().where({forward_superadmin:userId}).returning("*");
  }
}

export default new suppportTicketModel()