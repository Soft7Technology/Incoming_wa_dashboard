import chatSessionModel from '../app/models/chatSession.model';
import chatBotModel from '../app/models/chatbot.model';
import chatBotNodeModel from './models/chatBotNode.model';
import chatBotEdgeModel from './models/chatBotEdge.model';
import messageService from './services/message.service';
import nodemailer from "nodemailer";
import metaService from './services/meta.service';
import { parsePhoneNumberFromString } from "libphonenumber-js";



export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});



export const generateInviteTemplate = ({
    name,
    email,
    role,
    inviteUrl
}: {
    name?: string;
    email: string;
    role: string;
    inviteUrl: string;
}) => {
    return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: auto; padding: 20px;">

        <h2 style="color: #111;">
            You're Invited to Join Soft 7
        </h2>

        <p>Hello${name ? ` ${name}` : ''},</p>

        <p>
            You have been invited to join the platform as 
            <strong>${role}</strong>.
        </p>

        <p>
            Click the button below to set your password and activate your account.
        </p>

        <div style="margin: 30px 0;">
            <a 
                href="${inviteUrl}"
                style="
                    background-color: #000;
                    color: #fff;
                    padding: 14px 24px;
                    text-decoration: none;
                    border-radius: 8px;
                    display: inline-block;
                    font-weight: bold;
                "
            >
                Set Password & Join Team
            </a>
        </div>

        <p>
            If the button does not work, copy and paste this link:
        </p>

        <p>
            <a href="${inviteUrl}">
                ${inviteUrl}
            </a>
        </p>

        <hr style="margin: 30px 0;" />

        <p style="font-size: 13px; color: #777;">
            This invitation link will expire in 24 hours.
        </p>

        <p style="font-size: 13px; color: #777;">
            Soft 7 Team
        </p>

    </div>
    `;
};


// export async function handleIncomingMessageChatBot(phoneNumberId: any, message: any) {
//   try {
//     console.log("📥 Incoming:", phoneNumberId, message);

//     const phone = message.from;

//     const incomingId =
//       message?.interactive?.button_reply?.id ||
//       message?.interactive?.list_reply?.id ||
//       null;

//     const incomingText = (
//       message?.text?.body ||
//       message?.interactive?.button_reply?.title ||
//       message?.interactive?.list_reply?.title ||
//       ""
//     ).toLowerCase().trim();

//     console.log("📩 Parsed:", { phone, incomingText });

//     // 1️⃣ Get bot
//     console.log("🔍 Finding bot for phone number:", phoneNumberId);
//     const bot: any = await chatBotModel.getPublishedBotByPhoneNumberId(phoneNumberId);
//     console.log("🤖 Found bot:", bot ? bot.name : "No bot");
//     console.log("🤖 Found bot:", bot ? bot.name : "No bot");
//     if (!bot) return null;

//     // 2️⃣ Load nodes + edges
//     const rawNodes = await chatBotNodeModel.findByChatBotId(bot.id) || [];
//     const rawEdges = await chatBotEdgeModel.findByChatBotId(bot.id) || [];

//     bot.nodes = rawNodes.map((n: any) => ({
//       ...n,
//       data: safeJSON(n.data),
//     }));

//     bot.edges = rawEdges.map((e: any) => ({
//       ...e,
//       data: safeJSON(e.data),
//     }));

//     console.log("📦 Nodes:", bot.nodes.length);
//     console.log("🔗 Edges:", bot.edges.length);

//     // console.log("Nodes", JSON.stringify(bot.nodes))
//     // console.log("Edges", JSON.stringify(bot.edges))


//     // 3️⃣ Resolve flow WITHOUT session
//     const response = resolveFlow(bot, incomingText,incomingId);
//     console.log("Response", JSON.stringify(response))

//     // 4️⃣ Send message
//     if (response) {
//       await messageService.sendChatBotMessage(phoneNumberId, phone, response);
//     } else {
//       console.log("⚠️ No response generated");
//     }

//     return response;

//   } catch (error) {
//     console.error("❌ Chatbot Error:", error);
//     return null;
//   }
// }


function resolveFlow(bot: any, incomingText: string, incomingId?: string) {
  incomingText = incomingText.toLowerCase().trim();
  console.log("Incoming Id", incomingId, bot)

  // 1️⃣ Trigger
  const triggerNode = bot.nodes.find((n: any) => n.type === "trigger");

  if (triggerNode) {
    const triggerData = safeJSON(triggerNode.data);
    const isMatch = matchTrigger(triggerData, incomingText);

    if (isMatch) {
      const edge = bot.edges.find((e: any) => e.source === triggerNode.id);
      if (!edge) return null;

      const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
      return buildResponse(nextNode);
    }
  }

  // 🔥 2️⃣ MATCH USING LABEL ↔ incomingText
  if (incomingText) {
    const edge = bot.edges.find((e: any) => {
      const label = (e.label || "").toLowerCase().trim();
      const text = incomingText.toLowerCase().trim();

      console.log("🔍 Matching:", { label, text });

      return label === text;
    });

    if (edge) {
      console.log("✅ Matched Edge:", edge);

      const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
      return buildResponse(nextNode);
    }
  }

  // 🔥 2️⃣ PRIMARY: MATCH USING incomingId
  if (incomingId) {
    const edge = bot.edges.find((e: any) => {
      const handle = e?.data?.sourceHandle;   // 👈 BEST PRACTICE
      const label = (e.label || "").toLowerCase();

      console.log("BOT", handle, label)

      return (
        handle === incomingId ||             // preferred
        label === incomingId.toLowerCase()   // fallback
      );
    });

    if (edge) {
      const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
      return buildResponse(nextNode);
    }
  }

  // 3️⃣ LAST fallback → text (not recommended but okay)
  for (const edge of bot.edges) {
    const label = (edge.label || "").toLowerCase().trim();

    if (label === incomingText) {
      const nextNode = bot.nodes.find((n: any) => n.id === edge.target);
      return buildResponse(nextNode);
    }
  }

  return null;
}


export function safeJSON(data: any) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return {};
  }
}


// export function replaceVariables(obj:any, variables:Record<string, any>):any{
//   console.log("Variables", obj,variables)
//   console.log("Typeof",typeof obj)

//   if(typeof obj === "string"){
//     return obj.replace(/\{\{(.*?)\}\}/g,(_,key)=> {
//       console.log("key",variables[key.trim()])
//       return variables[key.trim()]?? "";
//     })
//   }

//   if(Array.isArray(obj)){
//     return obj.map(item => replaceVariables(item,variables))
//   }

//   if(obj && typeof obj === "object"){
//     const result:any = {}

//     for(const key in obj){
//       result[key] = replaceVariables(obj[key], variables)
//     }

//     return result;
//   }

//   return obj;
// }


export function replaceVariables(
  obj: any,
  variables: Record<string, any>
): any {
  console.log("Variables", obj,variables)
  console.log("Typeof",typeof obj)

  if (typeof obj === "string") {
     console.log("STRING VALUE:", obj);

    // Entire object injection
    if (obj.trim() === "{{data}}" || "{{variable}}") {
      console.log("MATCHED DATA");
      return variables;
    }

    return obj.replace(/\{\{(.*?)\}\}/g, (_, key) => {
      const value = key
        .trim()
        .split(".")
        .reduce(
          (o: any, k: string) => o?.[k],
          variables
        );

      return value ?? "";
    });
  }

  if (Array.isArray(obj)) {
    return obj.map(item => replaceVariables(item, variables));
  }

  if (obj && typeof obj === "object") {
    const result: any = {};

    for (const key in obj) {
      result[key] = replaceVariables(obj[key], variables);
    }

    return result;
  }

  return obj;
}


export const downloadImage = async (mediaId: string) => {
    console.log("MediaId:", mediaId);
    try {
      const mediaUrl = metaService.handleMedia(mediaId)
      console.log("Media Url",mediaUrl)
      return mediaUrl
    } catch (error: any) {
        console.error(
            '❌ Error downloading image:',
            error.response?.status,
            error.response?.data || error.message
        );
        throw error;
    }
};


export default function sendEmail(to: string, subject: string, text: string,html?: string) {
  console.log(`📧 Sending email to ${to}: ${subject}\n${text}`);
  return transporter.sendMail({
    from : `"Your App Name" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  })
  // Integrate with actual email service here (e.g., SendGrid, SES)
}

