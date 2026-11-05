import { v4 as uuidv4 } from 'uuid';
import HTTP400Error from '@surefy/exceptions/HTTP400Error';
import HTTP403Error from '@surefy/exceptions/HTTP403Error';
import HTTP404Error from '@surefy/exceptions/HTTP404Error';
import planUsage from './planUsage.service';
import chatbotTemplateModel from '../models/chatbotTemplate.model';
import { validateChatbotMessage } from '../utils/chatbotMessage';
import { markActivityRecorded } from '../utils/activityContext';
import { captureInteractiveChoice } from './chatbot/interactiveChoice';

interface TemplateActor { userId?: string; ownerId?: string; companyId?: string }
function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /\{\{|\}\}/.test(value))
    throw new HTTP400Error({ message: `${field} must contain 1 to ${max} characters without template placeholders` });
  return value.trim();
}
function render(value: any, customizations: Record<string, string>): any {
  if (typeof value === 'string') return value.replace(/\{\{(business_name|support_contact)\}\}/g,
    (_match, key) => customizations[key]);
  if (Array.isArray(value)) return value.map(item => render(item, customizations));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, render(item, customizations)]));
  return value;
}

class ChatbotTemplateService {
  categories() { return chatbotTemplateModel.categories(); }

  async list(category?: unknown, search?: unknown) {
    if (category !== undefined && (typeof category !== 'string' || !(await this.categories()).some(row => row.id === category)))
      throw new HTTP400Error({ message: 'Unknown chatbot template category; use GET /chatbot/templates/categories' });
    if (search !== undefined && (typeof search !== 'string' || search.length > 120))
      throw new HTTP400Error({ message: 'search must be text of at most 120 characters' });
    return chatbotTemplateModel.list(category as string | undefined, (search as string | undefined)?.trim());
  }

