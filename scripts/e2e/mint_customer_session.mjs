// One-off helper: mint a fresh per-user JWT for the customer via the
// service-role admin magic-link flow, then build the supabase-js
// AsyncStorage session JSON to inject into the running emulator app's
// storage before cold-start.
//
// Output: prints a single line containing the JSON that should be written
// to AsyncStorage under the key `sb-<projectRef>-auth-token`.
//
// Usage: node scripts/e2e/mint_customer_session.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const driver = await import(new URL('./e2e_driver.mjs', import.meta.url).href);
const { mintTokenByEmail, ACCOUNTS } = driver;

const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const envSupabaseUrl = envText.match(/^EXPO_PUBLIC_SUPABASE_URL=(.+)$/m)?.[1]?.trim();
if (!envSupabaseUrl) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL missing in .env');
}
const projectRef = envSupabaseUrl.replace(/^https?:\/\//, '').split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

const tokens = await mintTokenByEmail(ACCOUNTS.customer.email);
console.error('MINT_OK user=' + ACCOUNTS.customer.email + ' uid=' + ACCOUNTS.customer.uid + ' key=' + storageKey);

const nowSec = Math.floor(Date.now() / 1000);
const expiresIn = Math.max(1, (tokens.expires_at || (nowSec + 3600)) - nowSec);
const sessionValue = {
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token || null,
  expires_in: expiresIn,
  expires_at: tokens.expires_at || (nowSec + expiresIn),
  token_type: 'bearer',
  user: {
    id: ACCOUNTS.customer.uid,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { email: ACCOUNTS.customer.email },
    aud: 'authenticated',
    email: ACCOUNTS.customer.email,
    phone: '',
    created_at: new Date(0).toISOString(),
  },
};

process.stdout.write(JSON.stringify({ storageKey, sessionValue }));