export function matchTrigger(data: any, text: string) {
  const keywords = data?.keywords || data?.attributes.keywords;
  const logic = data?.matchingLogic || "contains";

  if (logic === "exact") {
    return keywords.some((k: string) => k.toLowerCase() === text);
  }

  return keywords.some((k: string) => text.includes(k.toLowerCase()));
}



export const transformFeatures = (features: any) => {
  const limits: any = {};
  const usage: any = {};

  Object.keys(features).forEach((key) => {
    limits[key] = {
      limit: features[key]?.limit_value ?? null,
    };

    usage[key] = 0; // initialize usage
  });

  return { limits, usage };
};



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


function parseJSON(data: any) {
  try {
    return typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    return {};
  }
}

export const normalizePhoneNumber = (
  phone: string,
  country_code?: string
) => {

  if (!phone) return null;

  let cleaned = String(phone)
    .replace(/[^\d+]/g, "")
    .trim();

  // Remove leading zero
  if (cleaned.startsWith("0")) {
    cleaned = cleaned.slice(1);
  }

  let parsed;

  // Already international
  if (cleaned.startsWith("+")) {

    parsed = parsePhoneNumberFromString(cleaned);

  } else {

    // Example: 919876543210
    if (cleaned.startsWith("91") && cleaned.length === 12) {
      cleaned = "+" + cleaned;
      parsed = parsePhoneNumberFromString(cleaned);
    } else {

      // Use provided country
      parsed = parsePhoneNumberFromString(
        cleaned,
        country_code as any || "IN"
      );
    }
  }

  if (!parsed || !parsed.isValid()) {
    return null;
  }

  return {
    number: parsed.number,
    country: parsed.country,
    country_code: parsed.countryCallingCode,
  };
};

