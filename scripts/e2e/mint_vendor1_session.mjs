// One-off helper: mint a fresh per-user JWT for vendor1 via the service-role
// admin magic-link flow, then build the supabase-js AsyncStorage session JSON
// to inject into the running emulator app's storage before cold-start.
//
// Output: prints a single line containing the JSON that should be written to
// AsyncStorage under the key `sb-<projectRef>-auth-token`.
//
// Usage: node scripts/e2e/mint_vendor1_session.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const driver = await import(new URL('./e2e_driver.mjs', import.meta.url).href);
const { mintTokenByEmail, ACCOUNTS } = driver;

// Read the supabase URL to extract the project ref (used for the AsyncStorage key).
const envText = readFileSync(new URL('../../.env', import.meta.url), 'utf8');
const envSupabaseUrl = envText.match(/^EXPO_PUBLIC_SUPABASE_URL=(.+)$/m)?.[1]?.trim();
if (!envSupabaseUrl) {
  throw new Error('EXPO_PUBLIC_SUPABASE_URL missing in .env');
}
// ref is the first subdomain segment of https://<ref>.supabase.co
const projectRef = envSupabaseUrl.replace(/^https?:\/\//, '').split('.')[0];
const storageKey = `sb-${projectRef}-auth-token`;

const tokens = await mintTokenByEmail(ACCOUNTS.vendor1.email);
console.error('MINT_OK user=' + ACCOUNTS.vendor1.email + ' uid=' + ACCOUNTS.vendor1.uid + ' key=' + storageKey);

// supabase-js v2 persisted session value shape (see @supabase/auth-js
// GoTrueClient#recoverSession / #_saveSession):
//   { access_token, refresh_token, expires_at, expires_in, token_type, user }
// `token_type` defaults to "bearer"; `expires_in` is seconds-until-expiry.
// We omit the user object — auth-js will refetch it on getSession() from the
// access_token's claims, which is sufficient for routing past the login gate.
const nowSec = Math.floor(Date.now() / 1000);
const expiresIn = Math.max(1, (tokens.expires_at || (nowSec + 3600)) - nowSec); // guard against missing field
const sessionValue = {
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token || null,
  expires_in: expiresIn,
  expires_at: tokens.expires_at || (nowSec + expiresIn),
  token_type: 'bearer',
  user: {
    id: ACCOUNTS.vendor1.uid,
    app_metadata: { provider: 'email', providers: ['email'] },
    user_metadata: { email: ACCOUNTS.vendor1.email },
    aud: 'authenticated',
    email: ACCOUNTS.vendor1.email,
    phone: '',
    created_at: new Date(0).toISOString(),
  },
};

// Single-line JSON for adb shell propagation. Print to stdout (data); logs on stderr.
process.stdout.write(JSON.stringify({ storageKey, sessionValue }));