  async detail(id: string) {
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,100}$/.test(id))
      throw new HTTP400Error({ message: 'Invalid template ID' });
    const template = await chatbotTemplateModel.detail(id);
    if (!template) throw new HTTP404Error({ message: 'Chatbot template not found' });
    return template;
  }

  async demo(id: string, input: unknown) {
    const template = await this.detail(id);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['node_id', 'choice_id', 'answer'].includes(key)))
      throw new HTTP400Error({ message: 'Demo accepts only node_id, choice_id and answer' });
    const body = input as { node_id?: unknown; choice_id?: unknown; answer?: unknown };
    const graph = render(template, { business_name: 'Demo Business', support_contact: 'our demo team' }) as typeof template;
    let node = graph.nodes.find(n => n.id === (body.node_id ?? 'menu'));
    if (!node || node.type !== 'message') throw new HTTP400Error({ message: 'Invalid demo node_id' });
    let captured: Record<string, string> = {};
    if (body.choice_id !== undefined || body.answer !== undefined) {
      if (body.node_id === undefined) throw new HTTP400Error({ message: 'Provide the node_id returned by the previous demo response' });
      let edge;
      if (['@whatsapp/send-list-message', '@whatsapp/send-button-message'].includes(node.data.key)) {
        if (typeof body.choice_id !== 'string' || body.answer !== undefined)
          throw new HTTP400Error({ message: 'Select a valid choice_id for this menu' });
        edge = graph.edges.find(e => e.source === node!.id && e.sourceHandle === body.choice_id);
        if (edge) captured = captureInteractiveChoice(graph, edge);
      } else if (node.data.key === '@whatsapp/ask-question') {
        if (typeof body.answer !== 'string' || !body.answer.trim() || body.answer.length > 2000 || body.choice_id !== undefined)
          throw new HTTP400Error({ message: 'Provide an answer of 1 to 2000 characters for this question' });
        captured = { [node.data.attributes.variable]: body.answer.trim() };
        edge = graph.edges.find(e => e.source === node!.id);
      }
      const next = edge && graph.nodes.find(n => n.id === edge.target);
      if (!next) throw new HTTP400Error({ message: 'No demo transition matches this input' });
      node = next;
    }
    const message = node.data.attributes.message;
    return { template_id: id, node_id: node.id, message,
      choices: message.interactive?.action?.sections?.flatMap((section: any) => section.rows)
        || message.interactive?.action?.buttons?.map((button: any) => button.reply) || [],
      awaiting_answer: node.data.key === '@whatsapp/ask-question',
      completed: !graph.edges.some(e => e.source === node!.id), captured,
      simulated: true, persisted: false };
  }

  async use(actor: TemplateActor, id: string, input: unknown) {
    if (!actor.userId || !actor.companyId) throw new HTTP403Error({ message: 'Authenticated company context is required' });
    const template = await this.detail(id);
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).some(key => !['name', 'customizations'].includes(key)))
      throw new HTTP400Error({ message: 'Only name and customizations are accepted; company, owner, nodes and published state come from the server' });
    const body = input as { name?: unknown; customizations?: unknown };
    if (!body.customizations || typeof body.customizations !== 'object' || Array.isArray(body.customizations) ||
        Object.keys(body.customizations).some(key => !['business_name', 'support_contact'].includes(key)))
      throw new HTTP400Error({ message: 'customizations must contain business_name and optional support_contact' });
    const custom = body.customizations as Record<string, unknown>;
    const businessName = text(custom.business_name, 'business_name', 100);
    const name = body.name === undefined ? template.name : text(body.name, 'name', 100);
    const values = { business_name: businessName,
      support_contact: custom.support_contact === undefined ? 'our team in this WhatsApp chat'
        : text(custom.support_contact, 'support_contact', 120) };
    const graph = render({ nodes: template.nodes, edges: template.edges }, values) as typeof template;
    graph.nodes.forEach(node => validateChatbotMessage(node.data));
    const ownerId = actor.ownerId ?? actor.userId;

    const result = await planUsage.run(ownerId, 'Chatbot', async trx => {
      // ownerId is derived from authenticated membership, never supplied in the body.
      const owner = await trx('users').where({ id: ownerId, company_id: actor.companyId })
        .whereNull('deleted_at').first('id');
      if (!owner) throw new HTTP403Error({ message: 'Chatbot owner does not belong to the authenticated company' });
      const [bot] = await trx('chat_bot').insert({ user_id: ownerId, company_id: actor.companyId,
        name, description: template.description, status: 'draft', published: false,
        flow_type: graph.nodes.filter(node => node.type === 'message').length >= 3 ? 'form' : 'menu',
      }).returning('*');
      const nodeIds = new Map(graph.nodes.map(node => [node.id, uuidv4()]));
      const nodes = graph.nodes.map(node => ({ ...node, id: nodeIds.get(node.id)!, user_id: ownerId, chatBotId: bot.id }));
      const edges = graph.edges.map(edge => ({ ...edge, id: uuidv4(), source: nodeIds.get(edge.source)!,
        target: nodeIds.get(edge.target)!, user_id: ownerId, chatBotId: bot.id,
        data: { ...(edge.data || {}), ...(edge.sourceHandle ? { sourceHandle: edge.sourceHandle } : {}) },
      }));
      await trx('chat_bot_node').insert(nodes.map(node => ({ id: node.id, user_id: ownerId, chatBotId: bot.id,
        type: node.type, data: JSON.stringify(node.data), position: JSON.stringify(node.position) })));
      await trx('chat_bot_edge').insert(edges.map(edge => ({ id: edge.id, user_id: ownerId, chatBotId: bot.id,
        source: edge.source, target: edge.target, label: edge.label || null, data: JSON.stringify(edge.data) })));
      await trx('chatbot_template_installs').insert({ chatbot_id: bot.id, template_id: template.id, template_version: template.version });
      await trx('activity_logs').insert({ user_id: actor.userId, company_id: actor.companyId, action: 'CREATE',
        entity_type: 'CHATBOT', entity_id: bot.id, read: false, status: 'SUCCESS',
        description: `Created chatbot from ${template.name} template`,
        new_data: JSON.stringify({ chatbot_id: bot.id, template_id: template.id, template_version: template.version }),
      });
      // No phone mappings are reserved and no messages are sent until the existing save/publish flow is used.
      return { ...bot, template_id: template.id, template_version: template.version, nodes, edges,
        phoneNumberIds: [], requires_phone_assignment: true };
    });
    markActivityRecorded();
    return result;
  }
}

export default new ChatbotTemplateService();
