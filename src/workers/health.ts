import { createServer } from 'node:http';

/** Internal probes: external service outages must not cause liveness restart loops. */
export function startWorkerHealth(isReady: () => boolean, port = Number(process.env.WORKER_HEALTH_PORT || 8002)) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Invalid WORKER_HEALTH_PORT');
  const server = createServer((req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (req.url === '/live') { res.writeHead(200); res.end('{"success":true}'); return; }
    if (req.url === '/ready') {
      let ready = false;
      try { ready = isReady(); } catch { /* report not-ready without crashing the worker */ }
      res.writeHead(ready ? 200 : 503);
      res.end(JSON.stringify({ success: ready }));
      return;
    }
    res.writeHead(404); res.end('{"success":false}');
  });
  server.listen(port, '0.0.0.0');
  return server;
}
