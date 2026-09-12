import { Queue } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';

export interface ChatbotDelayJob {
  sessionId: string;
  nodeId: string;
  token: string;
}

export const chatbotDelayQueue = new Queue<ChatbotDelayJob>('chatbot-delay', {
  connection: redisConfig,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 5000 },
    removeOnComplete: { count: 1000 },
    removeOnFail: { count: 1000 },
  },
});
chatbotDelayQueue.on('error', error => console.error('Chatbot delay queue error:', error));
