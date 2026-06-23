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
      (e:any)=> e?.data?.buttonId === incomingId
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

      //RESET VARIABLES
      if(globalEdge.data){
        updatedVariables = {}
      }

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
      e.sourceHandle === incomingId
  );

  // fallback text matching
  if (!matchedEdge) {
    matchedEdge = edges.find(
      (e: any) =>
        (e.label || "").toLowerCase().trim() ===
        incomingText?.toLowerCase()?.trim()
    );
  }

  if (!matchedEdge) {
    console.log("❌ No matched edge");
    return null;
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