import chatSessionModel from '@surefy/console/app/models/chatSession.model';
import chatBotModel from '@surefy/console/models/chatbot.model';
import chatBotNodeModel from '@surefy/console/models/chatBotNode.model';
import chatBotEdgeModel from '@surefy/console/models/chatBotEdge.model';
import messageService from "@surefy/console/services/message.service"
import nodemailer from "nodemailer";
import { flowRouter } from  './flow.route'
import contactModel from '@surefy/console/models/contact.model';

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function handleIncomingMessageChatBot(phoneNumberId: any, message: any, profile_name:any) {
  try {

    console.log("📥 Incoming:", phoneNumberId, message);

    const phone = message.from;


    const incomingId =
      message?.interactive?.button_reply?.id ||
      message?.interactive?.list_reply?.id ||
      null;

    const incomingText = (
      message?.text?.body ||
      message?.interactive?.button_reply?.title ||
      message?.interactive?.list_reply?.title ||
      ""
    ).toLowerCase().trim();

    console.log("📩 Parsed:", { phone, incomingText });
    console.log("Incoming Id",incomingId)

    // 1️⃣ Get bot
    console.log("🔍 Finding bot for phone number:", phoneNumberId);
    const bot: any = await chatBotModel.getPublishedBotByPhoneNumberId(phoneNumberId);
    console.log("🤖 Found bot:", bot ? bot.name : "No bot");
    if (!bot) return null;

    //check exist contact
    const existContact = await contactModel.findByPhone(bot.user_id,message.from)
    console.log("Existing Contant",existContact)
    if(!existContact){
      const newContact = await contactModel.create({
        user_id: bot.user_id,
        company_id:bot.company_id,
        phone_number:message.from,
        name:profile_name
      })
      console.log("New Contact", newContact)
    }

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

    // console.log("Nodes", JSON.stringify(bot.nodes))
    // console.log("Edges", JSON.stringify(bot.edges))

    const response = await flowRouter({
      bot,
      phone,
      incomingText,
      incomingId,
      message,
      phoneNumberId
    })

    // // 3️⃣ Resolve flow WITHOUT session
    // const response = resolveFlow(bot, incomingText,incomingId);
    // console.log("Response", JSON.stringify(response))

    // 4️⃣ Send message
    if (response) {
      await messageService.sendChatBotMessage(phoneNumberId, phone, response);
    } else {
      console.log("⚠️ No response generated to send");
    }

    return response;

  } catch (error) {
    console.error("❌ Chatbot Error:", error);
    return null;
  }
}


// function resolveFlow(bot: any, incomingText: string, incomingId?: string) {
//   incomingText = incomingText.toLowerCase().trim();
//   console.log("Incoming Id", incomingId, bot)

//   // 1️⃣ Trigger
//   const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");

//   if (triggerNode) {
//     const triggerData = safeJSON(triggerNode.data);
//     const isMatch = matchTrigger(triggerData, incomingText);

//     if (isMatch) {
//       const edge = bot.edges.find((e: any) => e.source === triggerNode.id);
//       if (!edge) return null;

//       const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
//       return buildResponse(nextNode);
//     }
//   }

//   // 🔥 2️⃣ MATCH USING LABEL ↔ incomingText
//   if (incomingText) {
//     const edge = bot.edges.find((e: any) => {
//       const label = (e.label || "").toLowerCase().trim();
//       const text = incomingText.toLowerCase().trim();

//       console.log("🔍 Matching:", { label, text });

//       return label === text;
//     });

//     if (edge) {
//       console.log("✅ Matched Edge:", edge);

//       const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
//       return buildResponse(nextNode);
//     }
//   }

//   // 🔥 2️⃣ PRIMARY: MATCH USING incomingId
//   if (incomingId) {
//     const edge = bot.edges.find((e: any) => {
//       const handle = e?.data?.sourceHandle;   // 👈 BEST PRACTICE
//       const label = (e.label || "").toLowerCase();

//       console.log("BOT", handle, label)

//       return (
//         handle === incomingId ||             // preferred
//         label === incomingId.toLowerCase()   // fallback
//       );
//     });

//     if (edge) {
//       const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
//       return buildResponse(nextNode);
//     }
//   }

