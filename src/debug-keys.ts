import dotenv from 'dotenv';
dotenv.config();

import db from '../library/surefy/src/database';

async function run() {
  try {
    const user = await db('users').first();
    console.log('--- USER DATA ---');
    console.log(user);
  } catch (err) {
    console.error(err);
  } finally {
    await db.destroy();
    process.exit(0);
  }
}

run();
