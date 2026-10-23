'use strict';

const http = require('node:http');
const net = require('node:net');

const port = Number(process.env.NGROK_PROXY_PORT || 3101);
const frontendPort = Number(process.env.FRONTEND_PORT || 3001);
const apiPort = Number(process.env.API_PORT || 8001);
for (const value of [port, frontendPort, apiPort]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid local proxy port.');
}
const upstreamPort = url => /^(?:\/v1(?:\/|\?|$)|\/health(?:\?|$))/.test(url || '/') ? apiPort : frontendPort;

const server = http.createServer((req, res) => {
  const upstream = http.request({
    hostname: '127.0.0.1', port: upstreamPort(req.url),
    method: req.method, path: req.url, headers: req.headers,
  }, response => {
    res.writeHead(response.statusCode || 502, response.headers);
    response.on('error', () => res.destroy());
    response.pipe(res);
  });
  upstream.on('error', error => {
    console.error('Local upstream unavailable:', error.code || 'UNKNOWN');
    if (res.headersSent) return res.destroy();
    res.writeHead(502, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ success: false, message: 'The local frontend or backend is unavailable.' }));
  });
  req.on('aborted', () => upstream.destroy());
  res.on('close', () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
});

server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(upstreamPort(req.url), '127.0.0.1');
  upstream.on('connect', () => {
    const headers = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) headers.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers.join('\r\n')}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
  socket.on('close', () => upstream.destroy());
});

server.requestTimeout = 0;
server.on('error', error => { console.error('Local proxy failed:', error.code || 'UNKNOWN'); process.exit(1); });
server.listen(port, '127.0.0.1', () => {
  console.log(`Proxy: http://127.0.0.1:${port}; /v1 and /health -> ${apiPort}; frontend -> ${frontendPort}`);
});
