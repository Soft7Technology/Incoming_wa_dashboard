import 'dotenv/config';
import db from '@surefy/database';
import service from '../app/services/shopify.service';

// Also run this after restoring a backup, before accepting traffic, to reapply privacy work.
service
  .maintainPrivacy()
  .then((counts) => {
    console.info('Shopify privacy maintenance:', counts);
    if (counts.failed) process.exitCode = 1;
  })
  .catch(() => {
    console.error('Shopify privacy maintenance failed. Check migrations, database access and the encryption key.');
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