export function replaceBodyVariables(
  text: string,
  variables: Record<string, any> = {}
): string {
  if (!text) return "";

  return text.replace(/\{\{(.*?)\}\}/g, (_, variable) => {
    const value = variable
      .trim()
      .split(".")
      .reduce(
        (obj: any, key: string) => obj?.[key],
        variables
      );

    return value ?? "";
  });
}

export async function buildResponse(node: any, bot?:any,session?:any) {
  console.log('NextNode', JSON.stringify(node))
  const data = safeJSON(node.data);

  // if (node.type === "message") {
  //   return {
  //     type: "text",
  //     text: data.text || "",
  //   };
  // }

  const key = data?.key;
  console.log("Data flow", data, key)

  if (key === "@whatsapp/ask-question") {
    return {
      type: "text",
      text: data?.attributes?.message?.text?.body || "Please enter value"
    };
  }

  if (key === "@whatsapp/send-text-message") {
    let text =
      data?.attributes?.message?.text?.body || "";

    text = replaceBodyVariables(
      text,
      session?.variables || {}
    );

    return {
      type: "text",
      text,
    };
  }

  // Button Interactive  
  if (key === "@whatsapp/send-button-message") {
    return {
      type: "interactive",

      interactive: {
        type: "button",

        header:{
          type: "text",
          text: data?.attributes
           ? data?.attributes?.message?.interactive?.header?.text || "" 
           : ""
        },

        body: {
          text: data?.attributes
            ? data?.attributes?.message?.interactive?.body?.text
            : data.text,
        },

        footer: {
          text: data?.attributes
            ? data?.attributes?.message?.interactive?.footer?.text || ""
            : "",
        },

        action: {
          buttons: (
            data?.attributes
              ? data?.attributes?.message?.interactive?.action?.buttons || []
              : data.buttons || []
          ).map((btn: any, i: number) => ({
            type: "reply",

            reply: {
              id: btn?.reply?.id || btn.id || `btn_${i}`,

              title:
                btn?.reply?.title ||
                btn.title ||
                btn,
            },
          })),
        },
      },
    };
  }

  if (key === "@whatsapp/ask-location") {
    return {
      type: "interactive",

      interactive: {
        type: "location_request_message",

        body: {
          text:
            data?.attributes?.message?.text?.body ||
            "Please share location"
        },

        action: {
          name: "send_location"
        }
      }
    };
  }


  // 📋 LIST MESSAGE BUILDER
  if (key === "@whatsapp/send-list-message") {
    const interactiveData =
      data.attributes?.message?.interactive || {};

    const sections =
      interactiveData.action?.sections || [];

    const interactive = {
      type: "list",

      header: interactiveData.header,

      body: interactiveData.body || {
        text: "Choose an option"
      },

      footer: interactiveData.footer,

      action: {
        button:
          interactiveData.action?.button ||
          "Select Option",

        sections: sections.map((section: any) => ({
          title: section.title || "Options",

          rows: (section.rows || []).map((row: any) => ({
            id: row.id,
            title: row.title,
            description: row.description || ""
          }))
        }))
      }
    };

    return {
      type: "interactive",
      interactive
    };
  }

  // 🔗 CTA URL BUTTON
  // if (type === "cta_url") {
  //   const interactive: any = {
  //     type: "cta_url",
  //     body: {
  //       text: data.text || ""
  //     },
  //     footer: data.footer || undefined,
  //     action: {
  //       name: "cta_url",
  //       parameters: {
  //         display_text: data.ctaDisplayText || "Open",
  //         url: data.ctaUrl
  //       }
  //     }
  //   };

  //   // Optional Header
  //   if (data.headerType === 'image' && data.headerMedia) {
  //     interactive.header = {
  //       type: "image",
  //       image: {
  //         link: data.headerMedia
  //       }
  //     };
  //   } else if (data.headerType === 'text' && data.header) {
  //     interactive.header = {
  //       type: "text",
  //       text: data.header
  //     };
  //   }
  //   return {
  //     type: "interactive",
  //     interactive
  //   }
  // }

  // // 🎞️ CAROUSEL (Meta = "product" or "generic template")
  // if (type === "carousel") {
  //   return {
  //     type: "interactive",
  //     interactive: {
  //       type: "carousel", // or "catalog_message" depending on API
  //       body: {
  //         text: data.text || "Browse items"
  //       },
  //       action: {
  //         cards: data.carouselCards || []
  //       }
  //     }
  //   };
  // }

  // // 🖼️ MEDIA MESSAGE (image header)
  // if (type === "media") {
  //   return {
  //     type: "image",
  //     image: {
  //       link: data.mediaUrl,
  //       caption: data.text || ""
  //     }
  //   };
  // }


  return null;
}
