import { buildInteractiveHeader, validateChatbotMessage } from './utils/chatbotMessage';
import chatSessionModel from '../app/models/chatSession.model';
import nodemailer from "nodemailer";
import metaService from './services/meta.service';
import { parsePhoneNumberFromString } from "libphonenumber-js";
import chatbotTriggerModel from './models/chatbotTrigger.model';

export const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

export async function endSession(sessionId: string) {
  return await chatSessionModel.update(sessionId, {
    active: false,
    current_node_id: null,
    updated_at: new Date(),
  });
}

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


// export async function handleIncomingMessageChatBot(phoneNumberId: any, message: any, profile_name:any) {
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
//     console.log("Incoming Id",incomingId)

//     // 1️⃣ Get bot
//     console.log("🔍 Finding bot for phone number:", phoneNumberId);
//     const bot: any = await chatBotModel.getPublishedBotByPhoneNumber(phoneNumberId);

//     const numberMatch = incomingText.match(/\d{10,13}/);
//     let fpo_info

//     if(numberMatch){
//       const fpoNumber = numberMatch[0];
//       const cleanNumber = fpoNumber.replace(/\D/g, "");

//       // Add 91 if not already present
//       const phoneNumber = cleanNumber.startsWith("91")
//             ? cleanNumber
//             : `91${cleanNumber}`;

//       console.log("Phone Number",phoneNumber)

//       fpo_info = await userModel.findByPhone(phoneNumber)
//     }

//     console.log("Fpo Info",fpo_info)

//     console.log("🤖 Found bot:", bot ? bot.name : "No bot");
//     if (!bot) return null;

//     const mappedUserId = fpo_info?.id ? fpo_info?.id: bot.user_id;

//     //check exist contact
//     const existContact = await contactModel.findByUserPhoneNumber(message.from)
//     console.log("Existing Contant",existContact)
//     if(!existContact){
//       const newContact = await contactModel.create({
//         // user_id: mappedUserId,
//         user_id: bot.user_id,
//         company_id:bot.company_id,
//         phone_number:message.from,
//         name:profile_name
//       })
//       console.log("New Contact", newContact)
//     }
//   //   else{
//   //       // Update contact mapping if FPO user found
//   // if (existContact.user_id !== mappedUserId) {
//   //   await contactModel.update(existContact.id, {
//   //     name:profile_name
//   //   });
//   // }
//   //   }


//     // 2️⃣ Load nodes + edges
//     const rawNodes = await chatBotNodeModel.findByChatBotId(bot?.id) || [];
//     const rawEdges = await chatBotEdgeModel.findByChatBotId(bot?.id) || [];

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

//     const response = await flowRouter({
//       bot,
//       phone,
//       incomingText,
//       incomingId,
//       message,
//       phoneNumberId
//     })

//     // // 3️⃣ Resolve flow WITHOUT session
//     // const response = resolveFlow(bot, incomingText,incomingId);
//     // console.log("Response", JSON.stringify(response))

//     // 4️⃣ Send message
//     if (response) {
//       await messageService.sendChatBotMessage(phoneNumberId, phone, response);
//     } else {
//       const chatSession = await chatSessionModel.findByPhoneNumber(phone)
//       if (!chatSession) {
//         return null
//       }
//       await chatSessionModel.update(chatSession.id, {
//         active: false,
//         current_node_id: null,
//         // completed_at: new Date(),
//         updated_at: new Date(),
//       })
//       //       await chatSessionModel.deactivateActiveSession({
//       //   phoneNumber: phone,
//       //   chatbotId: bot.id,
//       //   phoneNumberId,
//       // });
//       console.log("⚠️ No response generated to send");
//     }

//     return response;

//   } catch (error) {
//     console.error("❌ Chatbot Error:", error);
//     return;
//   }
// }



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


export function safeJSON(data: any) {
  try {
    return typeof data === "string" ? JSON.parse(data) : data;
  } catch {
    return {};
  }
}


