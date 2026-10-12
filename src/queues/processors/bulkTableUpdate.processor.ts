import { Job } from 'bullmq';
import { createDatabaseAwareWorker } from '../databaseAwareWorker';
import { reportBackgroundError } from '@surefy/utils/databaseErrors';
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
    reportBackgroundError('Worker BulkTable-execution', error, { jobId: job.id });
    throw error;
  }

}

export const bulkTableUdateExecutionWorker = createDatabaseAwareWorker<any>(
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
  reportBackgroundError('Worker BulkTable-execution', err, { jobId: job?.id });
});

bulkTableUdateExecutionWorker.on('error', (error) => {
  reportBackgroundError('Worker BulkTable-execution', error);
});

bulkTableUdateExecutionWorker.on('ready', () => {
  console.log('✅ BulkTable Execution Worker is ready and listening for jobs');
});

bulkTableUdateExecutionWorker.on('active', (job) => {
  console.log(`🔄 BulkTable job ${job.id} is now active`);
});

console.log('🚀 BulkTable Execution Worker started and waiting for jobs...');
