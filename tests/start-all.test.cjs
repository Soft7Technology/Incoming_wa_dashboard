const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

test('container supervisor detects either process failure and forwards shutdown to both children', {
  skip: process.platform === 'win32', timeout: 15000,
}, async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'soft7-supervisor-'));
  const events = path.join(directory, 'events');
  fs.writeFileSync(path.join(directory, 'node'), `#!/bin/sh
case "$1" in *server.js) role=api;; *) role=worker;; esac
echo "$role:started:$WORKER_MODE" >> "$TEST_EVENTS"
trap 'echo "$role:term" >> "$TEST_EVENTS"; exit 0' TERM INT
if [ "$role" = "$FAIL_ROLE" ]; then sleep 0.2; exit 7; fi
while :; do sleep 0.1; done
`, { mode: 0o755 });
  try {
    for (const role of ['api', 'worker', 'neither']) {
      fs.writeFileSync(events, '');
      const child = spawn('sh', ['start-all.sh'], { cwd: process.cwd(), stdio: 'ignore', env: {
        ...process.env, PATH: `${directory}:${process.env.PATH}`, TEST_EVENTS: events, FAIL_ROLE: role,
      } });
      const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code)); });
      const timeout = setTimeout(() => child.kill('SIGKILL'), 4000);
      try {
        if (role === 'neither') {
          while (!fs.readFileSync(events, 'utf8').includes('worker:started:true')) {
            await new Promise(resolve => setTimeout(resolve, 20));
          }
          child.kill('SIGTERM');
        }
        assert.equal(await exited, role === 'neither' ? 0 : 7);
        const log = fs.readFileSync(events, 'utf8');
        assert.match(log, /worker:started:true/);
        if (role !== 'api') assert.match(log, /api:term/);
        if (role !== 'worker') assert.match(log, /worker:term/);
      } finally { clearTimeout(timeout); child.kill('SIGTERM'); }
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
