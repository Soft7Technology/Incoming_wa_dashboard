// import chatSessionModel from "@surefy/console/app/models/chatSession.model";
// import userModel from "@surefy/console/app/models/user.model";
// import { executeNode } from "../engine/executeNode";
// import { matchTrigger } from "@surefy/console/utils";

// export const triggerFlow = async ({
//     bot,
//     phone,
//     incomingText,
//     phoneNumberId
// }: {
//     bot: any;
//     phone: string;
//     incomingText: string;
//     phoneNumberId: string;
// }) => {

//     console.log("Trigger Flow", phone, incomingText);

//     let session;

//     // Find trigger node
//     const triggerNode = bot.nodes.find(
//         (n: any) => n.type === "trigger"
//     );

//     if (!triggerNode) {
//         console.log("Trigger node not found");
//         return null;
//     }

//     // Find edge after trigger
//     const edge = bot.edges.find(
//         (e: any) => e.source === triggerNode.id
//     );

//     if (!edge) {
//         console.log("No edge found from trigger");
//         return null;
//     }

//     // Find next node
//     const nextNode = bot.nodes.find(
//         (n: any) => n.id === edge.target
//     );

//     if (!nextNode) {
//         console.log("Next node not found");
//         return null;
//     }

//     console.log("Trigger Node:", triggerNode.id);

//     // Check trigger words
//     const isMatch = matchTrigger(
//         triggerNode.data,
//         incomingText
//     );

//     if (!isMatch) {
//         console.log("Trigger not matched");
//         return null;
//     }

//     /**
//      * Check if message contains a phone/FPO number
//      *
//      * Examples:
//      * "Hi I want to register under 8888888888"
//      * "register 919876543210"
//      */
//     const numberMatch = incomingText.match(/\d{10,13}/);
//     console.log("Number Match", numberMatch)

//     if (numberMatch) {

//         const fpoNumber = numberMatch[0];
//         const cleanNumber = fpoNumber.replace(/\D/g, "");

//         // Add 91 if not already present
//         const phoneNumber = cleanNumber.startsWith("91")
//             ? cleanNumber
//             : `91${cleanNumber}`;

//         console.log("FPO Number Found:", fpoNumber);

//         const fpo = await userModel.findByPhone(phoneNumber);
//         console.log("Fpo details", fpo)

//         if (!fpo) {

//             console.log("FPO Not Found");

//             await chatSessionModel.create({
//                 phone_number: phone,
//                 phoneNumberId,
//                 chatbot_id: bot.id,
//                 active: false,
//                 current_flow: bot.flow_type,
//                 last_message: incomingText,
//                 variables: {
//                     phone_number: phone,
//                     requested_fpo: fpoNumber,
//                     fpo_id: fpo.user_id,
//                     created_by: "fpo",
//                 }
//             });

//             return {
//                 messages: [
//                     {
//                         type: "text",
//                         text: "FPO does not exist."
//                     }
//                 ]
//             };
//         }

//         session = await chatSessionModel.create({
//             phone_number: phone,
//             phoneNumberId,
//             chatbot_id: bot.id,
//             active: true,
//             current_node_id: nextNode.id,
//             current_flow: bot.flow_type,
//             last_message: incomingText,
//             variables: {
//                 phone_number: phone,
//                 requested_fpo: fpoNumber,
//                 fpo_id: fpo.user_id,
//                 created_by: "fpo",
//                 parent_user_id:fpo.id,
//             }
//         });

//         console.log("FPO Found:", fpo.id);
//     }

//     // Find edge after trigger
//     // const edge = bot.edges.find(
//     //     (e: any) => e.source === triggerNode.id
//     // );

//     // if (!edge) {
//     //     console.log("No edge found from trigger");
//     //     return null;
//     // }

//     // // Find next node
//     // const nextNode = bot.nodes.find(
//     //     (n: any) => n.id === edge.target
//     // );

//     // if (!nextNode) {
//     //     console.log("Next node not found");
//     //     return null;
//     // }

//     // const existingSession = await chatSessionModel.findByPhoneNumber(phone)
//     // if (!existingSession) {
//     //     // Create active session
//     //     session = await chatSessionModel.create({
//     //         phone_number: phone,
//     //         phoneNumberId,
//     //         chatbot_id: bot.id,
//     //         active: true,
//     //         current_node_id: nextNode.id,
//     //         current_flow: bot.flow_type,
//     //         last_message: incomingText,
//     //         variables: {
//     //             phone_number: phone,

//     //         }
//     //     });
//     // }

//     const existingSession = await chatSessionModel.findActiveSession({
//         phoneNumber:phone,
//         chatbotId:bot.id,
//         phoneNumberId
//     })

//     if (existingSession) {
//   session = existingSession;
// } else {
//     await chatSessionModel.deactivateActiveSession({
//   phoneNumber: phone,
//   chatbotId: bot.id,
//   phoneNumberId,
// });
//         session = await chatSessionModel.create({
//             phone_number: phone,
//             phoneNumberId,
//             chatbot_id: bot.id,
//             active: true,
//             current_node_id: nextNode.id,
//             current_flow: bot.flow_type,
//             last_message: incomingText,
//             variables: {
//                 phone_number: phone,

//             }
//         });
// }


//     console.log("Session Created:", session.id);

//     return await executeNode({
//         bot,
//         session: {
//             ...session,
//             current_node_id: nextNode.id,
//             variables: {
//                 ...(session.variables || {}),
//                 phone_number: phone
//             }
//         },
//         currentNode: nextNode
//     });
// };






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