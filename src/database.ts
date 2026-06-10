import knex from 'knex';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Ensure all timestamps without timezone are parsed as UTC Date objects
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (val: string) => {
  return new Date(val + 'Z');
});

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
    afterCreate: (conn: any, done: any) => {
      conn.query("SET timezone='UTC';", (err: any) => {
        done(err, conn);
      });
    }
  },
});

export default db;