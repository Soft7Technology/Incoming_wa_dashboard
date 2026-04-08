export interface chatBot{
    id?:string;
    user_id:string;
    description:string;
    name:string;
    published:boolean;
    status:string
    phoneNumberId:string;
    createdAt?:string
}

// name,description, status:'draft',published:false

export interface chatBotEdge{
    id:string
    user_id:string;
    chatBotId:string;
    target:string;
    label:string;
    data:JSON;
    createdAt:string
}
// id,chatbotId,type,data,position,createAt
export interface chatBotNode{
    id:string;
    user_id:string;
    chatBotId:string;
    type:string;
    data:JSON;
    position:string;
    createdAt:string
}