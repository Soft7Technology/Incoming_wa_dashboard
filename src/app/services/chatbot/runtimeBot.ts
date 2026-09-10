import triggers from '../../models/chatbotTrigger.model';
import phones from '../../models/phoneNumber.model';
import nodes from '../../models/chatBotNode.model';

// Active trigger mappings are the runtime publication and phone assignment source.
// chat_bot remains management metadata; execution never reads it.
export async function getRuntimeBot(phoneNumberId: string, chatbotId?: string, text?: string): Promise<any> {
  const mapping = await triggers.findRuntimeMapping(phoneNumberId, chatbotId, text);
  if (!mapping) return null;
  const phone = await phones.findByPhoneNumberId(phoneNumberId);
  if (!phone) return null;
  const flowNodes = await nodes.findByChatBotId(mapping.chatbot_id);
  const trigger = flowNodes.find((node: any) => node.type === 'trigger');
  if (!trigger || trigger.user_id !== phone.user_id) return null;
  return { id: mapping.chatbot_id, user_id: trigger.user_id, company_id: phone.company_id,
    flow_type: flowNodes.filter((node: any) => node.type === 'message').length >= 3 ? 'form' : 'menu' };
}
