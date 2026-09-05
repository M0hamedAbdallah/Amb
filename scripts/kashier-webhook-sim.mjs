// ──────────────────────────────────────────────────────────────────────────
// kashier-webhook-sim.mjs  —  Synthetic-but-realistic Kashier webhook sender
// ──────────────────────────────────────────────────────────────────────────
// Used to validate the kashier-webhook → settle_kashier_payment chain WITHOUT
// forcing a manual sandbox test-card submit through the RN WebView (a step
// we owe the user once the actual RN payment works again — see todo list).
//
// Construct a payload that mimics what Kashier's sandbox would POST after a
// successful card payment, compute the same HMAC the kashier-webhook Edge
// Function will compute back (per its documented contract — confirmed in the
// deployed kashier-webhook/index.ts source):
//   • Canonical base string: for each key in `data.signatureKeys`, in order:
//     `encodeURIComponent(key)=encodeURIComponent(String(data[key]))` joined by '&'.
//   • Signature: HMAC-SHA256(KASHIER_API_KEY, canonical) hex.
//   • Sent as the `x-kashier-signature` header.
//
// We run this as a single local node script so the HMAC computation matches
// JS encodeURIComponent semantics exactly — Postgres's urlencode differs (it
// encodes spaces as '+', JS encodes them as '%20').
//
// Usage:
//   node scripts/kashier-webhook-sim.mjs <order_ref> <amount> <currency>
// Defaults:
//   order_ref = AMB-06942214-1236-4c8a-9758-8f1cee5d5715 (our trial order)
//   amount    = 51
//   currency  = EGP
// ──────────────────────────────────────────────────────────────────────────

import crypto from 'node:crypto';

const ORDER_REF = process.argv[2] ?? 'AMB-06942214-1236-4c8a-9758-8f1cee5d5715';
const AMOUNT    = Number(process.argv[3] ?? 51);
const CURRENCY  = process.argv[4] ?? 'EGP';

// .env is NOT auto-loaded in plain node; hard-code + accept override via env.
const KASHIER_API_KEY = process.env.KASHIER_API_KEY
  ?? '24c89710-01e8-42aa-b9eb-47325cc6caf7';
const WEBHOOK_URL = process.env.KASHIER_WEBHOOK_URL
  ?? 'https://kazcnxfpmgyzjpevqxiu.supabase.co/functions/v1/kashier-webhook';

// Synthesize a plausible Kashier transactionId (Kashier uses a 14-24 hex
// string + sometimes a dash; we mimic SHA-1 hex truncated).
const TRANSACTION_ID = 'SIM-' + crypto.createHash('sha1').update(`${ORDER_REF}-${Date.now()}`).digest('hex').slice(0, 16).toUpperCase();

// Signature keys must be the SAME set Kashier actually returns. We mirror a
// realistic set: amount + currency + orderId + status + transactionId. This
// is the array the kashier-webhook Edge Function walks in order.
const SIGNATURE_KEYS = ['amount', 'currency', 'orderId', 'status', 'transactionId'];

// Build the canonical string EXACTLY like canonicalStringFromSignatureKeys():
//   encodeURIComponent(key)=encodeURIComponent(String(value)) joined by '&'
function buildCanonical(data, sigKeys) {
  return sigKeys.map((k) => {
    const raw = data[k];
    const v = (raw === undefined || raw === null) ? '' : String(raw);
    return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`;
  }).join('&');
}

// Synthesize the webhook envelope. Mirrors the shape in the deployed
// kashier-webhook source's VERIFY block + the confirmed Kashier docs:
//   { platform, event, data: { orderId, transactionId, amount, currency,
//                              status, signatureKeys, ... } }
const payload = {
  platform: 'kashier',
  event: 'pay',
  data: {
    orderId: ORDER_REF,
    transactionId: TRANSACTION_ID,
    amount: AMOUNT,
    currency: CURRENCY,
    status: 'SUCCESS',
    signatureKeys: SIGNATURE_KEYS,
    // Extra fields Kashier typically includes — kept for raw_payload realism.
    paymentType: 'credit',
    paymentMethod: 'card',
    merchantId: 'MID-48992-883',
    mode: 'test',
    createdDate: new Date().toISOString(),
    cartId: ORDER_REF,
  },
};

const canonical = buildCanonical(payload.data, SIGNATURE_KEYS);

const expectedSig = crypto
  .createHmac('sha256', KASHIER_API_KEY)
  .update(canonical, 'utf8')
  .digest('hex');

console.log(JSON.stringify({
  evt: 'sim_built',
  webhook_url: WEBHOOK_URL,
  order_ref: ORDER_REF,
  amount: AMOUNT,
  currency: CURRENCY,
  transaction_id: TRANSACTION_ID,
  signature_keys: SIGNATURE_KEYS,
  canonical,
  expected_signature: expectedSig,
}, null, 2));

// POST to the webhook endpoint. Send the same headers Kashier would.
const res = await fetch(WEBHOOK_URL, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'User-Agent': 'KASHIER',
    'x-kashier-signature': expectedSig,
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
let json = null;
try { json = text ? JSON.parse(text) : null; } catch { /* leave null */ }

console.log(JSON.stringify({
  evt: 'sim_response',
  http_status: res.status,
  response_body: text.slice(0, 1000),
  parsed: json,
}, null, 2));
