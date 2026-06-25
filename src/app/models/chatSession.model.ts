import { BaseModel } from '@surefy/models/base.model';

class chatSessionModel extends BaseModel{
    constructor(){
        super("chat_sessions")
    }  

    async createChatBot(data:any){
       return this.query().insert(data).returning('*');
    }

    async findById(id: string | number): Promise<any> {
        return this.query().where({id}).first()
    }

    async findByPhoneandBot(phoneNumber:string,botId:any){
        return this.query().where({phone_number:phoneNumber,chatbot_id:botId}).first()
    }
}

export default new chatSessionModel();