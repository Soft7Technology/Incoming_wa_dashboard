import { BaseModel } from '@surefy/models/base.model';

class chatSessionModel extends BaseModel{
    constructor(){
        super("chat_session")
    }  

    async createChatBot(data:any){
       return this.query().insert(data).returning('*');
    }

    async findById(id: string | number): Promise<any> {
        return this.query().where({id}).first()
    }

    async findByUserKey(phoneNumber:string){
        return this.query().where({phone_number:phoneNumber})
    }
}

export default new chatSessionModel();