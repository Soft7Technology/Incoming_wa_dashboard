import { Worker, Job } from 'bullmq';
import redisConfig from '@surefy/config/redis.config';
import permissionModel from '@surefy/console/app/models/permission.model';
import * as os from 'os';
import { v4 as uuidv4 } from "uuid";
import { bulkUpdateTableExecutionQueue } from '../bulkTableUpdate.queue';

async function processTableUpdate(job: Job<any>){
    const{permission,assigned_to} = job.data
    try{
        console.log(`[Job ${job.id}] Starting update table execution: ${permission}`);
        await permissionModel.assignedTeam(permission,assigned_to)
        return {
            message:  `${permission} table updated successfully`
        }
  } catch (error: any) {
    console.error(`[permission] Fatal error:`, error);
    throw error;
  }

}

export const bulkTableUdateExecutionWorker = new Worker<any>(
  'BulkTable-execution',
  async (job) => {
    const{permission,assigned_to} = job.data
    console.log(`🔄 Processing ${permission} job ${job.id}... assigning to ${assigned_to}`);
    return await processTableUpdate(job);
  },
  {
    connection: redisConfig,
    concurrency: 1, // Process 1 BulkTable at a time to avoid rate limits
    limiter: {
      max: 1, // Max 1 job
      duration: 1000, // per second
    },
  }
);


bulkTableUdateExecutionWorker.on('completed', (job) => {
  console.log(`✅ BulkTable job ${job.id} completed successfully`);
});

bulkTableUdateExecutionWorker.on('failed', (job, err) => {
  console.error(`❌ BulkTable job ${job?.id} failed:`, err.message);
  console.error('Stack:', err.stack);
});

bulkTableUdateExecutionWorker.on('error', (error) => {
  console.error('❌ BulkTable Execution Worker Error:', error);
});

bulkTableUdateExecutionWorker.on('ready', () => {
  console.log('✅ BulkTable Execution Worker is ready and listening for jobs');
});

bulkTableUdateExecutionWorker.on('active', (job) => {
  console.log(`🔄 BulkTable job ${job.id} is now active`);
});

console.log('🚀 BulkTable Execution Worker started and waiting for jobs...');