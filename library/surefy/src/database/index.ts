// import knex, { Knex } from 'knex';
// import knexConfig from '../config/knex.config';

// const environment = process.env.NODE_ENV || 'development';
// const config = knexConfig[environment];

// const db: Knex = knex(config);

// export default db;
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

// ✅ Prevent multiple connections (singleton)
if (!(global as any).db) {
  (global as any).db = knex({
    ...config,

    // ✅ Add connection pool
    pool: {
      min: 2,
      max: 5,
      acquireTimeoutMillis: 30000,
      idleTimeoutMillis: 10000,
      afterCreate: (conn: any, done: any) => {
        conn.query("SET timezone='UTC';", (err: any) => {
          done(err, conn);
        });
      }
    }
  });
}

db = (global as any).db;

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