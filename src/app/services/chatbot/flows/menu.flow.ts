// services/chatbot/flows/menu.flow.ts

import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { executeNode } from "@surefy/console/services/chatbot/engine/executeNode"

export const menuFlow = async ({
  bot,
  session,
  incomingId,
  incomingText,
  message
}: any) => {

  console.log("Menu Incoming ID",incomingId,incomingText)
  if (session?.variables?.chatbot_delay_token) return { ignoreMessage: true };

  // Active AI conversations accept free text without requiring a button/edge match.
  // Prefer the original message body to preserve casing for node command handling.
  const activeNode = bot.nodes.find((node: any) => node.id === session?.current_node_id);
  if (activeNode?.data?.key === '@whatsapp/ai-agent') {
    return executeNode({ bot, currentNode: activeNode, session: { ...session,
      last_message: message?.text?.body || incomingText || incomingId || '' } });
  }

  // =========================================
  // 1. START FLOW
  // =========================================

  let currentNodeId = session?.current_node_id;

  // ========================================
  // GLOBAL INTERACTIVE Actions
  // ========================================
  if(incomingId){
    // Find ANY edges globally
    console.log("Global")
    const globalEdge = bot.edges.find(
      (e:any)=> e.source === currentNodeId &&
        (e?.data?.buttonId === incomingId || e?.data?.button_id === incomingId ||
          e?.data?.sourceHandle === incomingId || e.sourceHandle === incomingId)
    )

    console.log("Global Edge",globalEdge)

    if(globalEdge){
      console.log("🌍 GLOBAL ACTION:",globalEdge.data.action);

      const nextNode = bot.nodes.find(
        (n:any)=> n.id === globalEdge.target
      )

      if(!nextNode) return null;

      //VARIABLES
      let updatedVariables = session?.variables || {};


      //Update session
      await chatSessionModel.update(session.id,{
        current_node_id: nextNode.id,
        variables: updatedVariables,
        last_message: incomingText
      })

      // Execute Target Node
      return await executeNode({
        bot,
        session:{
          ...session,
          variables:updatedVariables,
          current_node_id: nextNode.id
        },
        currentNode:nextNode
      })
    }
  }


  // First message from user
  if (!currentNodeId) {

    const triggerNode = bot.nodes.find(
      (n: any) => n.type === "trigger"
    );

    if (!triggerNode) return null;

    const startEdge = bot.edges.find(
      (e: any) => e.source === triggerNode.id
    );

    if (!startEdge) return null;

    currentNodeId = startEdge.target;

    // create/update session
    if (session) {
      await chatSessionModel.update(session.id, {
        current_node_id: currentNodeId,
      });
    }
  }




  // =========================================
  // 2. GET CURRENT NODE
  // =========================================
  const currentNode = bot.nodes.find(
    (n: any) => n.id === currentNodeId
  );

  if (!currentNode) return null;

  console.log("📍 Current Node:", currentNode.data?.title);

  const nodeKey = currentNode.data?.key;

  // =========================================
  // 3. ASK QUESTION FLOW
  // =========================================

  if (
    nodeKey === "@whatsapp/ask-question" ||
    nodeKey === "@whatsapp/ask-location"
  ) {

    const variable =
      currentNode.data?.attributes?.variable;

    // save answer in session
    const existingVariables =
      session?.variables || {};

    let answer: any = incomingText;

    // location support
    if (message?.type === "location") {
      answer = {
        latitude: message.location.latitude,
        longitude: message.location.longitude,
      };
    }

    // media support
    if (
      message?.type === "image" ||
      message?.type === "document" ||
      message?.type === "video"
    ) {
      answer = message;
    }

    const updatedVariables = {
      ...existingVariables,
      [variable]: answer,
    };

    console.log("🧠 Variables:", updatedVariables);

    // next edge
    const edge = bot.edges.find(
      (e: any) => e.source === currentNodeId
    );

    if (!edge){
      const updatChatSession = await chatSessionModel.update(session.id,{active:false})
      return updatChatSession
    }

    const nextNode = bot.nodes.find(
      (n: any) => n.id === edge.target
    );

    if (!nextNode){
      const updatChatSession = await chatSessionModel.update(session.id,{active:false})
      return updatChatSession
    };

    await chatSessionModel.update(session.id, {
      current_node_id: nextNode.id,
      last_message: incomingText,
      variables: updatedVariables,
    });

    return executeNode({
      bot,
      session: {
        ...session,
        variables: updatedVariables,
        current_node_id: nextNode.id
      },
      currentNode: nextNode
    });
  }


  // =========================================
  // 4. INTERACTIVE FLOW
  // =========================================

  const edges = bot.edges.filter(
    (e: any) => e.source === currentNodeId
  );

  // Match button/list reply ID
  let matchedEdge = edges.find(
    (e: any) =>
      Boolean(incomingId) && e.sourceHandle === incomingId
  );

  // Match visible option titles even when edges only store an opaque reply ID.
  const normalize = (value: any) => typeof value === 'string'
    ? value.toLowerCase().trim().replace(/\s+/g, ' ') : '';
  const action = currentNode.data?.attributes?.message?.interactive?.action;
  const buttons = currentNode.data?.attributes ? action?.buttons || [] : currentNode.data?.buttons || [];
  const options = [
    ...buttons.map((button: any, index: number) => ({
      id: button?.reply?.id || button?.id || `btn_${index}`,
      title: button?.reply?.title ?? button?.title ?? (typeof button === 'string' ? button : ''),
    })),
    ...(action?.sections || []).flatMap((section: any) => section.rows || []),
  ];
  const matchingOptionIds = options
    .filter((option: any) => normalize(incomingText) && normalize(option.title) === normalize(incomingText))
    .map((option: any) => option.id);

  // fallback text matching
  if (!matchedEdge) {
    matchedEdge = edges.find(
      (e: any) => Boolean(normalize(incomingText)) && (
        normalize(e.label) === normalize(incomingText) ||
        [e.sourceHandle, e.data?.sourceHandle, e.data?.buttonId, e.data?.button_id]
          .some(id => id && matchingOptionIds.includes(id))
      )
    );
  }

  if (!matchedEdge) {
    console.log("❌ No matched edge");
    // A default menu should answer arbitrary text again while awaiting a choice.
    // Question answers and delay waits are handled above and must not restart.
    if (bot.isDefault && incomingText && !incomingId &&
        (nodeKey === '@whatsapp/send-button-message' || nodeKey === '@whatsapp/send-list-message')) {
      return executeNode({ bot, session, currentNode });
    }
    return { ignoreMessage: true };
  }

  const nextNode = bot.nodes.find(
    (n: any) => n.id === matchedEdge.target
  );

  if (!nextNode) return null;

  await chatSessionModel.update(session.id, {
    current_node_id: nextNode.id,
    last_message: incomingText,
  });

  console.log("➡️ Next Node:", nextNode.data?.title);

  return executeNode({
    bot,
    session: {
      ...session,
      current_node_id: nextNode.id
    },
    currentNode: nextNode
  });
};
