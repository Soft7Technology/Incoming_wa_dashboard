// Encrypt a database export before persisting it. Does not create or schedule database backups.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const magic = Buffer.from('SOFT7BACKUP1\n');
const headerSize = magic.length + 12;

function backupKey(value) {
  const key = Buffer.from(value || '', 'base64');
  if (key.length !== 32 || key.toString('base64') !== value)
    throw Error('Set SHOPIFY_BACKUP_ENCRYPTION_KEY to a separate 32-byte base64 key from your secret manager.');
  return key;
}

async function publish(temp, output) {
  // A hard link publishes without replacing an existing destination, on the same filesystem.
  await fsp.link(temp, output);
  await fsp.unlink(temp);
}

async function encryptBackup(input, output, key) {
  const target = path.resolve(output);
  const temp = target + '.' + crypto.randomBytes(8).toString('hex') + '.partial';
  const iv = crypto.randomBytes(12);
  const header = Buffer.concat([magic, iv]);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);
  try {
    const destination = fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 });
    destination.write(header);
    await pipeline(input, cipher, destination);
    await fsp.appendFile(temp, cipher.getAuthTag());
    await publish(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  }
}

async function decryptBackup(input, output, key) {
  const source = path.resolve(input),
    target = path.resolve(output);
  const temp = target + '.' + crypto.randomBytes(8).toString('hex') + '.partial';
  const handle = await fsp.open(source, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size < headerSize + 16) throw Error('Invalid backup.');
    const header = Buffer.alloc(headerSize),
      tag = Buffer.alloc(16);
    await handle.read(header, 0, header.length, 0);
    await handle.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, magic.length).equals(magic)) throw Error('Unsupported backup format.');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, header.subarray(magic.length));
    decipher.setAAD(header);
    decipher.setAuthTag(tag);
    // Never publish unauthenticated plaintext; a failed tag removes only our temporary file.
    const encrypted =
      size === headerSize + 16
        ? require('node:stream').Readable.from([])
        : fs.createReadStream(source, { start: headerSize, end: size - 17 });
    await pipeline(encrypted, decipher, fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }));
    await publish(temp, target);
  } catch (error) {
    await fsp.rm(temp, { force: true });
    throw error;
  } finally {
    await handle.close();
  }
}

module.exports = { backupKey, encryptBackup, decryptBackup };
if (require.main === module) {
  require('dotenv/config');
  (async () => {
    const [action, input, output, ...extra] = process.argv.slice(2);
    if (
      !['encrypt', 'decrypt'].includes(action) ||
      !input ||
      !output ||
      extra.length ||
      (action === 'decrypt' && input === '-')
    )
      throw Error(
        'Usage: node scripts/shopify-backup.cjs encrypt <export-file|-> <encrypted-file> OR decrypt <encrypted-file> <isolated-restore-file>',
      );
    const key = backupKey(process.env.SHOPIFY_BACKUP_ENCRYPTION_KEY);
    if (action === 'encrypt')
      await encryptBackup(input === '-' ? process.stdin : fs.createReadStream(input), output, key);
    else await decryptBackup(input, output, key);
    console.info(
      action === 'encrypt'
        ? 'Encrypted backup written.'
        : 'Authenticated restore file written; keep it isolated and reapply erasures before use.',
    );
  })().catch(() => {
    // Avoid echoing operator paths, database input or environment contents on failure.
    console.error(
      'Backup operation failed. Check arguments, key, file permissions and backup integrity. No destination was overwritten.',
    );
    process.exitCode = 1;
  });
}
