'use strict';

// Live permission checks. Credentials stay encrypted on disk and in memory.
// --run authorizes a temporary unpublished post and comment, both cleaned up.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
require('dotenv').config({ quiet: true });

async function main() {
  const root = path.resolve(__dirname, '..');
  const args = process.argv.slice(2);
  let pageId, run = false;
  let tokenFile = path.join(root, '.facebook-test-runtime/page-permissions-token.json');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--page') pageId = args[++i];
    else if (args[i] === '--token-file') tokenFile = path.resolve(args[++i]);
    else if (args[i] === '--run') run = true;
    else throw new Error('Use --page PAGE_ID, --token-file ENCRYPTED_JSON_FILE and/or --run.');
  }
  if (pageId && !/^\d{1,80}$/.test(pageId)) throw new Error('Invalid Page ID.');
  const appId = process.env.FACEBOOK_APP_ID, secret = process.env.FACEBOOK_APP_SECRET;
  const version = process.env.FACEBOOK_GRAPH_VERSION;
  if (!/^\d+$/.test(appId || '') || !secret || !/^v\d+\.\d+$/.test(version || ''))
    throw new Error('Configure the Facebook app ID, secret and Graph API version.');
  const { decrypt } = require(path.join(root, 'dist/src/app/utils/facebook'));
  const userToken = decrypt(JSON.parse(fs.readFileSync(tokenFile, 'utf8')).token_ciphertext);
  const sensitive = new Set([secret, userToken, `${appId}|${secret}`]);
  const required = ['pages_read_user_content', 'pages_manage_engagement', 'pages_manage_posts'];
  const report = { checked_at: new Date().toISOString(), app_id: appId, graph_version: version,
    login_config_id: process.env.FACEBOOK_LOGIN_CONFIG_ID, mode: run ? 'live API checks with temporary content and cleanup' : 'read-only token validation',
    required_permissions: required, calls: [], permission_results: {} };
  const destination = path.join(root, '.facebook-test-runtime/page-permission-test-report.json');
  function redact(value) {
    let text = JSON.stringify(value);
    for (const item of sensitive) if (item) text = text.split(item).join('[redacted]');
    return JSON.parse(text.replace(/EAA[A-Za-z0-9_-]{20,}/g, '[redacted]'));
  }
  function save() { fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, JSON.stringify(redact(report), null, 2) + '\n'); }
  async function call(endpoint, token, method = 'GET', params = {}, body, permission, purpose) {
    const url = new URL(`https://graph.facebook.com/${version}/${endpoint}`);
    url.searchParams.set('appsecret_proof', crypto.createHmac('sha256', secret).update(token).digest('hex'));
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const record = { endpoint: `${method} /${endpoint}`, ...(permission ? { permission } : {}), purpose };
    let data;
    try {
      const response = await fetch(url, { method, redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}) },
        ...(body ? { body: new URLSearchParams(body).toString() } : {}) });
      data = await response.json();
      record.http_status = response.status;
      record.success = response.ok && !data.error;
      record.served_api_version = response.headers.get('facebook-api-version');
      if (data.error) record.error = { code: data.error.code, subcode: data.error.error_subcode,
        message: data.error.message, trace_id: data.error.fbtrace_id };
      else if (data.id) record.object_id = data.id;
      else if (Array.isArray(data.data)) record.row_count = data.data.length;
      else if (typeof data.success === 'boolean') record.confirmed = data.success;
    } catch { record.success = false; record.unconfirmed = method !== 'GET'; record.error = { message: 'No confirmed Meta response. Do not automatically repeat writes.' }; }
    report.calls.push(redact(record)); save(); console.log(JSON.stringify(redact(record)));
    return { ok: record.success, data, record };
  }
  try {
    const debug = await call('debug_token', `${appId}|${secret}`, 'GET', { input_token: userToken }, undefined, undefined, 'Validate token belongs to configured app');
    const info = debug.data?.data;
    report.token = { valid: Boolean(info?.is_valid), app_id: info?.app_id, type: info?.type };
    if (!info?.is_valid || String(info.app_id) !== appId || info.type !== 'USER')
      throw new Error('A valid USER access token for the configured app is required.');
    const grants = await call('me/permissions', userToken, 'GET', {}, undefined, undefined, 'Check granted permissions');
    const granted = (grants.data?.data || []).filter(row => row.status === 'granted').map(row => row.permission);
    report.granted_permissions = granted;
    report.missing_permissions = required.filter(permission => !granted.includes(permission));
    console.log(JSON.stringify({ app_id: appId, granted_permissions: granted, missing_permissions: report.missing_permissions }));
    const pages = [];
    let after;
    for (let i = 0; i < 20; i++) {
      const response = await call('me/accounts', userToken, 'GET', { fields: 'id,name,access_token,tasks', limit: 100,
        ...(after ? { after } : {}) }, undefined, undefined, 'List Pages authorized to this token');
      if (!response.ok) break;
      for (const page of response.data.data || []) { if (page.access_token) sensitive.add(page.access_token); pages.push(page); }
      if (!response.data.paging?.next) break;
      const next = response.data.paging.cursors?.after;
      if (!next || next === after) break;
      after = next;
    }
    const selected = pageId ? pages.find(page => String(page.id) === pageId) : pages.length === 1 ? pages[0] : null;
    if (!selected?.access_token) {
      report.pages = pages.map(page => ({ id: page.id, name: page.name }));
      throw new Error('Select one authorized Page with --page PAGE_ID.');
    }
    report.page = { id: selected.id, name: selected.name };
    if (!run) return;
    const token = selected.access_token;
    const read = await call(`${selected.id}/tagged`, token, 'GET', { fields: 'id,created_time', limit: 1 }, undefined,
      'pages_read_user_content', 'Read posts tagging the managed Page');
    report.permission_results.pages_read_user_content = read.ok;
    let postId, commentId;
    try {
      const marker = `Temporary API permission check ${crypto.randomUUID()}`;
      const created = await call(`${selected.id}/feed`, token, 'POST', {}, { message: marker, published: 'false' },
        'pages_manage_posts', 'Create a temporary unpublished test post');
      report.permission_results.pages_manage_posts = created.ok && Boolean(created.data?.id);
      postId = created.ok ? created.data?.id : undefined;
      let commentPost = postId;
      if (!commentPost && !created.record.unconfirmed) {
        const posts = await call(`${selected.id}/posts`, token, 'GET', { fields: 'id', limit: 1 }, undefined, undefined,
          'Locate a post on the explicitly selected test Page for the engagement check');
        commentPost = posts.data?.data?.[0]?.id;
      }
      if (commentPost) {
        const commented = await call(`${commentPost}/comments`, token, 'POST', {}, { message: marker },
          'pages_manage_engagement', 'Create a temporary test comment');
        report.permission_results.pages_manage_engagement = commented.ok && Boolean(commented.data?.id);
        commentId = commented.ok ? commented.data?.id : undefined;
        if (commented.record.unconfirmed) report.cleanup_warning = 'Comment creation was unconfirmed. Inspect this post before repeating: ' + commentPost;
      } else {
        report.permission_results.pages_manage_engagement = false;
        report.engagement_blocker = 'No accessible post available for the comment endpoint; no comment request was sent.';
      }
      if (created.record.unconfirmed) report.cleanup_warning = 'Post creation was unconfirmed. Inspect the selected Page before repeating.';
    } finally {
      if (commentId) {
        const removed = await call(commentId, token, 'DELETE', {}, undefined, undefined, 'Remove only the test comment created by this run');
        report.comment_cleanup = removed.ok && removed.data?.success === true;
      }
      if (postId) {
        const removed = await call(postId, token, 'DELETE', {}, undefined, undefined, 'Remove only the test post created by this run');
        report.post_cleanup = removed.ok && removed.data?.success === true;
      }
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : 'Permission check failed.';
    process.exitCode = 1;
  } finally {
    report.success = required.every(permission => report.permission_results[permission] === true);
    if (run && !report.success) process.exitCode = 1;
    save();
    console.log(JSON.stringify(redact({ report: destination, success: report.success,
      results: report.permission_results, error: report.error, engagement_blocker: report.engagement_blocker })));
  }
}

if (require.main === module) main().catch(() => { console.error('Check failed. Verify .env, the encrypted token file and the production build.'); process.exitCode = 1; });
