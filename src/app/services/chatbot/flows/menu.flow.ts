// services/chatbot/flows/menu.flow.ts

import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { executeNode } from "@surefy/console/services/chatbot/engine/executeNode"
import { downloadImage } from "@surefy/console/utils";

export const menuFlow = async ({
  bot,
  session,
  incomingId,
  incomingText,
  message
}: any) => {

  console.log("Menu Incoming ID",incomingId,incomingText)
  
  // =========================================
  // START FLOW
  // =========================================

  let currentNodeId = session?.current_node_id;

  // =========================================
  // GET CURRENT NODE
  // =========================================
  const currentNode = bot.nodes.find(
    (n: any) => n.id === currentNodeId
  );

  if (!currentNode) return null;

  console.log("📍 Current Node:", currentNode.data?.title);

  const nodeKey = currentNode.data?.key;

  // ========================================
  // GLOBAL INTERACTIVE Actions
  // ========================================
  if(incomingId){
    // Find ANY edges globally
    let updatedVariables;
    let variable;
    let variableValue = incomingText;

    console.log("Global")
    const globalEdge = bot.edges.find(
      (e:any)=> e?.data?.button_id === incomingId
    )

    console.log("Global Edge",globalEdge)

    if(globalEdge){
      console.log("🌍 GLOBAL ACTION:",globalEdge.data.action);

      const nextNode = bot.nodes.find(
        (n:any)=> n.id === globalEdge.target
      )

      if (nodeKey === "@whatsapp/send-list-message" || 
                      "@whatsapp/send-button-message") {
        variable = currentNode.data?.attributes?.variable;

        console.log("Variable Identify", variable)

        // save answer in session
        const existingVariables =
          session?.variables || {};

        // if(message?.type === 'interactve'){
        //   variableValue = message?.interactive?.list_reply?.title 
        // }

        if(variable){
          updatedVariables = {
          ...existingVariables,
          [variable]: variableValue
        };

        }
      }

      if(!nextNode) return null;

      //VARIABLES

      //RESET VARIABLES
      if(globalEdge.data && !variable){
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
  //  ASK QUESTION FLOW
  // =========================================

  if (
    nodeKey === "@whatsapp/ask-question" ||
    nodeKey === "@whatsapp/send-button-message" ||
    nodeKey === "@whatsapp/send-list-message" ||
    nodeKey === "@whatsapp/ask-location"
  ) {

    const variable =
      currentNode.data?.attributes?.variable;

    console.log("Variable Identify",variable)

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

    //interactive support
    if(message?.type === 'interactve'){
      answer = message?.interactive?.list_reply?.title 
    }

    // media support
    if (
      message?.type === "image" ||
      message?.type === "document" ||
      message?.type === "video"
    ) {
      const mediaUrl = await downloadImage(message?.image.id)
      answer = mediaUrl.firebaseUrl;
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

    if (!edge) return null;

    const nextNode = bot.nodes.find(
      (n: any) => n.id === edge.target
    );

    if (!nextNode) return null;

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
  // INTERACTIVE FLOW
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