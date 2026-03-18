import { Knex } from 'knex';
import bcrypt from 'bcrypt';

/**
 * Seed file to create the initial superadmin user
 * Email: accounts@surefy.co
 * Password: Surefy@2024
 */
export async function seed(knex: Knex): Promise<void> {
  // Check if superadmin already exists
  const existingUser = await knex('users')
    .where({ email: 'accounts@surefy.co' })
    .first();

  if (existingUser) {
    console.log('Superadmin user already exists. Skipping seed.');
    return;
  }         

  // Hash the password
  const hashedPassword = await bcrypt.hash('Surefy@2024', 10);

  // Insert superadmin user
  await knex('users').insert({
    id: knex.raw('gen_random_uuid()'),
    name: 'Surefy Admin',
    email: 'accounts@surefy.co',
    password: hashedPassword,
    role: 'superadmin',
    status: 'active',
    created_at: knex.fn.now(),
    updated_at: knex.fn.now(),
  });

  console.log('✅ Superadmin user created successfully!');
  console.log('Email: accounts@surefy.co');
  console.log('Password: Surefy@2024');
}

