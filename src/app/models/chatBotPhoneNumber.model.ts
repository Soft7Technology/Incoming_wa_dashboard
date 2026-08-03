import { BaseModel } from '@surefy/models/base.model';

class chatSessionModel extends BaseModel{
    constructor(){
        super("chat_bot_phone_numbers")
    }

    async createChatBot(data:any){
       return this.query().insert(data).returning('*');
    }

    async findById(id: string | number): Promise<any> {
        return this.query().where({id}).first()
    }

    async getPublishedBotByPhoneNumberId(phoneNumberId:string){
        return this.query().where({phoneNumberId: phoneNumberId, published:true}).first()
    }

    async deleteChatBotPhoneNumber(chat_bot_id:string){
        return this.query().where("chat_bot_id",chat_bot_id).delete()
    }
}

export default new chatSessionModel();