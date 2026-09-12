import { Worker } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import { ChatbotDelayJob } from '../chatbotDelay.queue';
import sessions from '../../app/models/chatSession.model';
import { getRuntimeBot } from '../../app/services/chatbot/runtimeBot';
import nodes from '../../app/models/chatBotNode.model';
import edges from '../../app/models/chatBotEdge.model';
import { executeNode, endSession } from '../../app/services/chatbot/engine/executeNode';
import messages from '../../app/services/message.service';

export async function resumeChatbotDelay(data: ChatbotDelayJob) {
  console.info('[Chatbot Delay] Resuming', { sessionId: data.sessionId, nodeId: data.nodeId });
  const session = await sessions.findById(data.sessionId);
  if (!session?.active || session.current_node_id !== data.nodeId ||
      session.variables?.chatbot_delay_token !== data.token) {
    console.warn('[Chatbot Delay] Skipped stale or inactive session', {
      sessionId: data.sessionId, active: session?.active,
      expectedNodeId: data.nodeId, currentNodeId: session?.current_node_id,
      tokenMatches: session?.variables?.chatbot_delay_token === data.token,
    });
    return;
  }
  const bot = await getRuntimeBot(session.phoneNumberId, session.chatbot_id);
  if (!bot) throw new Error(`Active chatbot mapping not found for delayed session ${session.id}`);
  const decode = (row: any) => ({ ...row, data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data });
  bot.nodes = (await nodes.findByChatBotId(bot.id)).map(decode);
  bot.edges = (await edges.findByChatBotId(bot.id)).map(decode);
  const edge = bot.edges.find((edge: any) => edge.source === data.nodeId);
  const next = bot.nodes.find((node: any) => node.id === edge?.target);
  if (!next) {
    console.warn('[Chatbot Delay] No next node; ending session', { sessionId: session.id, nodeId: data.nodeId });
    await endSession(session.id);
    return;
  }
  const variables = { ...session.variables };
  delete variables.chatbot_delay_token;
  await sessions.update(session.id, { current_node_id: next.id, variables });
  const response = await executeNode({ bot, session: { ...session, current_node_id: next.id, variables }, currentNode: next });
  if (response && !response.ignoreMessage) {
    await messages.sendChatBotMessage(session.phoneNumberId, session.phone_number, response);
  }
  console.info('[Chatbot Delay] Resumed', { sessionId: session.id, nextNodeId: next.id, messageSent: Boolean(response && !response.ignoreMessage) });
}

export const chatbotDelayWorker = new Worker<ChatbotDelayJob>('chatbot-delay',
  job => resumeChatbotDelay(job.data), { connection: redisConfig, concurrency: 5 });
chatbotDelayWorker.on('ready', () => console.info('[Chatbot Delay] Worker ready', { pid: process.pid }));
chatbotDelayWorker.on('error', error => console.error('Chatbot delay worker error:', error));
chatbotDelayWorker.on('failed', (job, error) => console.error('Chatbot delay failed:', {
  jobId: job?.id, sessionId: job?.data.sessionId, attempt: job?.attemptsMade,
  maxAttempts: job?.opts.attempts, reason: error.message, stack: error.stack,
}));
