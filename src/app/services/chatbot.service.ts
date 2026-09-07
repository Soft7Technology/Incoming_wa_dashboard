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

    // Check already published bot for same phone number
    const existingPublishedBot =
      await chatBotModel.getPublishedBotByPhoneNumber(
        bot.phoneNumberId,
        chatBotId // exclude current
      );

    if (existingPublishedBot) {
      throw new HTTP400Error({
        message:
          "Another chatbot is already published for this phone number.",
      });
    }

    // Publish chatbot
    await chatBotModel.update(chatBotId, {
      status: "published",
      published: true,
    });

    // Activate triggers
    await chatbotTriggerModel.updateByChatBot(
      chatBotId,
      {
        active: true,
      }
    );

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
    chatBotId: string
  ) {
    const bot =
      await chatBotModel.findById(chatBotId);

    if (!bot) {
      throw new HTTP400Error({
        message: "ChatBot not exists",
      });
    }

    await chatBotModel.update(chatBotId, {
      status: "draft",
      published: false,
    });

    await chatbotTriggerModel.updateByChatBot(
      chatBotId,
      {
        active: false,
      }
    );

    return {
      success: true,
    };
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
      nodes = [],
      edges = [],
      phoneNumberIds = [],
    } = data || {};

    // -----------------------------
    // Validation
    // -----------------------------

    if (!chatBotId) {
      throw new HTTP400Error({
        message: "chatBotId is required",
      });
    }

    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new HTTP400Error({
        message: "Flow must contain at least one node",
      });
    }

    if (!Array.isArray(edges)) {
      throw new HTTP400Error({
        message: "edges must be an array",
      });
    }

    if (
      !Array.isArray(phoneNumberIds) ||
      phoneNumberIds.length === 0
    ) {
      throw new HTTP400Error({
        message: "At least one phone number is required",
      });
    }

    const chatbot = await chatBotModel.findById(chatBotId);

    if (!chatbot) {
      throw new HTTP400Error({
        message: "Chatbot not found",
      });
    }

    // -----------------------------
    // Find Trigger Node
    // -----------------------------

    const triggerNode = nodes.find(
      (node: any) => node?.type === "trigger"
    );

    if (!triggerNode) {
      throw new HTTP400Error({
        message: "Flow must contain a trigger node",
      });
    }

    // -----------------------------
    // Trigger Keywords
    // -----------------------------

    const rawKeywords =
      triggerNode?.data?.attributes?.keywords || [];

    if (
      !Array.isArray(rawKeywords) ||
      rawKeywords.length === 0
    ) {
      throw new HTTP400Error({
        message: "At least one trigger keyword is required",
      });
    }

    const triggerWords = [
      ...new Set(
        rawKeywords
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

    if (!triggerWords.length) {
      throw new HTTP400Error({
        message: "At least one valid trigger keyword is required",
      });
    }

    // -----------------------------
    // Duplicate Keyword Check
    // -----------------------------

    const conflictMessages: string[] = [];

    for (const phoneNumberId of phoneNumberIds) {
      const existingTriggers =
        await chatbotTriggerModel.findConflictingTriggers({
          phoneNumberId,
          triggerWords,
          excludeChatBotId: chatBotId,
        });

      if (existingTriggers.length > 0) {
        const phoneNumber =
          await phoneNumberModel.findByPhoneNumberId(
            phoneNumberId
          );

        const duplicateKeywords = [
          ...new Set(
            existingTriggers.map(
              (row: any) => row.trigger_word
            )
          ),
        ];

        conflictMessages.push(
          `${phoneNumber?.display_phone_number ||
          phoneNumber?.phone_number ||
          phoneNumberId
          } → ${duplicateKeywords.join(", ")}`
        );
      }
    }

    if (conflictMessages.length > 0) {
      throw new HTTP400Error({
        message:
          "The following trigger keywords are already assigned to another chatbot:\n\n" +
          conflictMessages.join("\n"),
      });
    }

    // -----------------------------
    // Flow Type
    // -----------------------------

    const messageCount = nodes.filter(
      (node: any) => node?.type === "message"
    ).length;

    await chatBotModel.update(chatBotId, {
      name,
      flow_type:
        messageCount >= 3 ? "form" : "menu",
    });

    // -----------------------------
    // Delete Existing Flow
    // -----------------------------

    await chatBotEdgeModel.deleteChatBotEdge(
      chatBotId
    );

    await chatBotNodeModel.deleteChatBotNode(
      chatBotId
    );

    // -----------------------------
    // Create Nodes
    // -----------------------------

    const nodeIdMap: Record<string, string> = {};

    const formattedNodes = nodes.map(
      (node: any) => {
        const newNodeId = uuidv4();

        nodeIdMap[node.id] = newNodeId;

        return {
          id: newNodeId,
          user_id: userId,
          chatBotId,
          type: node.type,
          data: JSON.stringify(node.data || {}),
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

    if (formattedNodes.length) {
      await chatBotNodeModel.createNodes(
        formattedNodes
      );
    }

    // -----------------------------
    // Create Edges
    // -----------------------------

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

    if (formattedEdges.length) {
      await chatBotEdgeModel.createEdges(
        formattedEdges
      );
    }

    // -----------------------------
    // Save Triggers
    // -----------------------------

    await chatbotTriggerModel.deleteByChatBot(
      chatBotId
    );

    const triggerRecords = [];

    for (const phoneNumberId of phoneNumberIds) {
      for (const triggerWord of triggerWords) {
        triggerRecords.push({
          chatbot_id: chatBotId,
          phone_number_id: phoneNumberId,
          trigger_word: triggerWord,
          active: true,
          created_at: new Date(),
        });
      }
    }

    if (triggerRecords.length) {
      await chatbotTriggerModel.insertMany(
        triggerRecords
      );
    }

    return {
      success: true,
      chatBotId,
      flowType:
        messageCount >= 3 ? "form" : "menu",
      triggerWords,
      phoneNumberIds,
      nodesCount: formattedNodes.length,
      edgesCount: formattedEdges.length,
    };
  }
}

export default new chatBotService();