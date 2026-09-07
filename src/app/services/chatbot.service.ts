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
import db from '@surefy/database';
import phoneNumberModel from '../models/phoneNumber.model';
import chatBotPhoneNumberModel from '../models/chatBotPhoneNumber.model';
import chatbotTriggerModel from '../models/chatbotTrigger.model';

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

  async publishedChatBot(userId: string, chatBotId: string) {
    // ✅ 1. Check chatbot exists
    const chatBot_phonenumber: any = await chatBotPhoneNumberModel.getByChatBotId(chatBotId)
    const bot = await chatBotModel.findById(chatBotId);
    console.log("Chatbot", chatBot_phonenumber)
    for (const chatBotPhone of chatBot_phonenumber) {
      console.log("Updating:", chatBotPhone);

      await chatBotPhoneNumberModel.update(
        chatBotPhone.id,
        { published: true }
      );
    }
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not exists' });
    }

    const existingPublishedBot: any = await chatBotModel.getPublishedBotByUser(userId);
    console.log("Existing published bot:", existingPublishedBot ? existingPublishedBot.name : "No published bot"); // Debug log
    if (existingPublishedBot) {
      throw new HTTP400Error({ message: "Another chatbot is already published for this phone number. Unpublish it before publishing a new one." });
    }
    const publishedChatBot = await chatBotModel.update(chatBotId, { status: "published", published: "true" });
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
    const chatBot_phonenumber: any = await chatBotPhoneNumberModel.getByChatBotId(chatBotId)
    const bot = await chatBotModel.findById(chatBotId);

    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not exists' });
    }
        console.log("Chatbot", chatBot_phonenumber)
    for (const chatBotPhone of chatBot_phonenumber) {
      console.log("Updating:", chatBotPhone);

      await chatBotPhoneNumberModel.update(
        chatBotPhone.id,
        { published: false }
      );
    }
    const unpublishedChatBot = await chatBotModel.update(chatBotId, { published, status });
    return unpublishedChatBot;
  }

  async assignedChatBotToUser(assigned_to: string, chatBotId: string) {
    const chatBot = await chatBotModel.findById(chatBotId);

    let assignedTo = chatBot.assigned_to || [];

    if (typeof assignedTo === 'string') {
      assignedTo = JSON.parse(assignedTo);
    }

    const updatedAssignedTo = [...new Set([...assignedTo, assigned_to])];
    return await db('chat_bot')
      .where('id', chatBot.id)
      .update({
        assigned_to: updatedAssignedTo
      });
  }


  async createFlow(userId: string, data: any) {
    const {
      chatBotId,
      name,
      nodes,
      edges,
      phoneNumberIds = [],
    } = data;

    console.log("Data", data)

    const bot = await chatBotModel.findById(chatBotId);

    if (!bot) {
      throw new HTTP400Error({
        message: "ChatBot flow not exists",
      });
    }
    // ---------------------------------
    // Get Trigger Node
    // ---------------------------------

    const triggerNode = nodes.find(
      (node: any) => node.type === "trigger"
    );

    if (!triggerNode) {
      throw new HTTP400Error({
        message: "Flow must contain a trigger node",
      });
    }

    // ---------------------------------
    // Extract Trigger Keywords
    // ---------------------------------

    const rawTriggers =
      triggerNode?.data?.attributes?.keywords || [];

    if (
      !Array.isArray(rawTriggers) ||
      rawTriggers.length === 0
    ) {
      throw new HTTP400Error({
        message: "At least one trigger keyword is required",
      });
    }

    // ---------------------------------
    // Normalize Trigger Keywords
    // ---------------------------------

    const triggerWords = [
      ...new Set(
        rawTriggers
          .filter(
            (keyword: any) =>
              typeof keyword === "string"
          )
          .map((keyword: string) =>
            keyword
              .trim()
              .toLowerCase()
              .replace(/\s+/g, " ")
          )
          .filter(Boolean)
      ),
    ];

    // ---------------------------------
    // Validate Phone Numbers
    // ---------------------------------

    if (
      !Array.isArray(phoneNumberIds) ||
      phoneNumberIds.length === 0
    ) {
      throw new HTTP400Error({
        message: "At least one phone number is required",
      });
    }

    // ---------------------------------
    // Check Trigger Conflicts
    // ---------------------------------

    for (const phoneNumberId of phoneNumberIds) {
      const conflicts =
        await chatbotTriggerModel.findConflicts({
          phoneNumberId,
          triggers: triggerWords,
          excludeChatBotId: chatBotId,
        });

      if (conflicts.length > 0) {
        throw new HTTP400Error({
          message:
            "Some trigger keywords are already assigned to another chatbot.",
          conflicts,
        } as any);
      }
    }

    // ---------------------------------
    // Save Flow Logic
    // ---------------------------------

    const messageCount = nodes.filter(
      (node: any) => node.type === "message"
    ).length;

    await chatBotModel.update(chatBotId, {
      flow_type: messageCount >= 3 ? "form" : "menu",
    });

    // delete old nodes/edges
    await chatBotEdgeModel.deleteChatBotEdge(
      chatBotId
    );

    await chatBotNodeModel.deleteChatBotNode(
      chatBotId
    );

    // create nodes
    const nodeIdMap: Record<string, string> = {};

    const formattedNodes = nodes.map(
      (node: any) => {
        const newId = uuidv4();

        nodeIdMap[node.id] = newId;

        return {
          id: newId,
          user_id: userId,
          chatBotId,
          type: node.type,
          data: JSON.stringify(node.data),
          position: JSON.stringify(
            node.position || {
              x: 0,
              y: 0,
            }
          ),
          created_at: new Date(),
        };
      }
    );

    await chatBotNodeModel.createNodes(
      formattedNodes
    );

    // create edges
    const formattedEdges = edges.map(
      (edge: any) => ({
        id: uuidv4(),
        user_id: userId,
        chatBotId,
        source: nodeIdMap[edge.source],
        target: nodeIdMap[edge.target],
        label: edge.label || null,
        data: JSON.stringify(edge.data || {}),
        created_at: new Date(),
      })
    );

    await chatBotEdgeModel.createEdges(
      formattedEdges
    );

    // ---------------------------------
    // Save Triggers
    // ---------------------------------

    await chatbotTriggerModel.deleteByChatBot(
      chatBotId
    );

    for (const phoneNumberId of phoneNumberIds) {
      for (const triggerWord of triggerWords) {
        await chatbotTriggerModel.create({
          chatbot_id: chatBotId,
          phone_number_id: phoneNumberId,
          trigger_word: triggerWord,
          active: true,
          created_at: new Date(),
        });
      }
    }

    return {
      chatBotId,
      triggerWords,
      phoneNumberIds,
    };
  }
}

export default new chatBotService();