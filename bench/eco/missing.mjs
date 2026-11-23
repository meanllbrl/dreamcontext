// Lists round-2 queue keys that have no ok journal row (missing or ok=false).
import { readFileSync } from 'node:fs';
const rows = readFileSync('/tmp/eco-benchmark/journal.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ok = new Set(); const bad = new Set();
for (const r of rows) { const k = r.key ?? `${r.task}/${r.mode}/${r.rep}`; (r.ok === false ? bad : ok).add(k); }
const keys = [];
for (const rep of [1, 2, 3, 4, 5, 6]) for (const t of ['t9-validate', 't10-labels', 't11-review', 't12-report-json']) for (const m of ['off', 'plus']) keys.push(`${t}/${m}/${rep}`);
for (const rep of [1, 2, 3, 4, 5, 6]) for (const t of ['t8-long', 't4-develop', 't5-plan', 't6-super', 't2-feature', 't3-debug', 't1-fix', 't7-memory']) for (const m of ['off', 'plus']) keys.push(`${t}/${m}/${rep}`);
const missing = keys.filter((k) => !ok.has(k));
if (process.argv.includes("--keys")) { for (const k of missing) console.log(k); process.exit(0); }
console.log(JSON.stringify({ total: keys.length, ok: keys.length - missing.length, badRows: [...bad], missing }, null, 1));
