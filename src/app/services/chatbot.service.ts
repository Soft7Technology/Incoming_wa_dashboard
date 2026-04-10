import { Request, Response } from 'express';
import { successResponse, tryCatchAsync } from '@surefy/utils/Controller';
import { HttpStatusCode } from '@surefy/utils/HttpStatusCode';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import { JWTAuthRequest } from '@surefy/middleware/jwtAuth.middleware';
import { AuthRequest } from '@surefy/middleware/auth.middleware';
import { chatBotEdge, chatBot, chatBotNode } from '@surefy/console/interfaces/chatbot.interface';
import chatBotModel from '../models/chatbot.model';
import chatBotEdgeModel from '../models/chatBotEdge.model';
import chatBotNodeModel from '../models/chatBotNode.model';
import wabaModel from '../models/waba.model';
import { v4 as uuidv4 } from 'uuid';

class chatBotService {
  async createChatBot(data: chatBot) {
    console.log('Creating chatbot with data:', data); // Debug log
    const result = await chatBotModel.create(data);
    return result;
  }

  async getChatBots(userId: string) {
    const chatBots = await chatBotModel.findByUserId(userId);
    return chatBots;
  }

  async deleteChatBot(chatBotId: string) {
    // ✅ 1. Check chatbot exists
    const bot = await chatBotModel.findById(chatBotId);
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not exists' });
    }           
    // 🔥 2. DELETE FLOW
    await chatBotEdgeModel.deleteChatBotEdge(chatBotId);
    await chatBotNodeModel.deleteChatBotNode(chatBotId);
    // 🔥 3. DELETE CHATBOT
    const result = await chatBotModel.delete(chatBotId);
    return result;
  }

  async publishedChatBot(userId: string, chatBotId: string, status: string, published: boolean) {
    // ✅ 1. Check chatbot exists
    const bot = await chatBotModel.findById(chatBotId);
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not exists' });
    }

    const existingPublishedBot:any = await chatBotModel.getPublishedBotByUser(userId);
    console.log("Existing published bot:", existingPublishedBot ? existingPublishedBot.name : "No published bot"); // Debug log
    if (existingPublishedBot) {
        throw new HTTP400Error({ message: "Another chatbot is already published for this phone number. Unpublish it before publishing a new one." });
    }
    const publishedChatBot = await chatBotModel.update(chatBotId, { published, status });
    return publishedChatBot;
  }

  async getChatBotById(chatBotId: string) {
    // ✅ 1. Check chatbot exists
    const bot = await chatBotModel.findById(chatBotId);
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not exists' });
    }

    const edges = await chatBotEdgeModel.findByChatBotId(chatBotId);
    const nodes = await chatBotNodeModel.findByChatBotId(chatBotId);
    return { ...bot, edges, nodes };
  }

  async getPublishedBotByUser(userId: string) {
    const bot = await chatBotModel.getPublishedBotByUser(userId);
    return bot;
  }

  async unpublishedChatBot(userId: string, chatBotId: string, status: string, published: boolean) {
    // ✅ 1. Check chatbot exists
    const bot = await chatBotModel.findById(chatBotId);
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not exists' });
    }       
    const unpublishedChatBot = await chatBotModel.update(chatBotId, { published, status });
    return unpublishedChatBot;
  }

  async createFlow(userId: string, data: any) {
    const { chatBotId, name, nodes, edges } = data;
    // ✅ 1. Check chatbot exists
    const bot = await chatBotModel.findById(chatBotId);
    console.log('ChatBot found:', bot); // Debug log
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot flow not exists' });
    }

    // ✅ 2. Validate trigger node
    const hasTrigger = nodes.some((n: any) => n.type === 'trigger');
    if (!hasTrigger) {
      throw new HTTP400Error({ message: 'Flow must contain a trigger node' });
    }

    // ✅ 3. Optional: update chatbot name
    // if (name) {
    //     // await chatBotModel.query()
    //     //   .where({ id: chatBotId })
    //     //   .update({ name });

    //     await chatBotModel.update(chatBotId, name)
    // }

    // 🔥 4. DELETE OLD FLOW
    await chatBotEdgeModel.deleteChatBotEdge(chatBotId);
    await chatBotNodeModel.deleteChatBotNode(chatBotId);

    const nodeIdMap: Record<string, string> = {};

    // ✅ 5. Prepare Nodes
    const formattedNodes = nodes.map((n: any) => {
      const newId = uuidv4();

      nodeIdMap[n.id] = newId; // 🔥 map old → new

      return {
        id: newId,
        chatBotId,
        type: n.type,
        data: JSON.stringify(n.data),
        position: JSON.stringify(n.position || { x: 0, y: 0 }),
        createdAt: new Date(),
      };
    });

    // ✅ 6. Insert Nodes
    await chatBotNodeModel.createNodes(formattedNodes);

    // ✅ 7. Prepare Edges
    const formattedEdges = edges.map((e: any) => ({
      id: uuidv4(),
      chatBotId,
      source: nodeIdMap[e.source], // ✅ FIX
      target: nodeIdMap[e.target], // ✅ FIX
      label: e.label || null,
      data: JSON.stringify(e.data || {}),
      createdAt: new Date(),
    }));

    // ✅ 8. Insert Edges
    await chatBotEdgeModel.createEdges(formattedEdges);

    return { chatBotId };
  }
}

export default new chatBotService();
