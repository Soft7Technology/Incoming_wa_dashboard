import db from '@surefy/database';
import phoneNumberModel from '../models/phoneNumber.model';
import { Request, Response } from 'express';
import { parseChatbotDelay } from '../utils/chatbotDelay';
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
    const { user_id, company_id, name, description, status, published } = data;
    const result = await chatBotModel.create({ user_id, company_id,
      name: this.normalizeName(name), description, status, published });
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
    if (!Array.isArray(nodes) || nodes.length === 0) {
      throw new HTTP400Error({
        message: 'Cannot save chatbot flow: add at least one node.',
        details: { field: 'nodes', code: 'FLOW_NODES_REQUIRED' },
      });
    }
    if (!Array.isArray(edges) || edges.length === 0) {
      throw new HTTP400Error({
        message: 'Cannot save chatbot flow: connect the trigger to a message or action node.',
        details: { field: 'edges', code: 'FLOW_CONNECTION_REQUIRED' },
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

    const nodeIds = new Set(nodes.map((node: any) => node?.id));
    for (const node of nodes) {
      if (node?.data?.key !== '@whatsapp/delay') continue;
      try {
        node.data.attributes = {
          ...node.data.attributes,
          delay: parseChatbotDelay(node.data.attributes?.delay),
        };
      } catch (error) {
        throw new HTTP400Error({
          message: error instanceof Error ? error.message : 'Invalid chatbot delay.',
          details: { field: 'nodes', nodeId: node.id, code: 'FLOW_INVALID_DELAY' },
        });
      }
    }
    if (edges.some((edge: any) => !edge || !nodeIds.has(edge.source) || !nodeIds.has(edge.target))) {
      throw new HTTP400Error({
        message: 'Cannot save chatbot flow: a connection references a node that does not exist.',
        details: { field: 'edges', code: 'FLOW_INVALID_CONNECTION' },
      });
    }
    if (!edges.some((edge: any) => edge.source === triggerNode.id && edge.target !== triggerNode.id)) {
      throw new HTTP400Error({
        message: 'Cannot save chatbot flow: connect the trigger to a message or action node.',
        details: { field: 'edges', code: 'FLOW_CONNECTION_REQUIRED' },
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

    if (!triggerWords.length) throw new HTTP400Error({ message: 'At least one non-empty trigger keyword is required' });
    const selectedPhones = new Map<string, any>();
    for (const id of phoneNumberIds) {
      if (typeof id !== 'string') throw new HTTP400Error({ message: 'Invalid phone number ID' });
      const phone = await phoneNumberModel.findByPhoneNumberId(id);
      if (!phone || phone.user_id !== userId) throw new HTTP400Error({ message: 'Phone number not found or does not belong to this user' });
      selectedPhones.set(phone.phone_number_id, phone);
    }
    const canonicalPhoneIds = [...selectedPhones.keys()].sort();
    return db.transaction(async trx => {
      // Serialize edits to a bot, then reservations on each receiving number.
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`chatbot-flow:${chatBotId}`]);
      const currentBot = await trx('chat_bot').where({ id: chatBotId, user_id: userId }).forUpdate().first();
      if (!currentBot) throw new HTTP400Error({ message: 'ChatBot not found' });
      for (const id of canonicalPhoneIds) {
        await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`chatbot-phone:${id}`]);
        const phone = selectedPhones.get(id);
        const conflicts = await trx('chatbot_triggers')
          .whereIn('phone_number_id', [id, phone.id])
          .whereNot('chatbot_id', chatBotId)
          .whereRaw("LOWER(TRIM(REGEXP_REPLACE(trigger_word, '[[:space:]]+', ' ', 'g'))) = ANY(?::text[])", [triggerWords])
          .select('chatbot_id', 'phone_number_id', 'trigger_word');
        if (conflicts.length) throw new HTTP400Error({
          message: 'Trigger keyword is already assigned to another chatbot on this phone number',
          details: { code: 'CHATBOT_TRIGGER_CONFLICT', phoneNumberId: id, conflicts },
        });
      }

    // ---------------------------------
    // Save Flow Logic
    // ---------------------------------

    const messageCount = nodes.filter(
      (node: any) => node.type === "message"
    ).length;

    await trx('chat_bot').where({ id: chatBotId }).update({
      flow_type: messageCount >= 3 ? "form" : "menu",
      ...(normalizedName === undefined ? {} : { name: normalizedName }),
      updated_at: new Date(),
    });

    // delete old nodes/edges
    await trx('chat_bot_edge').where({ chatBotId }).delete();

    await trx('chat_bot_node').where({ chatBotId }).delete();

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

    await trx('chat_bot_node').insert(formattedNodes);

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

    await trx('chat_bot_edge').insert(formattedEdges);

    // ---------------------------------
    // Save Triggers
    // ---------------------------------

    await trx('chatbot_triggers').where({ chatbot_id: chatBotId }).delete();

    for (const phoneNumberId of canonicalPhoneIds) {
      for (const triggerWord of triggerWords) {
        await trx('chatbot_triggers').insert({
          chatbot_id: chatBotId,
          phone_number_id: phoneNumberId,
          trigger_word: triggerWord,
          active: currentBot.published === true,
          created_at: new Date(),
        });
      }
    }

    return {
      chatBotId,
      name: normalizedName === undefined
        ? currentBot.name
        : normalizedName,
      triggerWords,
      phoneNumberIds: canonicalPhoneIds,
    };
    });
  }
}

export default new chatBotService();

