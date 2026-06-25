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

  async findAcceptedByInviter(inviteSentBy: string) {
    return this.query()
      .join('users as u', 'u.email', 'user_team.email')
      .where('user_team.invite_sent_by', inviteSentBy)
      .where('user_team.invite_status', 'accepted')
      .select(
        'u.id as id',
        'user_team.id as invite_id',
        'user_team.name as name',
        'user_team.email as email',
        'user_team.phone_number as phone_number',
        'user_team.role as role',
      );
  }

}

export default new UserTeamModel()

                  // .query()
                  // .where('email',email)
                  // .andwhere('invite_sent_by',userId)
                  // .first()