//   // 3️⃣ LAST fallback → text (not recommended but okay)
//   for (const edge of bot.edges) {
//     const label = (edge.label || "").toLowerCase().trim();

//     if (label === incomingText) {
//       const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
//       return buildResponse(nextNode);
//     }
//   }

//   return null;
// }


function safeJSON(data: any) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return {};
  }
}

// export default function sendEmail(to: string, subject: string, text: string,html?: string) {
//   console.log(`📧 Sending email to ${to}: ${subject}\n${text}`);
//   return transporter.sendMail({
//     from : `"Your App Name" <${process.env.SMTP_USER}>`,
//     to,
//     subject,
//     text,
//     html,
//   })
//   // Integrate with actual email service here (e.g., SendGrid, SES)
// }

// function matchTrigger(data: any, text: string) {
//   const keywords = data?.keywords || [];
//   const logic = data?.matchingLogic || "contains";

//   if (logic === "exact") {
//     return keywords.some((k: string) => k.toLowerCase() === text);
//   }

//   return keywords.some((k: string) => text.includes(k.toLowerCase()));
// }



// export const transformFeatures = (features: any) => {
//   const limits: any = {};
//   const usage: any = {};

//   Object.keys(features).forEach((key) => {
//     limits[key] = {
//       limit: features[key].limit_value
//     };

//     usage[key] = 0; // initialize usage
//   });

//   return { limits, usage };
// };


// async function handleUserFlow(bot: any, session: any, text: string, phone: string) {
//   const normalized = text.toLowerCase().trim();

//   // 1️⃣ Check trigger again (restart flow)
//   const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");
  

//   if (triggerNode) {
//     const isMatch = matchTrigger(triggerNode.data, normalized);

//     if (isMatch) {
//       console.log("🔄 Restarting flow");
//       return await startNewFlow(bot, phone, normalized);
//     }
//   }

//   // 2️⃣ Get current node
//   const currentNode = bot.nodes.find(
//     (n: any) => n.id === session.last_node_id
//   );

//   if (!currentNode) return null;

//   console.log("📍 Current Node:", currentNode.type);

//   // 3️⃣ If interactive → handle button
//   if (currentNode.type === "interactive") {
//     return await handleInteractive(bot, session, normalized);
//   }

//   // 4️⃣ Otherwise → go next
//   return await goToNextNode(bot, session, normalized);
// }


// async function handleInteractive(bot: any, session: any, text: string) {
//   const currentNode = bot.nodes.find(
//     (n: any) => n.id === session.last_node_id
//   );

//   if (!currentNode) return null;

//   const edges = bot.edges.filter(
//     (e: any) => e.source === currentNode.id
//   );

//   console.log("👉 Matching button:", text);

//   // 🔥 MATCH USING LABEL (NOT btn_id)
//   const matchedEdge = edges.find((e: any) => {
//     const label = (e.label || "").toLowerCase().trim();
//     return label === text;
//   });

//   if (!matchedEdge) {
//     console.log("❌ No match");
//     return null;
//   }

//   const nextNode = bot.nodes.find(
//     (n: any) => n.id === matchedEdge.target
//   );

//   if (!nextNode) return null;

//   await chatSessionModel.update(session.id, {
//     last_node_id: nextNode.id,
//     last_message: text,
//   });

//   return buildResponse(nextNode);
// }

// async function goToNextNode(bot: any, session: any, text: string) {
//   const currentNode = bot.nodes.find(
//     (n: any) => n.id === session.last_node_id
//   );

//   if (!currentNode) return null;

//   const edge = bot.edges.find((e: any) => e.source === currentNode.id);
//   if (!edge) return null;

//   const nextNode = bot.nodes.find(
//     (n: any) => n.id === edge.target
//   );

//   if (!nextNode) return null;

//   await chatSessionModel.update(session.id, {
//     last_node_id: nextNode.id,
//     last_message: text,
//   });

//   return buildResponse(nextNode);
// }

// async function startNewFlow(bot: any, phone: string, text: string) {
//   const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");
//   if (!triggerNode) return null;

//   const isMatch = matchTrigger(triggerNode.data, text);
//   if (!isMatch) return null;

//   const edge = bot.edges.find((e: any) => e.source === triggerNode.id);
//   if (!edge) return null;

//   const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
//   if (!nextNode) return null;

