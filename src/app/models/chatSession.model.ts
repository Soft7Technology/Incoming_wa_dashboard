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

    async findByPhoneandBot(phoneNumber:string,phoneNumberId:string,botId:any){
        return this.query().where({phone_number:phoneNumber,phoneNumberId:phoneNumberId,chatbot_id:botId}).first()
    }

    async findActiveByPhoneandBot(phoneNumber: string, phoneNumberId: string, botId: any) {
        return this.query()
            .where({
                phone_number: phoneNumber,
                phoneNumberId,
                chatbot_id: botId,
                active: true,
            })
            .orderBy("updated_at", "desc")
            .first();
    }

    async deactivateActiveByPhoneandBot(phoneNumber: string, phoneNumberId: string, botId: any) {
        return this.query()
            .where({
                phone_number: phoneNumber,
                phoneNumberId,
                chatbot_id: botId,
                active: true,
            })
            .update({ active: false });
    }
}

export default new chatSessionModel();
