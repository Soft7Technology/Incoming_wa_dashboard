import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { buildResponse, matchTrigger } from "@surefy/console/utils";

export const triggerFlow = async ({
    bot,
    phone,
    incomingText
}: {
    bot: any,
    phone: string,
    incomingText: string
}) => {

    console.log("Trigger Flow", phone, incomingText);

    const triggerNode = bot.nodes.find(
        (n: any) => n.type === "trigger"
    );
    console.log('Trigger Node',triggerNode)

    if (!triggerNode) return null;

    const isMatch = matchTrigger(
        triggerNode.data,
        incomingText
    );

    if (!isMatch) return null;

    // Find first node after trigger
    const edge = bot.edges.find(
        (e: any) => e.source === triggerNode.id
    );

    if (!edge) return null;

    const nextNode = bot.nodes.find(
        (n: any) => n.id === edge.target
    );

    if (!nextNode) return null;

    // Create session WITHOUT current node
    await chatSessionModel.create({
        phone_number: phone,
        chatbot_id: bot.id,
        current_node_id: nextNode.id,
        current_flow: bot.flow_type,
        last_message: incomingText,
    });

    // ONLY send response
    return buildResponse(nextNode);
};