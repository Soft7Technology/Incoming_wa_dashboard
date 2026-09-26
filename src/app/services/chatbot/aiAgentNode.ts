import assistantService from '../aiAssistant.service';
import phoneNumberModel from '../../models/phoneNumber.model';
import chatSessionModel from '../../models/chatSession.model';

/**
 * Handle one turn on an AI node. Return messages for the existing sender;
 * exitAi tells the flow engine to advance after a stop command or timeout.
 */
export async function runAiAgentNode(bot: any, session: any, node: any): Promise<any> {
  const attrs = node.data?.attributes || {};
  // Persisted state distinguishes first entry from a follow-up on this same node.
  const state = session.variables?.chatbot_ai;
  const continuing = state?.nodeId === node.id;
  const text = String(session.last_message || '').trim();
  // Match the complete message, so mentioning /stop inside a sentence does not exit.
  const stop = (Array.isArray(attrs.stopKeywords) ? attrs.stopKeywords : ['/stop'])
    .some((word: unknown) => typeof word === 'string' && word.trim() && word.trim().toLowerCase() === text.toLowerCase());
  const multipliers: Record<string, number> = { seconds: 1000, minutes: 60000, hours: 3600000 };
  const timeout = attrs.timeout ? Number(attrs.timeout.value) * multipliers[attrs.timeout.unit] : 300000;
  if (!Number.isFinite(timeout) || timeout <= 0) throw new Error('AI node timeout must be a positive duration');
  // Inactivity is checked when a message arrives; no background timer sends a reply.
  const expired = continuing && Date.now() - Number(state.lastActivity) >= timeout;
  if (stop || expired) {
    // Remove only AI state; keep answers collected by earlier flow nodes.
    const variables = { ...session.variables };
    delete variables.chatbot_ai;
    await chatSessionModel.update(session.id, { variables, updated_at: new Date() });
    session.variables = variables;
    return { exitAi: true, messages: expired && attrs.timeoutMessage ? [{ type: 'text', text: attrs.timeoutMessage }] : [] };
  }
  // Resolve the receiving number and enforce account/company ownership before using a key.
  const phone = await phoneNumberModel.findByPhoneNumberId(session.phoneNumberId);
  if (!phone || !bot.user_id || phone.user_id !== bot.user_id || phone.company_id !== bot.company_id) {
    throw new Error('AI node does not belong to the receiving account');
  }
  if (!attrs.assistantId) throw new Error('AI node requires assistantId');
  let response: string;
  try {
    response = await assistantService.runAssistant(String(attrs.assistantId), bot.user_id,
      phone.company_id, phone.id, session.phone_number);
  } catch {
    console.warn('[Chatbot AI] Response generation failed', { nodeId: node.id, sessionId: session.id });
    response = 'Sorry, I could not generate a response. Please try again.';
  }
  // Stay on this node for the next inbound message and refresh the inactivity clock.
  const variables = { ...session.variables, chatbot_ai: { nodeId: node.id, lastActivity: Date.now() } };
  // Optionally expose the response to later nodes without overwriting internal state.
  const variable = node.data?.dataOut?.variable;
  if (typeof variable === 'string' && variable.trim() && !['__proto__', 'constructor', 'prototype', 'chatbot_ai'].includes(variable)) variables[variable] = response;
  await chatSessionModel.update(session.id, { current_node_id: node.id, variables, updated_at: new Date() });
  // WhatsApp text bodies have a 4096-character limit.
  const messages: any[] = [];
  if (!continuing && typeof attrs.welcomeMessage === 'string' && attrs.welcomeMessage.trim()) {
    messages.push({ type: 'text', text: attrs.welcomeMessage.slice(0, 4096) });
  }
  for (let offset = 0; offset < response.length; offset += 4000) messages.push({ type: 'text', text: response.slice(offset, offset + 4000) });
  // Sending and outbound-message persistence are handled by sendChatBotMessage.
  return { messages };
}
