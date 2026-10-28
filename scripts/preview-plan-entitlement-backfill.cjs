// Read-only database preview. The actual update is the named Knex migration.
require('dotenv').config({ quiet: true });
require('ts-node/register');
require('tsconfig-paths/register');
const fs = require('node:fs');
const path = require('node:path');
const config = require('../library/surefy/src/config/knex.config').default[process.env.NODE_ENV || 'development'];
const { previewBackfill } = require('../src/database/migrations/20261019000005_backfill_plan_entitlements');
const db = require('knex')({ ...config, pool: { min: 0, max: 1 }, acquireConnectionTimeout: 15000 });

(async () => {
  try {
    const now = new Date();
    const preview = await previewBackfill(db, now);
    const directory = path.resolve(__dirname, '../backups/plan-entitlement-backfill');
    fs.mkdirSync(directory, { recursive: true });
    const backupPath = path.join(directory, `${now.toISOString().replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ captured_at: now.toISOString(), ...preview }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ mode: 'read_only', ...preview.summary, backup_path: backupPath }));
  } catch (error) {
    console.error(JSON.stringify({ code: error.code, message: error.message }));
    process.exitCode = 1;
  } finally { await db.destroy(); }
})();
