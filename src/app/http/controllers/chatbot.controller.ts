import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import chatBotService from '../../services/chatbot.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import wabaModel from '../../models/waba.model';
import phoneNumberModel from '../../models/phoneNumber.model';

class chatBotController {
    /**
     * POST /v1/chatbot
     * Create New Chatbot
     */
    createChatBot =  tryCatchAsync(async(req:AuthRequest,res:Response)=>{
        const {name, description,phoneNumberId} = req.body
        console.log("Req", req.body)
        const phoneNumber:any = await phoneNumberModel.findByPhoneNumberId(phoneNumberId)
        console.log("PhoneNumber found:", phoneNumber); // Debug log

        if(!phoneNumber || !phoneNumber.phone_number_id){
            throw new HTTP400Error({ message: 'Associated WABA account not found for user' });
        }

        const result = await chatBotService.createChatBot({user_id:req.userId!,name,description, status:'draft',published:false,phoneNumberId:phoneNumber.phone_number_id})
        return successResponse(req, res, 'Create ChatBot successfully', result);
    })

    createChatBotFlow = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const { chatBotId } = req.params;
            const { name, nodes, edges } = req.body;

            const result = await chatBotService.createFlow(req.userId!,{
                chatBotId,
                name,
                nodes,
                edges,
            });

            return res.status(200).json({
                success: true,
                message: "Chatbot flow saved successfully",
                data: result,
            });
        }
    );
}

export default new chatBotController()