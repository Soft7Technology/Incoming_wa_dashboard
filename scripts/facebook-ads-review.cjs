'use strict';

// Runs the existing public Meta routes without campaign schedulers or workers.
require('dotenv').config({ quiet: true });
require('ts-node/register/transpile-only');
require('tsconfig-paths/register');
const express = require('express');
const helmet = require('helmet');
const port = Number(process.env.FACEBOOK_ADS_REVIEW_PORT || 8002);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid FACEBOOK_ADS_REVIEW_PORT.');
process.env.FACEBOOK_PUBLIC_URL = process.env.FACEBOOK_ADS_REVIEW_PUBLIC_URL || `http://localhost:${port}`;
const publicRoutes = require('../src/routes/facebookPublic.route').default;
const app = express();
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb', verify(req, _res, bytes) { req.rawBody = Buffer.from(bytes); } }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
app.use('/v1/facebook', publicRoutes);
app.use((_req, res) => res.sendStatus(404));
app.use((_error, _req, res, _next) => res.status(500).json({ success: false, message: 'The review server could not complete this request.' }));
const server = app.listen(port, '127.0.0.1', () => console.log(`Business & Ads: http://localhost:${port}/v1/facebook/ads`));
server.on('error', error => { console.error('Review server startup failed:', error.code || 'UNKNOWN'); process.exit(1); });
