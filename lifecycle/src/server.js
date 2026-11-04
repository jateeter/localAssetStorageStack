import { createApp, Store } from './app.js';

const tokens = {
  admin: process.env.ADMIN_TOKEN,
  registrar: process.env.REGISTRAR_TOKEN,
  engine: process.env.ENGINE_TOKEN,
  agent: process.env.AGENT_TOKEN,
  reviewer: process.env.REVIEWER_TOKEN
};
if (!Object.values(tokens).some(Boolean) || Object.values(tokens).some((t) => t && t.length < 16)) {
  console.error('Configure *_TOKEN environment variables (min 16 chars)');
  process.exit(1);
}
const server = createApp({
  tokens,
  store: new Store(process.env.DATA_FILE || '/data/state.json'),
  podOrigin: process.env.CSS_ORIGIN || '',
  secret: process.env.RECEIPT_SECRET || undefined
});
server.listen(Number(process.env.PORT || 8080), '0.0.0.0');
