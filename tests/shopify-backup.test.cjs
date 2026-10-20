const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { backupKey, encryptBackup, decryptBackup } = require('../scripts/shopify-backup.cjs');

test('encrypted backups round-trip binary exports, empty exports and independent encryption nonces', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft7-backup-'));
  const key = backupKey(crypto.randomBytes(32).toString('base64'));
  try {
    for (const data of [
      Buffer.alloc(0),
      Buffer.concat([Buffer.from('PGDMP:private-recipient'), crypto.randomBytes(140000)]),
    ]) {
      const prefix = path.join(dir, crypto.randomUUID());
      await encryptBackup(Readable.from([data]), prefix + '.a', key);
      await encryptBackup(Readable.from([data]), prefix + '.b', key);
      const encrypted = await fs.readFile(prefix + '.a');
      assert.notDeepEqual(encrypted, await fs.readFile(prefix + '.b'));
      assert.equal(encrypted.includes(Buffer.from('private-recipient')), false);
      await decryptBackup(prefix + '.a', prefix + '.dump', key);
      assert.deepEqual(await fs.readFile(prefix + '.dump'), data);
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('tampering, wrong keys and truncated backups never publish plaintext or overwrite existing files', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'soft7-backup-'));
  const key = crypto.randomBytes(32),
    encrypted = path.join(dir, 'data.enc'),
    output = path.join(dir, 'restore.dump');
  try {
    await encryptBackup(Readable.from([Buffer.from('personal-data')]), encrypted, key);
    await assert.rejects(decryptBackup(encrypted, output, crypto.randomBytes(32)));
    await assert.rejects(fs.access(output));
    const original = await fs.readFile(encrypted);
    for (const position of [0, 15, original.length - 17, original.length - 1]) {
      const tampered = Buffer.from(original);
      tampered[position] ^= 1;
      const file = path.join(dir, 'tampered');
      await fs.writeFile(file, tampered);
      await assert.rejects(decryptBackup(file, output, key));
      await assert.rejects(fs.access(output));
    }
    await fs.writeFile(path.join(dir, 'truncated'), original.subarray(0, 10));
    await assert.rejects(decryptBackup(path.join(dir, 'truncated'), output, key));
    await fs.writeFile(output, 'keep-existing');
    await assert.rejects(decryptBackup(encrypted, output, key));
    assert.equal(await fs.readFile(output, 'utf8'), 'keep-existing');
    await assert.rejects(encryptBackup(Readable.from(['replacement']), encrypted, key));
    assert.deepEqual(await fs.readFile(encrypted), original);
    await assert.rejects(
      encryptBackup(
        require('node:fs').createReadStream(path.join(dir, 'missing-export')),
        path.join(dir, 'missing.enc'),
        key,
      ),
    );
    await assert.rejects(fs.access(path.join(dir, 'missing.enc')));
    assert.equal(
      (await fs.readdir(dir)).some((name) => name.endsWith('.partial')),
      false,
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
