# Gallery media uploads

`POST /v1/admin/image-upload/upload` accepts multipart fields `file` and optional `name`, with the existing JWT authentication. Images have a maximum size of 16 × 1024 × 1024 bytes (16 MiB); exactly 16 MiB is accepted. Larger images return HTTP 413 with `message: "Upload Image under 16MB"` and are not queued. The shared upload middleware removes rejected image files, and the gallery service and worker also enforce the limit. Other supported media retain the existing 50 MiB limit. The 3 MB background-work boundary is implemented as 3 × 1024 × 1024 bytes (3 MiB).

- Files up to and including 3 MiB upload synchronously and preserve the existing HTTP 200 response with the gallery item in `data`.
- Larger files are staged on disk and queued to `media-upload`. The API returns HTTP 202 after receiving the file and adding the job, without waiting for Firebase.
- The combined `npm run start:worker` command includes this consumer, with one upload at a time per worker process. Multiple replicas can each process one upload.
- Both paths stream to Firebase rather than reading the whole file into a Buffer. Worker uploads use resumable storage streams with 1 MiB chunks and a two-minute attempt deadline. Failed attempts retry up to three times, with exponential backoff.
- Retries use the same Firebase object name, download token and gallery UUID. A persisted gallery record is returned on redelivery without uploading again. No successful result is returned when storage upload fails.
- The worker waits for the existing `media_gallery` schema before consuming jobs. No new database migration is required; the existing `20260911064655_create_media_gallery` migration must already be applied.

## Frontend contract

Example HTTP 202 body:

```json
{
  "success": true,
  "message": "Media upload queued for processing",
  "data": {
    "job_id": "b85e8e98-d23c-4fa4-a9c0-a8e5953a0389",
    "status": "queued",
    "execution_mode": "worker",
    "status_url": "/v1/admin/image-upload/jobs/b85e8e98-d23c-4fa4-a9c0-a8e5953a0389",
    "poll_after_ms": 2000
  }
}
```

Treat this as accepted work, not an uploaded image. Keep the job ID in component/application state and show `Processing media`. Poll `data.status_url` every two seconds with the same Authorization header. Only use a media URL when `data.status` is `completed`, from `data.result.firebase_url`. On `failed`, display `data.error` and allow a new upload. Do not attempt to use `data.firebase_url` from a 202 response.

GET statuses are `queued`, `processing`, `completed` and `failed`. A status request returns HTTP 200 even when the job's status is `failed`; inspect the JSON status. A foreign/missing job returns 404. Completed gallery records remain queryable after the Redis job expires. Job metadata is retained for one day after completion and up to seven days after failure, subject to the 1,000-job retention caps. These endpoints preserve gallery ownership by the authenticated `userId`.

### Check progress and time remaining

Take `data.job_id` from the upload's HTTP 202 response and request:

```http
GET /v1/admin/image-upload/jobs/YOUR_JOB_ID
Authorization: Bearer YOUR_JWT_TOKEN
```

Example while transferring to Firebase:

```json
{
  "success": true,
  "message": "Media upload status retrieved successfully",
  "data": {
    "job_id": "b85e8e98-d23c-4fa4-a9c0-a8e5953a0389",
    "status": "processing",
    "stage": "uploading",
    "progress": 50,
    "bytes_transferred": 2097152,
    "total_bytes": 4194304,
    "elapsed_seconds": 10,
    "processing_elapsed_seconds": 5,
    "estimated_remaining_seconds": 5,
    "attempts_made": 0,
    "max_attempts": 3,
    "poll_after_ms": 2000
  }
}
```

`progress` is a percentage based on the storage SDK's transferred-byte events, capped at 99 until completion; it does not mean Firebase has committed the object yet. `stage` distinguishes `queued`, `preparing`, `uploading`, `saving`, `completed` and `failed`. `elapsed_seconds` counts from queue submission, and `processing_elapsed_seconds` counts from the start of the current worker attempt. Progress resets when an attempt retries.

`estimated_remaining_seconds` estimates the remaining **file transfer** from its average rate. It excludes queue waiting, Firebase finalization, database persistence and future retries. It is `null` while queued, preparing or saving, before sufficient transfer data is available, after ten seconds without a fresh byte event, or after failure. Show `Calculating...` or the stage instead of a countdown when it is null. Completed uploads return `progress: 100`, `estimated_remaining_seconds: 0` and the gallery item in `result`. When completion is read directly from the gallery record, timing fields are null because the Redis timing history is not required to retrieve the result.

