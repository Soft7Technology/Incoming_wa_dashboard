import chatSessionModel from "@surefy/console/app/models/chatSession.model";
import { buildResponse } from "../../../utils"


export const formFlow = async ({
    bot,
    session,
    incomingText,
    incomingId
}: any) => {

    console.log("Incoming:", incomingText);
    console.log("Button ID:", incomingId);

    // Store latest user message
    await chatSessionModel.update(session.id, {
        last_message: incomingText
    });

    let edge = null;

    /**
     * CASE 1:
     * Initial interactive selection
     * current_node_id is NULL
     */
    if (!session.current_node_id && incomingId) {

        edge = bot.edges.find(
            (e: any) =>
                e.data?.sourceHandle === incomingId
        );

    }

    /**
     * CASE 2:
     * Existing flow navigation
     */
    else if (session.current_node_id) {

        // Interactive node routing
        if (incomingId) {

            edge = bot.edges.find(
                (e: any) =>
                    e.source === session.current_node_id &&
                    e.data?.sourceHandle === incomingId
            );

        }

        // Sequential text/form routing
        else {

            edge = bot.edges.find(
                (e: any) =>
                    e.source === session.current_node_id
            );
        }
    }

    console.log("Matched Edge:", edge);

    if (!edge) return null;

    // Find next node
    const nextNode = bot.nodes.find(
        (n: any) => n.id === edge.target
    );

    if (!nextNode) return null;

    console.log("Next Node:", nextNode);

    // NOW store next node
    await chatSessionModel.update(session.id, {
        current_node_id: nextNode.id
    });

    return buildResponse(nextNode);
};