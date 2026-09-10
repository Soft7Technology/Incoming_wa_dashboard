import * as os from 'os';
import { monitorEventLoopDelay } from 'perf_hooks';

function setting(name: string, fallback: number, max: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}: expected 1..${max}`);
  return value;
}

export const campaignCapacity = {
  concurrency: setting('CAMPAIGN_CONCURRENCY', 4, 32),
  maxBatch: setting('CAMPAIGN_MAX_BATCH_SIZE', 10, 100),
  messagesPerSecond: setting('CAMPAIGN_MESSAGES_PER_SECOND', 10, 1000),
  pairIntervalMs: 6000,
  yieldMs: 250,
};

export function nextBatchSize(current: number, cpu: number, memory: number, lagMs: number, max: number): number {
  if (cpu >= 0.8 || memory >= 0.85 || lagMs >= 100) return Math.max(1, Math.floor(current / 2));
  if (cpu < 0.6 && memory < 0.75 && lagMs < 40) return Math.min(max, current + 1);
  return Math.max(1, Math.min(current, max));
}

export function createCapacitySampler() {
  const snapshot = () => os.cpus().reduce((total, core) => ({
    idle: total.idle + core.times.idle,
    total: total.total + Object.values(core.times).reduce((sum, value) => sum + value, 0),
  }), { idle: 0, total: 0 });
  let previous = snapshot();
  let batch = Math.min(2, campaignCapacity.maxBatch);
  let sampledAt = Date.now();
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  return {
    sample() {
      if (Date.now() - sampledAt < 1000) return batch;
      const now = snapshot();
      const elapsed = now.total - previous.total;
      const cpu = elapsed > 0 ? 1 - (now.idle - previous.idle) / elapsed : 1;
      batch = nextBatchSize(batch, cpu, 1 - os.freemem() / os.totalmem(), loop.percentile(95) / 1e6, campaignCapacity.maxBatch);
      previous = now;
      sampledAt = Date.now();
      loop.reset();
      return batch;
    },
    close() { loop.disable(); },
  };
}
