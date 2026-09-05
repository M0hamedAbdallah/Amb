// ─────────────────────────────────────────────────────────────────────────
// env.mjs — loads security-tests/.env.local and exports public config.
// Only PUBLIC values live here (anon key is public by design). The service
// role key must never appear in this folder.
// ─────────────────────────────────────────────────────────────────────────
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

function loadEnv() {
  const out = {};
  try {
    const text = readFileSync(join(here, '..', '.env.local'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2];
    }
  } catch {
    // fall through — caller sees empty strings and fails loudly
  }
  return out;
}

const raw = loadEnv();

export const ENV = {
  URL: raw.SUPABASE_URL ?? '',
  ANON_KEY: raw.SUPABASE_ANON_KEY ?? '',
  FIXTURE_PASSWORD: raw.FIXTURE_PASSWORD ?? 'SecTest!2026#Amb',
  WEB_ORIGIN: 'https://ambobtak.vercel.app',
};

if (!ENV.URL || !ENV.ANON_KEY) {
  console.error('Missing SUPABASE_URL / SUPABASE_ANON_KEY in security-tests/.env.local');
  process.exit(1);
}

// Fixture accounts — created via the runbook in fixtures/setup.md (GoTrue
// signup + SQL confirm/roles) and deleted after the run. Domain is
// throwaway (we never read mail there) but must be a VALID TLD — GoTrue
// rejects e.g. .local at signup.
export const FX = {
  cust1: 'sec+cust1@sectest.dev',
  cust2: 'sec+cust2@sectest.dev',
  vendor: 'sec+vendor@sectest.dev',
  support: 'sec+support@sectest.dev',
  admin: 'sec+admin2@sectest.dev',
  locked: 'sec+locked@sectest.dev',
  off: 'sec+off@sectest.dev',
};

export const PHONES = {
  [FX.cust1]: '+201009900001',
  [FX.cust2]: '+201009900002',
  [FX.vendor]: '+201009900003',
  [FX.support]: '+201009900004',
  [FX.admin]: '+201009900005',
  [FX.locked]: '+201009900006',
  [FX.off]: '+201009900007',
};

export const WEB_ORIGIN = ENV.WEB_ORIGIN;
