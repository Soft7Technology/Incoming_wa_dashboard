import knex, { Knex } from 'knex';
import pg from 'pg';
import knexConfig from '../config/knex.config';

// Ensure all timestamps without timezone are parsed as UTC Date objects
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (val: string) => {
  return new Date(val + 'Z');
});

const environment = process.env.NODE_ENV || 'development';
const config = knexConfig[environment];

let db: Knex;

// ✅ Single shared pool — both src/database.ts and this file use the same key
if (!(global as any).__knex_db__) {
  (global as any).__knex_db__ = knex({
    ...config,
    pool: {
      min: 2,
      max: 15,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 30000,
      afterCreate: (conn: any, done: any) => {
        conn.query("SET timezone='UTC';", (err: any) => {
          done(err, conn);
        });
      }
    }
  });
}

db = (global as any).__knex_db__;

// ✅ Close DB properly on PM2 reload
const shutdown = async () => {
  try {
    await db.destroy();
    console.log('DB disconnected');
  } catch (err) {
    console.error('Error closing DB:', err);
  }
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

export default db;