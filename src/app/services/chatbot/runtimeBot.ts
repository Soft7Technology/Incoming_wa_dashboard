import triggers from '../../models/chatbotTrigger.model';
import phones from '../../models/phoneNumber.model';
import nodes from '../../models/chatBotNode.model';
import edges from '../../models/chatBotEdge.model';
import users from '../../models/user.model';

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
  if (!trigger) {
    console.warn('[Chatbot Routing] Mapped flow has no trigger node', {
      chatbotId: mapping.chatbot_id, receivingMetaPhoneNumberId: phone.phone_number_id,
      nodeCount: flowNodes.length, nodeTypes: flowNodes.map((node: any) => node.type),
    });
    return null;
  }
  // A company member may create a flow on a number connected by another member.
  if (!trigger.user_id || trigger.user_id !== phone.user_id) {
    const creator = trigger.user_id ? await users.findById(trigger.user_id) : null;
    if (!creator || creator.deleted_at || !phone.company_id || creator.company_id !== phone.company_id) {
      console.warn('[Chatbot Routing] Flow ownership could not be verified', {
        chatbotId: mapping.chatbot_id, receivingMetaPhoneNumberId: phone.phone_number_id,
        nodeUserId: trigger.user_id, phoneUserId: phone.user_id,
        nodeCompanyId: creator?.company_id, phoneCompanyId: phone.company_id,
      });
      return null;
    }
  }
  const decode = (row: any) => ({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data });
  console.info('[Chatbot Routing] Mapping selected', { chatbotId: mapping.chatbot_id, phoneNumberId,
    triggerId: mapping.id, lookup: text === undefined ? 'session' : 'keyword', nodes: flowNodes.length, edges: flowEdges.length });
  return { id: mapping.chatbot_id, user_id: trigger.user_id, company_id: phone.company_id,
    nodes: flowNodes.map(decode), edges: flowEdges.map(decode),
    flow_type: flowNodes.filter((node: any) => node.type === 'message').length >= 3 ? 'form' : 'menu' };
}