Poll every two seconds. Byte updates are throttled and coalesced by the worker to avoid a Redis write for every stream chunk. The browser helper passes these fields through its `onState` callback.

[The browser helper](examples/upload-gallery-media.mjs) handles both response shapes and polling. Copy it into the frontend and replace the current gallery upload request with:

```js
const image = await uploadGalleryMedia(file, {
  apiBase: API_ORIGIN,
  token: accessToken,
  name,
  onState: state => {
    setUploadState(state.status);
    // Persist state.jobId and state.statusUrl when present, so polling can resume.
  }
});
// Existing consumers can use image.firebase_url and image.id here.
```

The helper stops waiting after 15 minutes and reports `MEDIA_UPLOAD_PENDING` with the job ID; that is not a failed upload. Use `pollGalleryUpload` to resume checking. Cancelling the browser's polling does not cancel an accepted worker job. Configure the frontend's upload-request timeout long enough to transfer the file; moving storage work to a worker cannot accelerate the browser-to-server transfer.

The browser helper checks the 16 MiB image limit before sending the file and displays the same error message. Integrate this helper into the frontend to avoid transferring oversized images to the API; the backend still validates the file after multipart receipt. For an HTTP 413 response, display the API's `message` field.

## Deployment and network checks

Deploy the updated backend image to both API and combined-worker deployments. Existing worker images will not consume `media-upload`. Keep API and worker `REDIS_*`, `DATABASE_URL` and `FIREBASE_*` settings consistent. Restart both processes after updating.

**Mount the same writable persistent upload volume at `/usr/app/uploads` in both API and worker containers.** They must share the same PVC and any `subPath` value. Separate `emptyDir` volumes or each pod's image filesystem do not share files. An unavailable file produces a failed upload; mount configuration must be fixed before retrying it. Use the upload volume already shared for contact imports when available. This repository cannot verify the live Kubernetes volume configuration.

Inspect mounts with:

```sh
kubectl --kubeconfig=/etc/kubernetes/admin.conf get deployments incoming-api contact-worker -n default \
  -o 'custom-columns=DEPLOYMENT:.metadata.name,MOUNTS:.spec.template.spec.containers[*].volumeMounts,VOLUMES:.spec.template.spec.volumes'
```

After building/importing the new image using your existing containerd workflow, the combined-worker command is:

```sh
KUBECONFIG=/etc/kubernetes/admin.conf sh scripts/deploy-workers.sh YOUR_NEW_BACKEND_IMAGE
```

Replace the image placeholder with the image you actually built. That script preserves mounts and environment; it does not configure the shared volume. Worker logs include `[Media Upload] Processing in worker`, the job ID, process ID and byte count.

For a network error occurring before HTTP 202, inspect the browser Network tab and proxy logs: request body limits, request timeouts, TLS, CORS and connection loss can all prevent the request from reaching this code. The application returns HTTP 413 for images above 16 MiB and other media above 50 MiB, but a reverse proxy can reject the request earlier. Configure the matching proxy location to allow multipart overhead above the app's limit, for example:

```nginx
location /v1/admin/image-upload/ {
    client_max_body_size 55m;
    client_body_timeout 120s;
    proxy_read_timeout 180s;
    # Retain your existing upstream proxy_pass, TLS, headers and CORS configuration.
}
```

Do not replace your proxy's existing location without retaining its upstream configuration. The Firebase transfer is removed from large-upload HTTP requests; the client still sends the complete file before receiving 202.

## File lifecycle

Staged files are stored in `uploads/.media-upload`. The Express static route now explicitly ignores dot directories, keeping these files private. Successful processing removes the staged local file. Retryable attempts keep it until the next attempt; terminal failures remove it. A lost enqueue acknowledgement returns 503 with the prospective job ID/status URL in the API error details and retains its file because Redis may have accepted the job. Check that ID before uploading again. Files from an unaccepted/uncertain enqueue or abruptly terminated small upload can remain orphaned; reclaim them only after checking queue state. Do not remove files for queued, delayed or active jobs. Redis persistence and the shared upload volume are required to retain work through restarts.

Validation: `node --test tests/media-upload.test.cjs tests/media-upload-browser.test.cjs tests/startup-env.test.cjs tests/background-database.test.cjs` and `npm run build`. Tests include multipart HTTP handling against a local Express server and mock Firebase/Redis/database dependencies; no real media is uploaded.
