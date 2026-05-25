import { BaseModel } from '@surefy/models/base.model';

class UserTeamModel extends BaseModel {
  constructor() {
    super('user_team');
  }

  async findAllTicketByCompanyId(companyId:string){
    return this.query().where({company_id:companyId}).orderBy('created_at', 'desc')
  }

  async findInvite(email:string,userId:string){
    return this.query().where('email',email).andWhere('invite_sent_by',userId).first()
  }

//   async createSupportTicket(userId:string,companyId:stri)

}

export default new UserTeamModel()

                  // .query()
                  // .where('email',email)
                  // .andwhere('invite_sent_by',userId)
                  // .first()