//   // create session
//   await chatSessionModel.create({
//     chatBotId: bot.id,
//     phone_number: phone,
//     last_node_id: nextNode.id,
//     last_message: text,
//   });

//   return buildResponse(nextNode);
// }


// function parseJSON(data: any) {
//   try {
//     return typeof data === 'string' ? JSON.parse(data) : data;
//   } catch {
//     return {};
//   }
// }

// // function buildResponse(node: any) {
// //   console.log('NextNode', JSON.stringify(node))
// //   const data = safeJSON(node.data);

// //   if (node.type === "message") {
// //     return {
// //       type: "text",
// //       text: data.text || "",
// //     };
// //   }

// //   const type = data.interactiveType

// //   // Button Interactive  
// //   if (type === "buttons") {
// //     return {
// //       type: "interactive",
// //       interactive: {
// //         type: "button",
// //         body: {
// //           text: data.text || "Choose an option",
// //         },
// //         footer: data.footer || undefined,
// //         action: {
// //           buttons: (data.buttons || []).map((btn: any, i: number) => ({
// //             type: "reply",
// //             reply: {
// //               id: btn.id || `btn_${i}`,
// //               title: btn.title || btn,
// //             },
// //           })),
// //         },
// //       },
// //     };
// //   }

// //   // 📋 LIST MESSAGE BUILDER
// //   if (type === "list") {
// //     const rows = (data.listItems || []).map((item: any, i: number) => ({
// //       id: item.id || `row_${i}`,
// //       title: item.title || 'Option',
// //       description: item.description || ""
// //     }))

// //     const interactive: any = {
// //       type: "list",

// //       // ✅ HEADER (optional)
// //       header: data.header
// //         ? (typeof data.header === "string"
// //           ? { type: "text", text: data.header }
// //           : data.header)
// //         : undefined,

// //       // ✅ BODY (required)
// //       body: typeof data.body === "string"
// //         ? { text: data.body }
// //         : data.body || { text: "Choose an option" },

// //       // ✅ FOOTER (optional)
// //       footer: data.footer
// //         ? (typeof data.footer === "string"
// //           ? { text: data.footer }
// //           : data.footer)
// //         : undefined,

// //       // ✅ ACTION (required)
// //       action: {
// //         button: data.listButtonText || "Select Option",
// //         sections: [
// //           {
// //             title: data.listSectionTitle || "Options",
// //             rows
// //           }
// //         ],
// //       }
// //     };

// //     return {
// //       type: "interactive",
// //       interactive
// //     };
// //   }

// //   // 🔗 CTA URL BUTTON
// //   if (type === "cta_url") {
// //     const interactive: any = {
// //       type: "cta_url",
// //       body: {
// //         text: data.text || ""
// //       },
// //       footer: data.footer || undefined,
// //       action: {
// //         name: "cta_url",
// //         parameters: {
// //           display_text: data.ctaDisplayText || "Open",
// //           url: data.ctaUrl
// //         }
// //       }
// //     };

// //     // Optional Header
// //     if (data.headerType === 'image' && data.headerMedia) {
// //       interactive.header = {
// //         type: "image",
// //         image: {
// //           link: data.headerMedia
// //         }
// //       };
// //     } else if (data.headerType === 'text' && data.header) {
// //       interactive.header = {
// //         type: "text",
// //         text: data.header
// //       };
// //     }
// //     return {
// //       type: "interactive",
// //       interactive
// //     }
// //   }

// //   // 🎞️ CAROUSEL (Meta = "product" or "generic template")
// //   if (type === "carousel") {
// //     return {
// //       type: "interactive",
// //       interactive: {
// //         type: "carousel", // or "catalog_message" depending on API
// //         body: {
// //           text: data.text || "Browse items"
// //         },
// //         action: {
// //           cards: data.carouselCards || []
// //         }
// //       }
// //     };
// //   }

// //   // 🖼️ MEDIA MESSAGE (image header)
// //   if (type === "media") {
// //     return {
// //       type: "image",
// //       image: {
// //         link: data.mediaUrl,
// //         caption: data.text || ""
// //       }
// //     };
// //   }

// //   // Interactive Handling
// //   if (node.type === "buttons") {
// //   }

// //   return null;
// // }
