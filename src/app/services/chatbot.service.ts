import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import { chatBotEdge, chatBot, chatBotNode } from '@surefy/console/interfaces/chatbot.interface';
import chatBotModel from '../models/chatbot.model'
import chatBotEdgeModel from '../models/chatBotEdge.model'
import chatBotNodeModel from '../models/chatBotNode.model'
import wabaModel from '../models/waba.model';

class chatBotService {
    async createChatBot(data: chatBot) {
        console.log("Creating chatbot with data:", data); // Debug log
        const result = await chatBotModel.create(data)
        return result
    }

    async createFlow(userId: string, data: any) {
        const { chatBotId, name, nodes, edges } = data;
        // ✅ 1. Check chatbot exists
        const bot = await chatBotModel.findById(chatBotId);
        console.log("ChatBot found:", bot); // Debug log
        if (!bot) {
            throw new HTTP400Error({ message: "ChatBot flow not exists" });
        }

        // ✅ 2. Validate trigger node
        const hasTrigger = nodes.some((n: any) => n.type === "trigger");
        if (!hasTrigger) {
            throw new HTTP400Error({ message: "Flow must contain a trigger node" });
        }

        // ✅ 3. Optional: update chatbot name
        // if (name) {
        //     // await chatBotModel.query()
        //     //   .where({ id: chatBotId })
        //     //   .update({ name });

        //     await chatBotModel.update(chatBotId, name)
        // }

        // 🔥 4. DELETE OLD FLOW
        await chatBotEdgeModel.delete(chatBotId);
        await chatBotNodeModel.delete(chatBotId);

        // ✅ 5. Prepare Nodes
        const formattedNodes = nodes.map((n: any) => ({
            id: n.id,
            chatBotId,
            type: n.type,
            data: JSON.stringify(n.data),
            position: JSON.stringify(n.position || { x: 0, y: 0 }),
            createdAt: new Date(),
        }));

        // ✅ 6. Insert Nodes
        await chatBotNodeModel.createNodes(formattedNodes);

        // ✅ 7. Prepare Edges
        const formattedEdges = edges.map((e: any) => ({
            id: e.id,
            chatBotId,
            source: e.source,
            target: e.target,
            label: e.label || null,
            data: JSON.stringify(e.data || {}),
            createdAt: new Date(),
        }));

        // ✅ 8. Insert Edges
        await chatBotEdgeModel.createEdges(formattedEdges);

        return { chatBotId };
    }
}

export default new chatBotService