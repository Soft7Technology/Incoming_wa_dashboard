import { campaignExecutionQueue } from './campaignExecution.queue';
import { campaignCapacity } from './campaignCapacity';

const leaseMs = 120000;
const keyFor = (userId: string) => `campaign-user-slots:${userId}`;

// Redis TIME and one Lua operation keep the limit consistent across worker replicas.
const acquireScript = `
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then return 0 end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[3]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[3]) * 2)
return 1
`;

const refreshScript = `
if not redis.call('ZSCORE', KEYS[1], ARGV[1]) then return 0 end
local time = redis.call('TIME')
local now = time[1] * 1000 + math.floor(time[2] / 1000)
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[2]), ARGV[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]) * 2)
return 1
`;

export async function acquireCampaignUserSlot(userId: string, campaignId: string): Promise<boolean> {
  const redis = await campaignExecutionQueue.client;
  return Number(await redis.eval(acquireScript, 1, keyFor(userId), campaignId, campaignCapacity.maxRunningPerUser, leaseMs)) === 1;
}

export async function refreshCampaignUserSlot(userId: string, campaignId: string): Promise<boolean> {
  const redis = await campaignExecutionQueue.client;
  return Number(await redis.eval(refreshScript, 1, keyFor(userId), campaignId, leaseMs)) === 1;
}

export async function releaseCampaignUserSlot(userId: string, campaignId: string): Promise<void> {
  const redis = await campaignExecutionQueue.client;
  await redis.zrem(keyFor(userId), campaignId);
}
