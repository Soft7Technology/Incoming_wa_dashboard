// Browser integration: apiBase is the API origin (without a /v1 suffix).
async function apiRequest(apiBase, route, token, options = {}) {
  const response = await fetch(`${apiBase.replace(/\/$/, '')}${route}`, {
    ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
  });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.success) {
    const error = new Error(body?.message || `Media request failed (HTTP ${response.status}).`);
    error.status = response.status;
    error.details = body?.error;
    throw error;
  }
  return { httpStatus: response.status, data: body.data };
}

function pollDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason || new Error('Polling cancelled'));
    const cancel = () => { clearTimeout(timer); reject(signal.reason || new Error('Polling cancelled')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
}

export async function pollGalleryUpload({ apiBase = '', token, statusUrl, jobId, signal,
  onState = () => {}, maxWaitMs = 15 * 60 * 1000 }) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const { data } = await apiRequest(apiBase, statusUrl, token, { signal });
    onState({ ...data, jobId, statusUrl });
    if (data.status === 'completed') return data.result;
    if (data.status === 'failed') throw new Error(data.error || 'Media upload failed.');
    await pollDelay(data.poll_after_ms || 2000, signal);
  }
  const error = new Error('Media is still processing. Resume checking this job instead of uploading the file again.');
  Object.assign(error, { code: 'MEDIA_UPLOAD_PENDING', jobId, statusUrl });
  throw error;
}

export async function uploadGalleryMedia(file, { apiBase = '', token, name, signal, onState = () => {} } = {}) {
  if (file?.type?.startsWith('image/') && file.size > 16 * 1024 * 1024) throw new Error('Upload Image under 16MB');
  if (!file || file.size === 0 || file.size > 50 * 1024 * 1024) throw new Error('Select a media file up to 50 MB.');
  const form = new FormData(); form.append('file', file);
  if (name !== undefined) form.append('name', name);
  onState({ status: 'uploading' });
  // Let the browser set Content-Type and its multipart boundary.
  const { httpStatus, data } = await apiRequest(apiBase, '/v1/admin/image-upload/upload', token,
    { method: 'POST', body: form, signal });
  if (httpStatus !== 202) { onState({ status: 'completed', result: data }); return data; }
  onState({ ...data, jobId: data.job_id, statusUrl: data.status_url });
  return pollGalleryUpload({ apiBase, token, statusUrl: data.status_url, jobId: data.job_id, signal, onState });
}
