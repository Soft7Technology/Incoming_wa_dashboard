import knex from 'knex';
import dotenv from 'dotenv';

dotenv.config();

const db = knex({
  client: 'pg',
  connection: {
    host: '127.0.0.1', // FORCE LOCAL
    port: 5432,
    user: 'postgres',
    password: 'Soft7',
    database: 'console_db',
  },
  pool: {
    min: 0,
    max: 5,
    acquireTimeoutMillis: 10000, // 🔥 important
  },
});

export default db;