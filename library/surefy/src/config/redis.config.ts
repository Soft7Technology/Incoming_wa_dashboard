import Redis from 'ioredis';

const redisConfig = {
  host: process.env.REDIS_HOST || '13.202.117.242',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD || "tyi+kvWLmuO9x8n4CpJB6TPTQCR5qZ6VnnI3X1PPyoRSXyUxeMgiRVml5Lgyzlr38peHwbySFnZlYMIl",
  db: parseInt(process.env.REDIS_DB || '0'),
  maxRetriesPerRequest: null, // Required for BullMQ
  enableReadyCheck: false,
};

export const redisConnection = new Redis(redisConfig);

redisConnection.on('connect', () => {
  console.log('✅ Redis connected successfully');
});

redisConnection.on('error', (error) => {
  console.error('❌ Redis connection error:', error);
});

export default redisConfig;
