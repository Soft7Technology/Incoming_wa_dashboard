import chatSessionModel from '../app/models/chatSession.model';
import chatBotModel from '../app/models/chatbot.model';
import chatBotNodeModel from './models/chatBotNode.model';
import chatBotEdgeModel from './models/chatBotEdge.model';
import messageService from './services/message.service';

export async function handleIncomingMessageChatBot(phoneNumberId: any, message: any) {
  try {
    console.log("📥 Incoming:", phoneNumberId, message);

    const phone = message.from;

    const incomingText = (
      message?.text?.body ||
      message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.title ||
      ""
    ).toLowerCase().trim();

    console.log("📩 Parsed:", { phone, incomingText });

    // 1️⃣ Get bot
    const bot: any = await chatBotModel.getPublishedBotByUser(phoneNumberId);
    if (!bot) return null;

    // 2️⃣ Load nodes + edges
    const rawNodes = await chatBotNodeModel.findByChatBotId(bot.id) || [];
    const rawEdges = await chatBotEdgeModel.findByChatBotId(bot.id) || [];

    bot.nodes = rawNodes.map((n: any) => ({
      ...n,
      data: safeJSON(n.data),
    }));

    bot.edges = rawEdges.map((e: any) => ({
      ...e,
      data: safeJSON(e.data),
    }));

    console.log("📦 Nodes:", bot.nodes.length);
    console.log("🔗 Edges:", bot.edges.length);

    // 3️⃣ Resolve flow WITHOUT session
    const response = resolveFlow(bot, incomingText);

    // 4️⃣ Send message
    if (response) {
      await messageService.sendChatBotMessage(phoneNumberId, phone, response);
    } else {
      console.log("⚠️ No response generated");
    }

    return response;

  } catch (error) {
    console.error("❌ Chatbot Error:", error);
    return null;
  }
}


function resolveFlow(bot: any, text: string) {
  text = text.toLowerCase().trim();

  // 1️⃣ Check TRIGGER node
  const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");

  if (triggerNode) {
    const triggerData = safeJSON(triggerNode.data);

    const isMatch = matchTrigger(triggerData, text);

    if (isMatch) {
      const edge = bot.edges.find((e: any) => e.source === triggerNode.id);
      if (!edge) return null;

      const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
      return buildResponse(nextNode);
    }
  }

  // 2️⃣ Check INTERACTIVE edges (button matching)
  for (const edge of bot.edges) {
    const label = (edge.label || "").toLowerCase().trim();

    if (label === text) {
      const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
      return buildResponse(nextNode);
    }
  }

  // 3️⃣ Optional fallback (first message node)
  const firstMessageNode = bot.nodes.find((n: any) => n.type === "message");

  if (firstMessageNode) {
    return buildResponse(firstMessageNode);
  }

  return null;
}


function safeJSON(data: any) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return {};
  }
}

function matchTrigger(data: any, text: string) {
  const keywords = data?.keywords || [];
  const logic = data?.matchingLogic || "contains";

  if (logic === "exact") {
    return keywords.some((k: string) => k.toLowerCase() === text);
  }

  return keywords.some((k: string) => text.includes(k.toLowerCase()));
}


async function handleUserFlow(bot: any, session: any, text: string, phone: string) {
  const normalized = text.toLowerCase().trim();

  // 1️⃣ Check trigger again (restart flow)
  const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");
  

  if (triggerNode) {
    const isMatch = matchTrigger(triggerNode.data, normalized);

    if (isMatch) {
      console.log("🔄 Restarting flow");
      return await startNewFlow(bot, phone, normalized);
    }
  }

  // 2️⃣ Get current node
  const currentNode = bot.nodes.find(
    (n: any) => n.id === session.last_node_id
  );

  if (!currentNode) return null;

  console.log("📍 Current Node:", currentNode.type);

  // 3️⃣ If interactive → handle button
  if (currentNode.type === "interactive") {
    return await handleInteractive(bot, session, normalized);
  }

  // 4️⃣ Otherwise → go next
  return await goToNextNode(bot, session, normalized);
}


async function handleInteractive(bot: any, session: any, text: string) {
  const currentNode = bot.nodes.find(
    (n: any) => n.id === session.last_node_id
  );

  if (!currentNode) return null;

  const edges = bot.edges.filter(
    (e: any) => e.source === currentNode.id
  );

  console.log("👉 Matching button:", text);

  // 🔥 MATCH USING LABEL (NOT btn_id)
  const matchedEdge = edges.find((e: any) => {
    const label = (e.label || "").toLowerCase().trim();
    return label === text;
  });

  if (!matchedEdge) {
    console.log("❌ No match");
    return null;
  }

  const nextNode = bot.nodes.find(
    (n: any) => n.id === matchedEdge.target
  );

  if (!nextNode) return null;

  await chatSessionModel.update(session.id, {
    last_node_id: nextNode.id,
    last_message: text,
  });

  return buildResponse(nextNode);
}

