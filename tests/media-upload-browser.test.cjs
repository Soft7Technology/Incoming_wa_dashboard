const { test } = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const helper = import(pathToFileURL(path.resolve('docs/examples/upload-gallery-media.mjs')).href);

function mockFetch(t, responses) {
  const original = global.fetch, calls = [];
  global.fetch = async (url, options) => {
    calls.push({ url, options });
    const next = responses.shift(); assert.ok(next, 'Unexpected extra request');
    return { status: next.status, ok: next.status < 400, json: async () => next.body };
  };
  t.after(() => { global.fetch = original; });
  return calls;
}
const media = () => new Blob(['image contents'], { type: 'image/jpeg' });
const success = (status, data) => ({ status, body: { success: true, data } });

test('browser helper preserves small-upload results and lets FormData supply the multipart boundary', async t => {
  const { uploadGalleryMedia } = await helper;
  const item = { id: 'image', firebase_url: 'https://example.invalid/image' };
  const calls = mockFetch(t, [success(200, item)]), states = [];
  assert.equal(await uploadGalleryMedia(media(), { apiBase: 'https://api.invalid/', token: 'fixture', name: 'Photo',
    onState: state => states.push(state.status) }), item);
  assert.deepEqual(states, ['uploading', 'completed']);
  assert.equal(calls[0].url, 'https://api.invalid/v1/admin/image-upload/upload');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer fixture');
  assert.equal(Object.hasOwn(calls[0].options.headers, 'Content-Type'), false);
  assert.equal(calls[0].options.body.get('name'), 'Photo');
});

test('browser helper treats 202 as queued and returns the gallery item only after completion', async t => {
  const { uploadGalleryMedia } = await helper;
  const item = { id: 'image', firebase_url: 'https://example.invalid/image' }, states = [];
  const statusUrl = '/v1/admin/image-upload/jobs/image';
  const calls = mockFetch(t, [success(202, { job_id: 'image', status_url: statusUrl, status: 'queued' }),
    success(200, { status: 'processing', poll_after_ms: 1 }), success(200, { status: 'completed', result: item })]);
  assert.equal(await uploadGalleryMedia(media(), { token: 'fixture', onState: state => states.push(state) }), item);
  assert.deepEqual(states.map(state => state.status), ['uploading', 'queued', 'processing', 'completed']);
  assert.equal(calls.length, 3); assert.equal(calls[1].url, statusUrl);
  assert.equal(states[2].jobId, 'image'); assert.equal(states[2].statusUrl, statusUrl);
});

test('browser helper displays HTTP and job failures instead of returning a media URL', async t => {
  const { uploadGalleryMedia } = await helper;
  mockFetch(t, [{ status: 413, body: { success: false, message: 'File too large' } }]);
  await assert.rejects(uploadGalleryMedia(media(), { token: 'fixture' }), error => error.status === 413);
});

test('HTTP 200 with failed job state rejects and pending deadlines retain resumable job metadata', async t => {
  const { pollGalleryUpload } = await helper;
  mockFetch(t, [success(200, { status: 'failed', error: 'Upload failed' })]);
  const options = { token: 'fixture', statusUrl: '/jobs/image', jobId: 'image' };
  await assert.rejects(pollGalleryUpload(options), /Upload failed/);
  await assert.rejects(pollGalleryUpload({ ...options, maxWaitMs: 0 }), error =>
    error.code === 'MEDIA_UPLOAD_PENDING' && error.jobId === 'image' && error.statusUrl === '/jobs/image');
});

test('polling cancellation stops waiting and oversized media never starts an HTTP request', async t => {
  const { pollGalleryUpload, uploadGalleryMedia } = await helper;
  const controller = new AbortController();
  const calls = mockFetch(t, [success(200, { status: 'processing', poll_after_ms: 2000 })]);
  await assert.rejects(uploadGalleryMedia({ size: 50 * 1024 * 1024 + 1 }), /up to 50 MB/);
  assert.equal(calls.length, 0);
  await assert.rejects(pollGalleryUpload({ token: 'fixture', statusUrl: '/jobs/image', jobId: 'image',
    signal: controller.signal, onState: () => controller.abort(new Error('Cancelled by user')) }), /Cancelled by user/);
  assert.equal(calls.length, 1);
});

test('browser helper rejects images over 16 MB with the requested message before sending a request', async t => {
  const { uploadGalleryMedia } = await helper;
  const calls = mockFetch(t, []);
  await assert.rejects(uploadGalleryMedia({ size: 16 * 1024 * 1024 + 1, type: 'image/jpeg' }),
    error => error.message === 'Upload Image under 16MB');
  assert.equal(calls.length, 0);
});
