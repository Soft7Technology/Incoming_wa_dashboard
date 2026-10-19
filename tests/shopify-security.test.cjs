require('ts-node/register');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./shopify-helpers.cjs');
const BadRequest = require('../library/surefy/src/exceptions/HTTP400Error');
const policy = load('src/app/utils/passwordPolicy.ts', { '@surefy/exceptions/HTTP400Error': BadRequest });

test('password registration, changes and reset enforce the same policy before persisting a hash', async () => {
  let writes = 0,
    hashCalls = 0;
  const userModel = {
    findById: async () => ({ id: 'fixture-user' }),
    findByEmail: async () => null,
    findByPhone: async () => null,
    create: async (data) => {
      writes++;
      return data;
    },
    update: async () => {
      writes++;
    },
    changePassword: async () => {
      writes++;
    },
  };
  const auth = load('src/app/services/auth.service.ts', {
    '../models/user.model': userModel,
    '../models/company.model': {},
    '@surefy/exceptions/HTTP400Error': BadRequest,
    '@surefy/exceptions/HTTP401Error': BadRequest,
    '../utils': {},
    '../models/passwordReset.model': { deleteByUserId: async () => {} },
    '../models/userPlans.model': {},
    '../models/subscription.model': {},
    '../utils/freeTrialPolicy': {},
    '../models/team.model': {},
    '@surefy/database': {},
    '../models/companyDomain.model': { create: async () => ({}) },
    '../utils/passwordPolicy': policy,
    bcrypt: {
      hash: async (value) => {
        hashCalls++;
        return 'hash:' + value;
      },
    },
    jsonwebtoken: { verify: () => ({ userId: 'fixture-user' }) },
  }).default;
  const oldSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'test-reset-secret';
  try {
    for (const password of ['short', 'a'.repeat(73), '😀'.repeat(19), null]) {
      await assert.rejects(auth.register({ name: 'Test', email: 'test@example.test', password, role: 'user' }));
      await assert.rejects(auth.changePassword('fixture-user', password));
      await assert.rejects(auth.resetPassword('fixture-reset', password));
    }
    assert.equal(writes, 0);
    assert.equal(hashCalls, 0);
    await auth.register({ name: 'Test', email: 'test@example.test', password: 'long unique passphrase', role: 'user' });
    await auth.changePassword('fixture-user', 'another long passphrase');
    await auth.resetPassword('fixture-reset', 'a third long passphrase');
    assert.equal(writes, 3);
    assert.equal(hashCalls, 3);
  } finally {
    if (oldSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldSecret;
  }
});
