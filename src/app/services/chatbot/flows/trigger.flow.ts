
import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { executeNode } from "../engine/executeNode";
import { matchTrigger } from "@surefy/console/utils";
import { endSession } from "../engine/executeNode";

export const triggerFlow = async ({
  bot,
  phone,
  incomingText,
  phoneNumberId,
}: {
  bot: any;
  phone: string;
  incomingText: string;
  phoneNumberId: string;
}) => {
  console.log(
    "Trigger Flow",
    phone,
    incomingText
  );

  // ----------------------------------
  // Find Trigger Node
  // ----------------------------------

  const triggerNode = bot.nodes.find(
    (node: any) => node.type === "trigger"
  );

  if (!triggerNode) {
    console.log(
      "Trigger node not found"
    );
    return null;
  }

  // ----------------------------------
  // Check Trigger Match
  // ----------------------------------

  const isMatch = await matchTrigger(phoneNumberId,incomingText);

  if (!isMatch) {
    console.log(
      "Trigger not matched"
    );
    return ;
  }

  // ----------------------------------
  // Find First Edge
  // ----------------------------------

  const edge = bot.edges.find(
    (edge: any) =>
      edge.source === triggerNode.id
  );

  if (!edge) {
    // await endSession(session.id);
    console.log(
      "No edge found after trigger"
    );
    return null;
  }

  // ----------------------------------
  // Find First Node After Trigger
  // ----------------------------------

  const nextNode = bot.nodes.find(
    (node: any) =>
      node.id === edge.target
  );

  if (!nextNode) {
    console.log(
      "Next node not found"
    );
    return null;
  }

  // ----------------------------------
  // Check Existing Session
  // ----------------------------------

  let session =
    await chatSessionModel.findActiveSession({
      phoneNumber: phone,
      chatbotId: bot.id,
      phoneNumberId,
    });

  // ----------------------------------
  // Create Session If Not Exists
  // ----------------------------------

  if (!session) {
    session =
      await chatSessionModel.create({
        phone_number: phone,
        phoneNumberId,
        chatbot_id: bot.id,
        active: true,
        current_node_id: nextNode.id,
        current_flow:
          bot.flow_type,
        last_message:
          incomingText,
        variables: {
          phone_number: phone,
        },
      });

    console.log(
      "New session created:",
      session.id
    );
  } else {
    console.log(
      "Existing session found:",
      session.id
    );
  }

  // ----------------------------------
  // Execute First Node
  // ----------------------------------

  return await executeNode({
    bot,
    session: {
      ...session,
      current_node_id:
        nextNode.id,
      variables: {
        ...(session.variables ||
          {}),
        phone_number: phone,
      },
    },
    currentNode: nextNode,
  });
};