async function goToNextNode(bot: any, session: any, text: string) {
  const currentNode = bot.nodes.find(
    (n: any) => n.id === session.last_node_id
  );

  if (!currentNode) return null;

  const edge = bot.edges.find((e: any) => e.source === currentNode.id);
  if (!edge) return null;

  const nextNode = bot.nodes.find(
    (n: any) => n.id === edge.target
  );

  if (!nextNode) return null;

  await chatSessionModel.update(session.id, {
    last_node_id: nextNode.id,
    last_message: text,
  });

  return buildResponse(nextNode);
}

async function startNewFlow(bot: any, phone: string, text: string) {
  const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");
  if (!triggerNode) return null;

  const isMatch = matchTrigger(triggerNode.data, text);
  if (!isMatch) return null;

  const edge = bot.edges.find((e: any) => e.source === triggerNode.id);
  if (!edge) return null;

  const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
  if (!nextNode) return null;

  // create session
  await chatSessionModel.create({
    chatBotId: bot.id,
    phone_number: phone,
    last_node_id: nextNode.id,
    last_message: text,
  });

  return buildResponse(nextNode);
}

async function handleInteractiveReply(bot: any, session: any, buttonText: string, phone: string) {
  console.log("🔍 Finding current node:", session.last_node_id);

  // 1️⃣ current node
  const currentNode = bot.nodes.find(
    (n: any) => n.id === session.last_node_id
  );
  if (!currentNode) return null;

  // 2️⃣ outgoing edges
  const edges = bot.edges.filter(
    (e: any) => e.source === currentNode.id
  );

  console.log("👉 Available edges:", edges);

  // 3️⃣ MATCH USING BUTTON TITLE
  const matchedEdge = edges.find((e: any) => {
    const label = (e.label || "").toLowerCase().trim();
    return label === buttonText.toLowerCase().trim();
  });

  if (!matchedEdge) {
    console.log("❌ No match for:", buttonText);
    return null;
  }

  console.log("✅ Matched edge:", matchedEdge);

  // 4️⃣ next node
  const nextNode = bot.nodes.find(
    (n: any) => n.id === matchedEdge.target
  );
  if (!nextNode) return null;

  // 5️⃣ update session
  await chatSessionModel.update(session.id, {
    last_node_id: nextNode.id,
    last_message: buttonText,
  });

  // 6️⃣ return response
  return buildResponse(nextNode);
}

async function handleTextMessage(bot: any, session: any, text: string, phone: string) {
  const normalized = text.toLowerCase().trim();

  // 1. Check trigger AGAIN (restart flow)
  const triggerNode = bot.nodes.find((n: any) => n.type === 'trigger');

  if (triggerNode) {
    const triggerData = parseJSON(triggerNode.data);

    const isMatch = matchTrigger(triggerData, normalized);

    if (isMatch) {
      console.log('🔄 Re-triggering flow');
      return await startNewFlow(bot, phone, text);
    }
  }

  // 2. Continue current node
  const currentNode = bot.nodes.find((n: any) => n.id === session.lastNodeId);

  if (!currentNode) return null;

  // 3. If current node is interactive → resend it
  if (currentNode.type === 'interactive') {
    return buildResponse(currentNode);
  }

  // 4. Otherwise go to next node
  const nextEdge = bot.edges.find((e: any) => e.source === currentNode.id);

  if (!nextEdge) return null;

  const nextNode = bot.nodes.find((n: any) => n.id === nextEdge.target);

  if (!nextNode) return null;

  // 5. Update session
  await chatSessionModel.update(session.id, {
    lastNodeId: nextNode.id,
  });

  return buildResponse(nextNode);
}

function parseJSON(data: any) {
  try {
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return {};
  }
}

function buildResponse(node: any) {
  const data = safeJSON(node.data);

  if (node.type === "message") {
    return {
      type: "text",
      text: data.text || "",
    };
  }

  if (node.type === "interactive") {
    return {
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: data.text || "Choose an option",
        },
        action: {
          buttons: (data.buttons || []).map((btn: string, i: number) => ({
            type: "reply",
            reply: {
              id: `btn_${i}`,
              title: btn,
            },
          })),
        },
      },
    };
  }

  return null;
}
