import { Worker } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import type { ContactImportJobData } from '../contactImport.queue';
import { processContactImport } from '../../app/services/contactImport.service';
// Create and start the worker
console.log('📦 Initializing Contact Import Worker...');
// console.log('📡 Redis config:', {
//   host: redisConfig.host,
//   port: redisConfig.port
// });

export const contactImportWorker = new Worker<ContactImportJobData>(
  'contact-import',
  async (job) => {
    console.log(`🔄 Processing job ${job.id}...`);
    return await processContactImport(job.data, progress => job.updateProgress(progress));
  },
  {
    connection: redisConfig,
    concurrency: 2, // Process 2 import jobs concurrently
    limiter: {
      max: 5, // Max 5 jobs
      duration: 1000, // per second
    },
  }
);

contactImportWorker.on('completed', (job) => {
  console.log(`✅ Import job ${job.id} completed successfully`);
});

contactImportWorker.on('failed', (job, err) => {
  console.error(`❌ Import job ${job?.id} failed:`, err.message);
  console.error('Stack:', err.stack);
});

contactImportWorker.on('error', (error) => {
  console.error('❌ Contact Import Worker Error:', error);
});

contactImportWorker.on('ready', () => {
  console.log('✅ Contact Import Worker is ready and listening for jobs');
});

contactImportWorker.on('active', (job) => {
  console.log(`🔄 Job ${job.id} is now active`);
});

console.log('🚀 Contact Import Worker started and waiting for jobs...');