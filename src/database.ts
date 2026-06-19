import knex from 'knex';
import pg from 'pg';
import dotenv from 'dotenv';

dotenv.config();

// Ensure all timestamps without timezone are parsed as UTC Date objects
pg.types.setTypeParser(pg.types.builtins.TIMESTAMP, (val: string) => {
  return new Date(val + 'Z');
});

// ✅ Singleton — reuse the shared instance created in library/surefy/src/database/index.ts
// to avoid competing connection pools exhausting the DB.
if (!(global as any).__knex_db__) {
  (global as any).__knex_db__ = knex({
    client: 'pg',
    connection: process.env.DATABASE_URL || {
      host: process.env.DB_HOST || '154.210.206.153',
      port: Number(process.env.DB_PORT) || 5432,
      user: process.env.DB_USER || 'postgres',
      password: process.env.DB_PASSWORD || 'Soft7',
      database: process.env.DB_NAME || 'console_db',
    },
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
    },
  });
}

const db = (global as any).__knex_db__;

export default db;