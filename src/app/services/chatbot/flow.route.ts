import { StringReplacer } from "tsc-alias/dist/interfaces";
import chatSessionModel from "../../models/chatSession.model"
import { formFlow } from "./flows/form.flow";
import { menuFlow } from "./flows/menu.flow";
import { triggerFlow } from "./flows/trigger.flow";

type FlowRouterParams={
    bot:{
        id:string
    };
    phone:string;
    incomingText:string;
    incomingId:string;
    message:string
}

export const flowRouter = async ({ 
    bot, 
    phone, 
    incomingText, 
    incomingId,
    message
}: FlowRouterParams)=> {
    // Get Session
    console.log("Flow Body",phone,incomingText,incomingId)
    const session = await chatSessionModel.findByPhoneandBot(phone,bot.id)
    console.log('Session',session)

    if(session){
        return await menuFlow({bot,session,incomingId,incomingText,message})
        // if(session.current_flow === 'form'){
        //     return formFlow({bot,session,incomingText,incomingId})
        // }

        // if(session.current_flow === 'menu'){
        //     return await menuFlow({bot,session,incomingId,incomingText})
        // }

        // //No session -> interactive click
        // if(incomingId){
        //     return await menuFlow({bot,session,incomingId,incomingText})
        // }
    }

   // Default -> trigger flow
    return await triggerFlow({bot,phone,incomingText})
}