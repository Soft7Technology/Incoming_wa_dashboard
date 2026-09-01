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
    message:string;
    phoneNumberId:string
}

export const flowRouter = async ({ 
    bot, 
    phone, 
    incomingText, 
    incomingId,                                                                  
    message,
    phoneNumberId
}: FlowRouterParams)=> {
    // Get Session
    console.log("Flow Body",phone,incomingText,incomingId)
    const session = await chatSessionModel.findActiveByPhoneandBot(phone,phoneNumberId,bot.id)
    console.log('Session',session)

    if(session){
        // Check if session has expired (3 minutes)
        const lastActivityTime = session.updated_at || session.created_at;
        if (lastActivityTime) {
            const updatedAt = new Date(lastActivityTime).getTime();
            const now = Date.now();
            const diffMinutes = (now - updatedAt) / 1000 / 60;

            if (diffMinutes >= 3) {
                console.log(`Session expired for ${phone}. Inactive for ${diffMinutes.toFixed(2)} mins`);
                await chatSessionModel.update(session.id, { active: false });
                
                // Route to trigger flow since the session is expired
                return await triggerFlow({bot, phone, incomingText, phoneNumberId});
            }
        }

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
    return await triggerFlow({bot,phone,incomingText,phoneNumberId})
}
