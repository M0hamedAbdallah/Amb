// Pull RKStorage from the running device, upsert the customer auth-token row,
// push it back, force-stop + relaunch the app. Binary-safe (lives entirely in
// Node execFileSync Buffers — no Git Bash pipe corruption).
//
// Usage: node scripts/e2e/inject_session.mjs <sessionJSON>
//   sessionJSON: file produced by mint_customer_session.mjs (JSON only, the
//   MINT_OK stderr log line on stderr is fine but must NOT be on the stdout-
//   captured line we read).

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';

const ADB = 'C:/Users/pacman/AppData/Local/Android/Sdk/platform-tools/adb.exe';
const PKG = 'com.m0hamedabd0.ambobtak';
const DB_NAME = 'RKStorage';
const DB_PATH_DEVICE_AUTH = `databases/${DB_NAME}`;
const TMP_DB_PULL = 'RKStorage.live.cust';
const TMP_DB_PUSH = 'RKStorage.live.injected';
const TMP_DB_REMOTE = '/data/local/tmp/RKStorage.cust';

const sessionPath = process.argv[2];
if (!sessionPath) {
  console.error('usage: inject_session.mjs <sessionJSON>');
  process.exit(1);
}
const { storageKey, sessionValue } = JSON.parse(readFileSync(sessionPath, 'utf8'));
const rowValue = JSON.stringify(sessionValue);
console.error(`[inject] storageKey=${storageKey} rowValueLen=${rowValue.length}`);

const serial = 'emulator-5554';
const adbArgs = (arr) => ['-s', serial, ...arr];

// 1. Pull the existing RKStorage (binary-safe via Buffer).
console.error('[inject] pulling live RKStorage…');
const buf = execFileSync(ADB, adbArgs(['exec-out', 'run-as', PKG, 'cat', DB_PATH_DEVICE_AUTH]));
writeFileSync(TMP_DB_PULL, buf);
console.error(`[inject] pulled ${buf.length} bytes → ${TMP_DB_PULL}`);

// 2. Upsert the session row via Python (stdlib sqlite3).
const pyScript = `
import json, sqlite3, sys
db, key, val = sys.argv[1], sys.argv[2], sys.argv[3]
conn = sqlite3.connect(db)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
cur.execute("INSERT OR REPLACE INTO catalystLocalStorage (key, value) VALUES (?, ?)", (key, val))
conn.commit()
conn.close()
print('OK')
`;
const py = spawnSync('python', ['-c', pyScript, TMP_DB_PULL, storageKey, rowValue]);
if (py.status !== 0) {
  console.error('[inject] python failed:', py.stderr?.toString());
  process.exit(py.status || 1);
}
console.error('[inject] upsert ok:', py.stdout?.toString().trim());

// 3. Push the modified DB to /data/local/tmp (run-as package can't write to
//    /data/local/tmp directly; push as shell then copy into app sandbox).
// We modified TMP_DB_PULL in place in step 2 — push that file.
console.error('[inject] pushing modified sqlite back…');
execFileSync(ADB, adbArgs(['push', TMP_DB_PULL, TMP_DB_REMOTE]), { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
execFileSync(ADB, adbArgs(['shell', 'run-as', PKG, 'cp', TMP_DB_REMOTE, DB_PATH_DEVICE_AUTH]), { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
execFileSync(ADB, adbArgs(['shell', 'run-as', PKG, 'chmod', '600', DB_PATH_DEVICE_AUTH]), { stdio: 'inherit', env: { ...process.env, MSYS_NO_PATHCONV: '1' } });

// 4. Verify by reading the row back via Python over exec-out.
const verifyBuf = execFileSync(ADB, adbArgs(['exec-out', 'run-as', PKG, 'cat', DB_PATH_DEVICE_AUTH]));
writeFileSync(TMP_DB_PUSH, verifyBuf);
const verifyPy = spawnSync('python', ['-c',
  `import sqlite3, sys
db = sys.argv[1]
conn = sqlite3.connect(db); cur = conn.cursor()
rows = cur.execute("SELECT key, length(value) FROM catalystLocalStorage WHERE key=?", (sys.argv[2],)).fetchall()
print(rows if rows else 'NO ROW')
conn.close()
`, TMP_DB_PUSH, storageKey]);
console.error('[inject] verify:', verifyPy.stdout?.toString().trim());

// 5. Force-stop + relaunch.
console.error('[inject] force-stop + relaunch…');
execFileSync(ADB, adbArgs(['shell', 'am', 'force-stop', PKG]), { stdio: 'inherit' });
execFileSync(ADB, adbArgs(['shell', 'monkey', '-p', PKG, '-c', 'android.intent.category.LAUNCHER', '1']), { stdio: 'inherit' });

console.error('[inject] done');
