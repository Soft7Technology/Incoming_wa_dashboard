// Run the developer page without PostgreSQL, Redis or the main API's schedulers.
require('dotenv').config({ quiet: true });
require('ts-node/register');
const express = require('express');
const route = require('../src/routes/facebookLoginTest.route').default;
if (process.env.NODE_ENV === 'production') {
  console.error('The Facebook developer login test is disabled in production.');
  process.exit(1);
}
const port = Number(process.env.FACEBOOK_TEST_PORT || 8002);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('FACEBOOK_TEST_PORT must be a port between 1 and 65535.');
  process.exit(1);
}
if (!process.env.FACEBOOK_TEST_PUBLIC_URL && !process.env.FACEBOOK_PUBLIC_URL)
  process.env.FACEBOOK_TEST_PUBLIC_URL = `http://localhost:${port}`;
const app = express();
app.disable('x-powered-by');
app.use('/v1/facebook/login-test', route);
app.listen(port, '127.0.0.1', () => {
  console.log(`Facebook login test: http://localhost:${port}/v1/facebook/login-test`);
}).on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use. Set FACEBOOK_TEST_PORT to a free port.` : 'Could not start the Facebook login test server.');
  process.exitCode = 1;
});
