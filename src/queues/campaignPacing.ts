import { campaignExecutionQueue } from './campaignExecution.queue';
import { campaignCapacity } from './campaignCapacity';

// Atomic across worker processes. Redis time avoids host clock skew.
export const pacingScript = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local sender = tonumber(redis.call('GET', KEYS[1]) or '0')
local pair = tonumber(redis.call('GET', KEYS[2]) or '0')
local wait = math.max(sender, pair) - now
if wait > 0 then return wait end
redis.call('SET', KEYS[1], now + tonumber(ARGV[1]), 'PX', ARGV[1])
redis.call('SET', KEYS[2], now + tonumber(ARGV[2]), 'PX', ARGV[2])
return 0
`;

export async function waitForCampaignPermit(sender: string, recipient: string) {
  const redis = await campaignExecutionQueue.client;
  const prefix = `campaign-send:{${sender}}`;
  for (;;) {
    const wait = Number(await redis.eval(pacingScript, 2, prefix, `${prefix}:${recipient.replace(/\D/g, '')}`,
      Math.ceil(1000 / campaignCapacity.messagesPerSecond), campaignCapacity.pairIntervalMs));
    if (wait <= 0) return;
    await new Promise(resolve => setTimeout(resolve, Math.min(wait, 6000)));
  }
}
