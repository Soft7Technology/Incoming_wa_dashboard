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
import chatbotTriggerModel from '../models/chatbotTrigger.model';
import wabaModel from '../models/waba.model';
import { v4 as uuidv4 } from 'uuid';
import { values } from 'lodash';

class chatBotService {
  private normalizeName(name: unknown): string {
    if (typeof name !== 'string' || !name.trim()) {
      throw new HTTP400Error({ message: 'ChatBot name must be a non-empty string' });
    }
    return name.trim();
  }

  async updateChatBotName(userId: string, chatBotId: string, name: unknown) {
    const normalizedName = this.normalizeName(name);
    const bot = await chatBotModel.updateName(userId, chatBotId, normalizedName);
    if (!bot) {
      throw new HTTP400Error({ message: 'ChatBot not found or does not belong to this user' });
    }
    return bot;
  }

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

  async publishedChatBot(
    userId: string,
    chatBotId: string
  ) {
    const bot: any = await chatBotModel.findById(
      chatBotId
    );

    if (!bot) {
      throw new HTTP400Error({
        message: "ChatBot not exists",
      });
    }

    if (bot.user_id !== userId) {
      throw new HTTP400Error({ message: "ChatBot does not belong to this user" });
    }

    const triggers = await chatbotTriggerModel.findAll({ chatbot_id: chatBotId });
    if (!triggers.length) {
      throw new HTTP400Error({ message: "Save a flow with trigger keywords before publishing" });
    }

    for (const trigger of triggers) {
      const conflicts = await chatbotTriggerModel.findConflicts({
        phoneNumberId: trigger.phone_number_id,
        triggers: [trigger.trigger_word],
        excludeChatBotId: chatBotId,
      });
      if (conflicts.length) {
        throw new HTTP400Error({ message: "Some trigger keywords are already assigned to another published chatbot.", conflicts } as any);
      }
    }

    await chatBotModel.setPublishedState(chatBotId, true);

    return {
      success: true,
    };
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

  async unpublishedChatBot(
    userId: string,
    chatBotId: string
  ) {
    const bot =
      await chatBotModel.findById(chatBotId);

    if (!bot) {
      throw new HTTP400Error({
        message: "ChatBot not exists",
      });
    }

    if (bot.user_id !== userId) {
      throw new HTTP400Error({ message: "ChatBot does not belong to this user" });
    }

    await chatBotModel.setPublishedState(chatBotId, false);

    return {
      success: true,
    };
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
    if (bot.user_id !== userId) {
      throw new HTTP400Error({ message: 'ChatBot does not belong to this user' });
    }
    const normalizedName = name === undefined ? undefined : this.normalizeName(name);
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
          active: bot.published === true,
          created_at: new Date(),
        });
      }
    }

    return {
      chatBotId,
      name: normalizedName === undefined
        ? bot.name
        : (await this.updateChatBotName(userId, chatBotId, normalizedName)).name,
      triggerWords,
      phoneNumberIds,
    };
  }
}

export default new chatBotService();

