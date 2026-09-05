// ─────────────────────────────────────────────────────────────────────────
// harness.mjs — minimal zero-dependency test runner.
// Usage:
//   suite('02 anon access');
//   await t('anon cannot read orders', async () => { expect(...); });
//   finding('Medium', 'title', 'detail');
// Suites share `inventory` for cross-suite data (fixture uids, created ids).
// ─────────────────────────────────────────────────────────────────────────

const state = {
  current: '',
  tests: [],
  findings: [],
  inventory: {}, // shared: { tables: [], rpcs: [], uid: {}, orderId, ... }
};

export function suite(name) {
  state.current = name;
  console.log('\n== ' + name + ' ==');
}

export function expect(cond, msg) {
  if (!cond) throw new Error(msg ?? 'expectation failed');
}

/** Run one async test; never throws. A returned string becomes its note. */
export async function t(name, fn) {
  const rec = { suite: state.current, name, status: 'PASS', note: '' };
  try {
    const note = await fn();
    if (typeof note === 'string' && note) rec.note = note;
    console.log('  ok   ' + name + (rec.note ? '   [' + rec.note + '] ' : ''));
  } catch (e) {
    rec.status = 'FAIL';
    rec.note = String(e?.message ?? e).slice(0, 300);
    console.log('  FAIL ' + name + '   — ' + rec.note);
  }
  state.tests.push(rec);
  return rec;
}

/** Record a security finding (deduped by title). */
export function finding(severity, title, detail) {
  if (state.findings.some((f) => f.title === title)) return;
  state.findings.push({ severity, title, detail: String(detail).slice(0, 500), suite: state.current });
  console.log('  >>> [' + severity + '] ' + title);
}

export function getState() {
  return state;
}
