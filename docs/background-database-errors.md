# Background database failures

`42P01` (`campaigns` does not exist) and `42703` (`reminders.status` does not exist) mean the worker cannot use the schema its code requires. Check the worker's database configuration against the API and then check migrations. Deploying an image does not migrate a database. A table named `reminders` from another application is not necessarily compatible with this backend.

## Runtime behavior

- Each consumer validates its required tables and selected columns before consuming jobs. An unavailable schema leaves jobs waiting in Redis. This is a readiness check, not an exhaustive schema audit.
- Checks use zero rows, a five-second query deadline and a one-minute healthy cache. Acquisition still uses the configured pool timeout. Failures back off for 30, 60, 120, 240 and then 300 seconds. Concurrent failures share the same cooldown. Recovery resumes the local consumer automatically.
- Campaign and reminder scheduler scans use the same backoff. A failing feature does not pause other queue consumers.
- Recognized database/connection errors are logged at most once per component and error code per minute, with SQL and bindings omitted. Affected API requests return HTTP 503 with `Retry-After: 30`.
- Contact imports abort on database outages rather than treating every remaining row as invalid. Bulk sending stops later chunks and disables automatic batch replay if sending has begun. Campaign recipient reservations and reminder claims remain intact after an uncertain send.

Jobs already active during an outage can fail; pausing prevents further consumption. These guards do not automatically retry failed campaigns or resend uncertain outcomes. Review failed jobs and send history before restarting work. Existing campaign recipient retries and rebroadcast remain disabled. The process still requires valid startup configuration, and these guards cannot prevent failures caused by memory exhaustion or unrelated code defects.

Both database import paths now use the same configured Knex pool. The legacy path no longer chooses fallback connection settings or alters schema at startup. Schema changes belong to migrations.

## Check Kubernetes configuration

Run this on the server for both deployments. It prints database identity and schema availability without printing passwords or connection URLs:

```sh
for task_deployment in incoming-api contact-worker; do
  printf '\n%s\n' "$task_deployment"
  kubectl --kubeconfig=/etc/kubernetes/admin.conf exec -n default deployment/"$task_deployment" -- node -e '
    const {Client}=require("pg");
    const client=new Client({connectionString:process.env.DATABASE_URL});
    (async()=>{
      await client.connect();
      const result=await client.query("SELECT current_database() AS database, current_schema() AS schema, current_setting($1) AS search_path, to_regclass($2)::text AS campaigns, to_regclass($3)::text AS reminders, EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass($3) AND attname=$4 AND NOT attisdropped) AS reminders_status",["search_path","campaigns","reminders","status"]);
      console.log({host:process.env.DATABASE_URL ? new URL(process.env.DATABASE_URL).hostname : "PG environment",...result.rows[0]});
    })().catch(error=>{console.error({code:error.code||"CHECK_FAILED"});process.exitCode=1;}).finally(()=>client.end());'
done
```

If the database identities differ, correct the worker's `DATABASE_URL` Secret/configuration reference to the intended backend database and redeploy. If they match, inspect migration state on that database:

```sh
kubectl --kubeconfig=/etc/kubernetes/admin.conf exec -n default deployment/incoming-api -- \
  ./node_modules/.bin/knex --knexfile dist/library/surefy/src/config/knex.config.js migrate:list
```

Relevant migrations include `20251212000008_create_campaigns_table.ts` and `20260929000001_create_reminders.ts`. Once the target database is confirmed, apply the backend's pending migrations through your migration process. An existing incompatible `reminders` table needs a reviewed schema reconciliation; do not drop it or add a single column without checking its data and the complete migration.

## Deploy the guards

Copy the complete updated backend source to the server, rebuild a new production image and import/push it through the existing containerd/registry workflow. Reusing an old image does not include these changes. From the updated backend directory:

```sh
KUBECONFIG=/etc/kubernetes/admin.conf sh scripts/deploy-workers.sh YOUR_NEW_BACKEND_IMAGE
```

Replace the image placeholder with the image you actually built. The script defaults to the `contact-worker` deployment and its `wa-dashboard` container, and launches all four consumers through `npm run start:worker`. It preserves existing environment, volumes and resource settings; it does not correct a database Secret or run migrations. Deploy the updated API image too to activate HTTP 503 handling and campaign scheduler backoff there.

Validation uses mocked dependencies; no database migrations or real WhatsApp sends are performed by the tests.
