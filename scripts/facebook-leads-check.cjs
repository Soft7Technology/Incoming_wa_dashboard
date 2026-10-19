// Read-only diagnostics. The token file contains ciphertext encrypted with the
// configured FACEBOOK_TOKEN_ENCRYPTION_KEY; no token or lead answers are printed.
const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');
let facebookErrorType;

async function main() {
  const root = path.resolve(__dirname, '..');
  if (fs.existsSync(path.join(root, '.env'))) {
    const env = dotenv.parse(fs.readFileSync(path.join(root, '.env')));
    for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  }
  const args = process.argv.slice(2);
  let pageId,
    tokenFile = path.join(root, '.facebook-test-runtime/facebook-leads-token.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--page') pageId = args[++i];
    else if (args[i] === '--token-file') tokenFile = args[++i];
    else throw new Error('Use --page PAGE_ID and/or --token-file ENCRYPTED_JSON_FILE.');
  }
  if (pageId !== undefined && !/^\d{1,80}$/.test(pageId)) throw new Error('Invalid Page ID.');
  const { decrypt, FacebookError, leadPermissions } = require(path.join(root, 'dist/src/app/utils/facebook.js'));
  facebookErrorType = FacebookError;
  const graph = require(path.join(root, 'dist/src/app/services/facebookGraph.service.js')).default;
  const token = decrypt(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token_ciphertext);
  const auth = await graph.inspectUser(token);
  const missing = leadPermissions.filter((permission) => !auth.granted.includes(permission));
  if (missing.length) throw new FacebookError(403, 'Missing permissions: ' + missing.join(', '), 'MISSING_PERMISSIONS');
  const pages = await graph.pages(token, 'leads');
  console.log(
    JSON.stringify(
      {
        token_valid: true,
        required_permissions_granted: true,
        pages: pages.map((page) => ({ id: String(page.id), name: page.name })),
      },
      null,
      2,
    ),
  );
  if (!pageId) return;
  const page = pages.find((page) => String(page.id) === pageId);
  if (!page) throw new FacebookError(403, 'The selected Page is not available to this token.');
  await graph.inspectPage(pageId, page.access_token);
  let after,
    count = 0;
  do {
    const result = await graph.call(pageId + '/leadgen_forms', page.access_token, 'GET', {
      fields: 'id,name,status,questions',
      limit: 100,
      ...(after ? { after } : {}),
    });
    if (!Array.isArray(result.data)) throw new FacebookError(502, 'Meta returned an invalid form list.');
    console.log(
      JSON.stringify(
        {
          page_id: pageId,
          forms: result.data.map((form) => ({
            id: form.id,
            name: form.name,
            status: form.status,
            question_count: form.questions?.length || 0,
          })),
        },
        null,
        2,
      ),
    );
    const next = result.paging?.next ? result.paging.cursors?.after : null;
    if (result.paging?.next && (!next || next === after))
      throw new FacebookError(502, 'Meta form pagination did not advance.');
    after = next;
    if (++count >= 100 && after) throw new FacebookError(502, 'Form listing exceeded 100 batches.');
  } while (after);
}

main().catch((error) => {
  // Avoid printing HTTP request objects, tokens, DB strings or file contents.
  console.error(
    JSON.stringify(
      facebookErrorType && error instanceof facebookErrorType
        ? { success: false, code: error.code, message: error.message }
        : {
            success: false,
            message: 'Check the production build, Facebook settings, encrypted token file and Page argument.',
          },
    ),
  );
  process.exitCode = 1;
});
