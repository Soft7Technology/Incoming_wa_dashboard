// import knex, { Knex } from 'knex';
// import knexConfig from '../config/knex.config';

// const environment = process.env.NODE_ENV || 'development';
// const config = knexConfig[environment];

// const db: Knex = knex(config);

// export default db;
import knex, { Knex } from 'knex';
import knexConfig from '../config/knex.config';

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
      idleTimeoutMillis: 10000
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