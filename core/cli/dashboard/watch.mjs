// forge dashboard --watch (decisions 126 and 150): how often it looks, and whether anything the page reads has changed.
// It looks every 30 seconds and builds a new page only when something changed, so the open page reloads only then;
// the tracker is read at most every 5 minutes (its server's limits are shared with the lead), and a page is built at
// least every 5 minutes, so the times on it stay current.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../../policy/lib/context.mjs';

export const EVERY = 30000;
export const LEAST = 10000;
export const TRACKER = 5 * 60000;

// --every: 30s, 2m, or a bare number of minutes (the flag's form before decision 150). null when it is not one.
export function parseEvery(v) {
  if (v === undefined) return EVERY;
  const m = /^(\d+(?:\.\d+)?)\s*(s|sec|m|min)?$/i.exec(String(v).trim());
  if (!m) return null;
  const ms = Number(m[1]) * (/^s/i.test(m[2] || 'm') ? 1000 : 60000);
  return ms >= LEAST ? Math.round(ms) : null;
}
export const everyText = (ms) => (ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 1000)} s`);

// Each file's name, size and time of change, down a folder (no .git).
function walk(dir, out, depth = 8, skip = new Set()) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.name === '.git' || skip.has(p)) continue;
    if (e.isDirectory()) { if (depth > 0) walk(p, out, depth - 1, skip); continue; }
    try { const s = fs.statSync(p); out.push(`${p} ${s.size} ${s.mtimeMs}`); } catch { /* gone meanwhile */ }
  }
}

// What the page is built from, in one hash: the state folders (the timeline, the tracker's last read, approvals), the
// project's folder in the team repo, and the branches of every repository. The page's own files are left out.
export function inputsSignature({ repos = [], stateDirs = [], folders = [], skip = [] }) {
  const lines = [];
  for (const dir of repos) {
    lines.push(git(dir, ['rev-parse', 'HEAD']).out ?? '', git(dir, ['for-each-ref', '--format=%(objectname) %(refname)']).out ?? '');
  }
  const own = new Set(skip.map((f) => path.resolve(f)));
  for (const dir of stateDirs) walk(path.resolve(dir), lines, 1, own);
  for (const dir of folders) walk(dir, lines);
  return crypto.createHash('sha1').update(lines.join('\n')).digest('hex');
}
