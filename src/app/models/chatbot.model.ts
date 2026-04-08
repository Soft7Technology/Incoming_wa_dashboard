import { BaseModel } from '@surefy/models/base.model';
import { chatBot } from '../interfaces/chatbot.interface';

class chatBotModel extends BaseModel{
    constructor(){
        super("chat_bot")
    }  

    async createChatBot(data:chatBot){
       return this.query().insert(data).returning('*');
    }

    async findById(id: string | number): Promise<any> {
        return this.query().where({id}).first()
    }

    async getPublishedBotByUser(phoneNumberId:string){
        return this.query().where({phoneNumberId,published:true}).first()
    }
}

export default new chatBotModel();