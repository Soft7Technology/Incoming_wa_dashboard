/**
 * Background Worker Process
 * This process handles all background job processing including:
 * - Contact imports
 * - Campaign executions
 * - Bulk message sending
 *
 * To run: npm run worker
 *
 * NOTE: WORKER_MODE environment variable is set via package.json script
 */

console.log('🚀 Startings background workers...');
console.log(`⚙️  Worker modes: ${process.env.WORKER_MODE === 'true' ? 'ENABLED' : 'DISABLED'}`);

// Import the worker processors (this will start the BullMQ workers)
import '../queues/processors/contactImport.processor';
import '../queues/processors/campaignExecution.processor';
import '../queues/processors/bulkMessageSend.processor';

console.log('✅ Background workers started successful');
console.log('📦 Active worker:');
console.log('  - Contact Import Worker (concurrency: 2)');
console.log('  - Campaign Execution Worker (concurrency: 1)');
console.log('  - Bulk Message Send Worker (concurrency: 2)');
console.log('\nPress Ctrl+C to stop workers');

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('\n⏳ Shutting down workers gracefully...');
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('\n⏳ Shutting down workers gracefully...');
  process.exit(0);
});
