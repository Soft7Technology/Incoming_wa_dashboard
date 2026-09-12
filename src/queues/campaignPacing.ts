import { campaignExecutionQueue } from './campaignExecution.queue';
import { campaignCapacity } from './campaignCapacity';

// Atomic across worker processes. Redis time avoids host clock skew.
export const pacingScript = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
local cooldown = redis.call('PTTL', KEYS[3])
if cooldown > 0 then return cooldown end
local pairCooldown = redis.call('PTTL', KEYS[4])
if pairCooldown > 0 then return pairCooldown end
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
  const deadline = Date.now() + 1000;
  for (;;) {
    const pairKey = `${prefix}:${recipient.replace(/\D/g, '')}`;
    const wait = Number(await redis.eval(pacingScript, 4, prefix, pairKey, `${prefix}:cooldown`, `${pairKey}:cooldown`,
      Math.ceil(1000 / campaignCapacity.messagesPerSecond), campaignCapacity.pairIntervalMs));
    if (wait <= 0) return true;
    if (Date.now() + wait > deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(wait, 6000)));
  }
}

export async function getCampaignSenderCooldown(sender: string): Promise<number> {
  const redis = await campaignExecutionQueue.client;
  return Math.max(0, await redis.pttl(`campaign-send:{${sender}}:cooldown`));
}

export async function setCampaignSenderCooldown(sender: string, delayMs: number): Promise<void> {
  const redis = await campaignExecutionQueue.client;
  const key = `campaign-send:{${sender}}:cooldown`;
  await redis.eval(`
    if redis.call('PTTL', KEYS[1]) < tonumber(ARGV[1]) then
      redis.call('SET', KEYS[1], '1', 'PX', ARGV[1])
    end
    return 1
  `, 1, key, delayMs);
}

export async function setCampaignPairCooldown(sender: string, recipient: string, delayMs: number): Promise<void> {
  const redis = await campaignExecutionQueue.client;
  const key = `campaign-send:{${sender}}:${recipient.replace(/\D/g, '')}:cooldown`;
  await redis.set(key, '1', 'PX', delayMs);
}
