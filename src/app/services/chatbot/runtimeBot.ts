import triggers from '../../models/chatbotTrigger.model';
import phones from '../../models/phoneNumber.model';
import nodes from '../../models/chatBotNode.model';
import edges from '../../models/chatBotEdge.model';

export async function getRuntimeBot(phoneNumberId: string, chatbotId?: string, text?: string): Promise<any> {
  const phone = await phones.findByPhoneNumberId(phoneNumberId);
  if (!phone) {
    console.warn('[Chatbot Routing] Receiving phone not found', { phoneNumberId });
    return null;
  }
  // Support existing flow mappings saved with either the local UUID or Meta ID.
  const phoneIds = [...new Set([phone.id, phone.phone_number_id, phoneNumberId].filter(Boolean))] as string[];
  const mapping = await triggers.findRuntimeMapping(phoneIds, chatbotId, text);
  if (!mapping) {
    console.info('[Chatbot Routing] No active mapping', { phoneNumberId, chatbotId, lookup: text === undefined ? 'session' : 'keyword' });
    return null;
  }
  const [flowNodes, flowEdges] = await Promise.all([
    nodes.findByChatBotId(mapping.chatbot_id), edges.findByChatBotId(mapping.chatbot_id),
  ]);
  const trigger = flowNodes.find((node: any) => node.type === 'trigger');
  if (!trigger || trigger.user_id !== phone.user_id) {
    console.warn('[Chatbot Routing] Missing trigger node or owner mismatch', { chatbotId: mapping.chatbot_id, phoneNumberId });
    return null;
  }
  const decode = (row: any) => ({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data });
  console.info('[Chatbot Routing] Mapping selected', { chatbotId: mapping.chatbot_id, phoneNumberId,
    triggerId: mapping.id, lookup: text === undefined ? 'session' : 'keyword', nodes: flowNodes.length, edges: flowEdges.length });
  return { id: mapping.chatbot_id, user_id: trigger.user_id, company_id: phone.company_id,
    nodes: flowNodes.map(decode), edges: flowEdges.map(decode),
    flow_type: flowNodes.filter((node: any) => node.type === 'message').length >= 3 ? 'form' : 'menu' };
}