export function replaceVariables(
  obj: any,
  variables: Record<string, any>
): any {
  console.log("Variables", obj, variables)
  console.log("Typeof", typeof obj)

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


export const downloadMedia = async (mediaId: string) => {
  console.log("MediaId:", mediaId);
  try {
    const media = await metaService.handleMedia(mediaId)
    console.log("Media", media)
    return media;
  } catch (error: any) {
    console.error(
      '❌ Error downloading image:',
      error.response?.status,
      error.response?.data || error.message
    );
    throw error;
  }
};


export default function sendEmail(to: string, subject: string, text: string, html?: string) {
  console.log(`📧 Sending email to ${to}: ${subject}\n${text}`);
  return transporter.sendMail({
    from: `"Soft7 Technologies" <${process.env.SMTP_USER}>`,
    to,
    subject,
    text,
    html,
  })
  // Integrate with actual email service here (e.g., SendGrid, SES)
}

export async function matchTrigger(
  phoneNumberId: string,
  text: string
) {
  const triggerWords =
    await chatbotTriggerModel.getActiveTriggers(
      phoneNumberId
    );

  if (!text) {
    return false;
  }

  const normalizedText = text
    .toString()
    .trim()
    .toLowerCase();

  return triggerWords.some(
    (keyword: string) =>
      keyword &&
      keyword.toString().trim().toLowerCase() ===
      normalizedText
  );
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

export async function buildResponse(node: any, session?: any, bot?: any) {
  console.log('NextNode', JSON.stringify(node))
  console.log()
  const data = safeJSON(node.data);
  validateChatbotMessage(data);


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

  if (data.key === "@whatsapp/send-cta-message") {
    const attrs = data.attributes || {};

    const interactiveData = attrs.message?.interactive || {};

    const header = interactiveData.header || {};
    const body = interactiveData.body || {};
    const footer = interactiveData.footer || {};
    const parameters = interactiveData.action?.parameters || {};

    const interactive: any = {
      type: "cta_url",

      body: {
        text: body.text || "",
      },

      action: {
        name: "cta_url",
        parameters: {
          display_text: parameters.display_text || "Open",
          url: parameters.url || "",
        },
      },
    };

    const normalizedHeader = buildInteractiveHeader(header);
    if (normalizedHeader) interactive.header = normalizedHeader;

    // -----------------------------------------
    // Footer is optional
    // Don't send footer.text = ""
    // -----------------------------------------
    if (footer.text?.trim()) {
      interactive.footer = {
        text: footer.text,
      };
    }

    return {
      type: "interactive",
      interactive,
    };
  }


  if (key === "@whatsapp/stop-chatbot") {
    if (session?.id) {
      await endSession(session.id);
    }

    return {
      type: "text",
      text:
        data?.attributes?.message ||
        "Thank you. This conversation has been closed.",
      stopChatbot: true,
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
    const message = data?.attributes?.message?.interactive;
    const header = buildInteractiveHeader(message?.header);
    const footer = message?.footer?.text;
    const buttons = data?.attributes ? message?.action?.buttons || [] : data.buttons || [];

    return {
      type: "interactive",
      interactive: {
        type: "button",
        ...(header ? { header } : {}),
        body: { text: data?.attributes ? message?.body?.text : data.text },
        ...(typeof footer === "string" && footer.trim() ? { footer: { text: footer } } : {}),
        action: {
          buttons: buttons.map((btn: any, i: number) => {
            const title = btn?.reply?.title ?? btn?.title ?? (typeof btn === "string" ? btn : "");
            if (typeof title !== "string" || !title.trim()) {
              throw new Error(`Button ${i + 1}: title is required.`);
            }
            return {
              type: "reply",
              reply: {
                id: btn?.reply?.id || btn.id || `btn_${i}`,
                title,
              },
            };
          }),
        },
      },
    };
  }

  if (key === "@whatsapp/send-media-message") {
    const imageLink =
      data?.attributes?.message?.image?.link || data?.attributes?.message?.video?.link || "";

    return {
      type: data?.attributes?.message.type,
      image: {
        link: imageLink,
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

    const interactive: any = {
      type: "list",

      body: interactiveData.body || {
        text: "Choose an option",
      },

      ...(interactiveData.footer?.text?.trim() ? { footer: interactiveData.footer } : {}),

      action: {
        button:
          interactiveData.action?.button ||
          "Select Option",

        sections: sections.map((section: any) => ({
          title: section.title || "Options",

          rows: (section.rows || []).map((row: any) => ({
            id: row.id,
            title: row.title,
            description: row.description || "",
          })),
        })),
      },
    };

    if (
      interactiveData.header &&
      interactiveData.header.type &&
      ["text", "image", "video", "document"].includes(
        interactiveData.header.type
      )
    ) {
      interactive.header = interactiveData.header;
    }

    return {
      type: "interactive",
      interactive,
    };
  }

  return null;
}

