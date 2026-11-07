// Container healthcheck: GET /health over TLS 1.3, verifying the service's
// certificate against the install CA (NODE_EXTRA_CA_CERTS) and its name.
import https from 'node:https';

const req = https.get({
  host: '127.0.0.1',
  port: Number(process.env.PORT || 8443),
  path: '/health',
  servername: process.env.TLS_SERVER_NAME || 'lifecycle',
  minVersion: 'TLSv1.3',
  timeout: 4000
}, (res) => process.exit(res.statusCode === 200 ? 0 : 1));
req.on('error', () => process.exit(1));
req.on('timeout', () => { req.destroy(); process.exit(1); });
