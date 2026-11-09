// Verifies a lifecycle receipt offline (ROADMAP phase 3): the receipt and the
// service's public keys (GET /keys), nothing else. No network, no service.
//
//   node scripts/verify-receipt.js receipt.json keys.json
import fs from 'node:fs';
import { verifyReceipt } from '../lifecycle/src/integrity.js';

const [receiptFile, keysFile] = process.argv.slice(2);
if (!receiptFile || !keysFile) {
  console.error('usage: node scripts/verify-receipt.js <receipt.json> <keys.json>');
  process.exit(2);
}
const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
const keys = JSON.parse(fs.readFileSync(keysFile, 'utf8'));
const ok = verifyReceipt(receipt, keys);
console.log(`${ok ? 'valid' : 'INVALID'}: ${receipt.type || '?'} ${receipt.id || '?'} (key ${receipt.kid || '?'})`);
process.exit(ok ? 0 : 1);
