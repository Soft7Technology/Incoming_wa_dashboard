import 'dotenv/config';
process.env.WORKER_MODE = 'true';
import db from '@surefy/database';
import scheduler from '../app/services/shopifyMessageScheduler.service';

scheduler.start();
console.info(
  'Shopify WhatsApp worker is polling. Configure an order rule and consent capture before messages can be queued.',
);
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await scheduler.stop();
    await db.destroy();
    process.exit(0);
  } catch {
    console.error('Shopify WhatsApp worker shutdown failed.');
    process.exit(1);
  }
}
process.once('SIGTERM', () => {
  void stop();
});
process.once('SIGINT', () => {
  void stop();
});
