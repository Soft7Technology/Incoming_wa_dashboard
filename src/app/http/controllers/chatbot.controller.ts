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
import activityLogsModel from '../../models/activityLogs.model';

class chatBotController {
    /**
     * POST /v1/chatbot
     * Create New Chatbot
     */
    createChatBot = tryCatchAsync(async (req: AuthRequest, res: Response) => {
        const { name, description, phoneNumberId } = req.body
        console.log("Req", req.body)
        const phoneNumber: any = await phoneNumberModel.findByPhoneNumberId(phoneNumberId)
        console.log("PhoneNumber found:", phoneNumber); // Debug log

        if (!phoneNumber || !phoneNumber.phone_number_id) {
            throw new HTTP400Error({ message: 'Associated WABA account not found for user' });
        }

        const result = await chatBotService.createChatBot({ user_id: req.userId!, name, description, status: 'draft', published: false, phoneNumberId: phoneNumber.phone_number_id })
        await userPlansModel.incrementUsage(req.userId!, 'Chatbot');

        const { data }: any = result
        await activityLogsModel.create({
            company_id: req.companyId,
            user_id: req.userId,

            action: 'CREATE',
            entity_type: 'CHATBOT',
            entity_id: data.id,

            description: `Created chatbot "${data.name}"`,

            new_data: {
                id: data.id,
                name: data.name,
                description: data.description,
                status: data.status,
                published: data.published,
                phone_number_id: data.phoneNumberId
            },

            ip_address:
                (req.headers['x-forwarded-for'] as string) ||
                req.socket.remoteAddress ||
                '',

            user_agent: req.headers['user-agent'] || '',

            request_method: req.method,
            api_endpoint: req.originalUrl,

            status: 'SUCCESS'
        });
        return successResponse(req, res, 'Create ChatBot successfully', result);
    })

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
            const { data }: any = result
            await activityLogsModel.create({
                company_id: req.companyId,
                user_id: req.userId,

                action: 'PUBLISH',
                entity_type: 'CHATBOT',
                entity_id: chatBotId,

                description: `Published chatbot "${data.name}"`,

                new_data: {
                    chatbot_name: data.name,
                    status: data.status,
                    published: data.published
                },

                ip_address:
                    (req.headers['x-forwarded-for'] as string) ||
                    req.socket.remoteAddress ||
                    '',

                user_agent: req.headers['user-agent'] || '',

                request_method: req.method,
                api_endpoint: req.originalUrl,

                status: 'SUCCESS'
            });

            return successResponse(req, res, 'ChatBot published successfully', result);
        }
    )

    unpublishedChatBot = tryCatchAsync(
        async (req: AuthRequest, res: Response) => {
            const { chatBotId } = req.params;

            const result = await chatBotService.unpublishedChatBot(
                req.userId!,
                chatBotId,
                'unpublished',
                false
            );

            const { data }: any = result;

            await activityLogsModel.create({
                company_id: req.companyId,
                user_id: req.userId,

                action: 'UNPUBLISH',
                entity_type: 'CHATBOT',
                entity_id: chatBotId,

                description: `Unpublished chatbot "${data.name}"`,

                new_data: {
                    chatbot_name: data.name,
                    status: data.status,
                    published: data.published
                },

                ip_address:
                    (req.headers['x-forwarded-for'] as string) ||
                    req.socket.remoteAddress ||
                    '',

                user_agent: req.headers['user-agent'] || '',

                request_method: req.method,
                api_endpoint: req.originalUrl,

                status: 'SUCCESS'
            });

            return successResponse(
                req,
                res,
                'ChatBot unpublished successfully',
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
            const { name, nodes, edges } = req.body;

            console.log("Creating chatbot flow:", { chatBotId, name }); // Debug log

            const result = await chatBotService.createFlow(req.userId!, {
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