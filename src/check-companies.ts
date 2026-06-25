import db from '../library/surefy/src/database';
async function run() {
  try {
    const res = await db('companies').select('*');
    console.log("COMPANIES IN DB:", JSON.stringify(res, null, 2));
  } catch (err) {
    console.error(err);
  }
  process.exit(0);
}
run();
