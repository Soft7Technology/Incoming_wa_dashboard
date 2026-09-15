import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import chatBotService from '../../services/chatbot.service';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import wabaModel from '../../models/waba.model';
import phoneNumberModel from '../../models/phoneNumber.model';
import userPlansModel from '../../models/userPlans.model';

class chatBotController {
    updateChatBotName = tryCatchAsync(async (req: AuthRequest, res: Response) => {
        const result = await chatBotService.updateChatBotName(
            req.userId!, req.params.chatBotId, req.body?.name
        );
        return successResponse(req, res, 'ChatBot name updated successfully', result);
    });

    /**
     * POST /v1/chatbot
     * Create New Chatbot
     */
    createChatBot = tryCatchAsync(async (req: AuthRequest, res: Response) => {
        const { name, description } = req.body;
        const result = await chatBotService.createChatBot({
            user_id: req.userId!,
            company_id: req.companyId!,
            name,
            description,
            status: 'draft',
            published: false,
        })
        // await userPlansModel.incrementUsage(req.userId!, 'Chatbot');

        return successResponse(req, res, 'Create ChatBot successfully', result);
    })

    /**
     * GET /v1/chatbot
     * Get Chatbots
     */

    getChatBots = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const chatBots = await chatBotService.getChatBots(req.userId!);
            return successResponse(req, res, 'ChatBots retrieved successfully', chatBots);
        }
    );

    publishedChatBot = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const { chatBotId } = req.params;
            // const {status, published} = req.body

            const result = await chatBotService.publishedChatBot(req.userId!, chatBotId);
            return successResponse(req, res, 'ChatBot published successfully', result);
        }
    )

    unpublishedChatBot = tryCatchAsync(
        async (
            req: AuthRequest,
            res: Response
        ) => {
            const { chatBotId } = req.params;

            const result =
                await chatBotService.unpublishedChatBot(
                    req.userId!,
                    chatBotId
                );

            return successResponse(
                req,
                res,
                "ChatBot unpublished successfully",
                result
            );
        }
    );

    getChatBotById = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const { chatBotId } = req.params;
            const chatBot = await chatBotService.getChatBotById(chatBotId);
            return successResponse(req, res, 'ChatBot retrieved successfully', chatBot);
        }
    );

    deleteChatBot = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const { chatBotId } = req.params;
            const result = await chatBotService.deleteChatBot(chatBotId);
            return successResponse(req, res, 'ChatBot deleted successfully', result);
        }
    )

    createChatBotFlow = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const { chatBotId } = req.params;
            const { name, nodes, edges, phoneNumberIds } = req.body;

            console.log("Creating chatbot flow:", { chatBotId, name }); // Debug log

            const result = await chatBotService.createFlow(req.userId!, {
                chatBotId,
                name,
                nodes,
                edges,
                phoneNumberIds
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
