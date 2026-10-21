// The tracker's issues over time (decision 122): each issue's status label and open/closed state through its life,
// from GitLab's resource events or GitHub's issue events. Kept in .forge/state/issues.json, so a later run fetches
// only the issues that changed, and the page still draws from the last read when the tracker cannot be reached.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Bottom to top on the chart.
export const BANDS = [['closed', 'Closed'], ['testing', 'In Testing'], ['progress', 'In progress'], ['open', 'Open']];
const STATUS = /^status::?(.+)$/i;
const PER_PAGE = 100;
const AT_ONCE = 8;

function api(cli, endpoint, cwd, env) {
  return new Promise((resolve, reject) => {
    const p = spawn(cli, ['api', endpoint], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill(), 30000);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(new Error(e.code === 'ENOENT' ? `${cli} is not installed` : `${cli}: ${e.code}`)); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`${cli} api ${endpoint.split('?')[0]}: ${((err || out).trim().split('\n').pop() || `exit ${code}`).slice(0, 200)}`));
      try { resolve(JSON.parse(out || 'null')); } catch { reject(new Error(`${cli} api ${endpoint.split('?')[0]}: not JSON`)); }
    });
  });
}

async function pages(cli, endpoint, cwd, env) {
  const out = [];
  for (let page = 1; page <= 50; page++) {
    const batch = await api(cli, `${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=${PER_PAGE}&page=${page}`, cwd, env);
    if (!Array.isArray(batch)) break;
    out.push(...batch);
    if (batch.length < PER_PAGE) break;
  }
  return out;
}

// fn over every item, AT_ONCE at a time; the first failure fails it all.
async function each(items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, async () => {
    while (next < items.length) { const k = next++; out[k] = await fn(items[k]); }
  }));
  return out;
}

// Per host: the issues (id, title, labels, closed, created, updated) and one issue's events, oldest first:
// { at, label, add } for a label added or removed, { at, closed } for a close or a reopen.
// board: a system's board project ("group/board", decision 131) in place of the checkout's own repository.
const HOSTS = {
  gitlab: {
    name: 'GitLab',
    list: async (cwd, env, board) => (await pages('glab', `projects/${board ? encodeURIComponent(board) : ':id'}/issues?state=all`, cwd, env))
      .map((i) => ({ id: i.iid, title: i.title, labels: i.labels || [], closed: i.state === 'closed', created: i.created_at, updated: i.updated_at, url: i.web_url })),
    events: async (id, cwd, env, board) => [
      ...(await pages('glab', `projects/${board ? encodeURIComponent(board) : ':id'}/issues/${id}/resource_label_events`, cwd, env)).map((e) => ({ at: e.created_at, label: e.label?.name ?? '', add: e.action === 'add' })),
      ...(await pages('glab', `projects/${board ? encodeURIComponent(board) : ':id'}/issues/${id}/resource_state_events`, cwd, env)).filter((e) => ['closed', 'reopened'].includes(e.state)).map((e) => ({ at: e.created_at, closed: e.state === 'closed' })),
    ],
  },
  github: {
    name: 'GitHub',
    list: async (cwd, env, board) => (await pages('gh', `repos/${board || '{owner}/{repo}'}/issues?state=all`, cwd, env)).filter((i) => !i.pull_request)
      .map((i) => ({ id: i.number, title: i.title, labels: (i.labels || []).map((l) => l.name), closed: i.state === 'closed', created: i.created_at, updated: i.updated_at, url: i.html_url })),
    events: async (id, cwd, env, board) => (await pages('gh', `repos/${board || '{owner}/{repo}'}/issues/${id}/events`, cwd, env)).flatMap((e) => (
      ['labeled', 'unlabeled'].includes(e.event) ? [{ at: e.created_at, label: e.label?.name ?? '', add: e.event === 'labeled' }]
        : ['closed', 'reopened'].includes(e.event) ? [{ at: e.created_at, closed: e.event === 'closed' }] : [])),
  },
};

// The issues with their status events: fetched (only those changed since the last read) unless offline, or the
// last read with the reason it could not be refreshed. { host, readAt, issues, error }.
export async function readIssues({ main, stateDir, tracker, board = '', env = process.env, offline = false, now = Date.now() }) {
  const file = path.join(stateDir, 'issues.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first read */ }
  const host = HOSTS[tracker];
  const last = (error) => ({ host: host?.name ?? tracker, readAt: cache.readAt ? Date.parse(cache.readAt) : null, issues: Object.values(cache.tracker === tracker ? cache.issues || {} : {}), error });
  if (!host) return last(`the tracker "${tracker}" has no issue history here`);
  if (offline) return last(null);
  try {
    const before = cache.tracker === tracker ? cache.issues || {} : {};
    const list = await host.list(main, env, board);
    const fetched = await each(list, async (i) => {
      const was = before[i.id];
      return was && was.updated === i.updated ? was.events : (await host.events(i.id, main, env, board)).filter((e) => e.label === undefined || STATUS.test(e.label));
    });
    const issues = Object.fromEntries(list.map((i, k) => [i.id, { ...i, events: fetched[k] }]));
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ tracker, readAt: new Date(now).toISOString(), issues }));
    return { host: host.name, readAt: now, issues: Object.values(issues), error: null };
  } catch (e) {
    return last(e.message);
  }
}

const statusOf = (labels) => [...labels].map((l) => STATUS.exec(l)?.[1]).find(Boolean) ?? null;
// A done status counts as closed even before the issue is (the tracker sets the label, then closes it).
export function band(closed, status) {
  const s = String(status ?? '').trim().toLowerCase();
  if (closed || ['done', 'closed', 'resolved'].includes(s)) return 'closed';
  return s === 'in testing' ? 'testing' : s === 'in progress' ? 'progress' : 'open';
}
export const isEpic = (i) => i.labels.some((l) => /^type::?epic$/i.test(l)) || /^\[epic\]/i.test(i.title || '');

// An issue's status as the board spells it ("Todo", "In Progress", "Done"); Closed for a closed issue whose label
// says otherwise; null for an open issue without a status label.
export function boardStatus(i) {
  const s = statusOf(i.labels);
  return i.closed && band(false, s) !== 'closed' ? 'Closed' : s;
}

// What the board says of a ticket (decision 135): its title, areas and repository from its labels, and its status.
export function fromBoard(i) {
  const label = (re) => i.labels.map((l) => re.exec(l)?.[1]).filter(Boolean);
  return { title: i.title || '', areas: label(/^area::?(.+)$/i).map((a) => a.toLowerCase()), repo: label(/^repo::?(.+)$/i)[0] ?? null, status: boardStatus(i), closed: Boolean(i.closed) };
}

// An issue no record of the project names yet (filed since the bootstrap and not picked: a follow-up, a bug) as a
// row of the dashboard's ticket table: what the board says, nothing measured.
export function issueTicket(i) {
  const b = fromBoard(i);
  const num = Number(i.id);
  return {
    num, id: `#${num}`, t: null, title: b.title, epic: null, stories: [], areas: b.areas, gates: null, planned: false, status: null, estimate: null,
    actual: null, mergedAt: null, repo: b.repo, rounds: [], lines: [], from: null, to: null, split: null, tokens: null, rework: null, board: { status: b.status, closed: b.closed },
  };
}

// One issue's band from its creation on: [{ at, band }], a point at each change. The state at creation is found by
// undoing every event from today's labels and state, so labels set before events were recorded still count.
export function issueBands(i) {
  const labels = new Set(i.labels.filter((l) => STATUS.test(l)));
  let closed = i.closed;
  const events = [...i.events].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  for (const e of [...events].reverse()) {
    if (e.label !== undefined) { if (e.add) labels.delete(e.label); else labels.add(e.label); } else closed = !e.closed;
  }
  const created = Date.parse(i.created);
  const out = [{ at: created, band: band(closed, statusOf(labels)) }];
  // Events at the same moment (a label removed and another added in one update) count as one change.
  for (let k = 0; k < events.length;) {
    const at = Date.parse(events[k].at);
    for (; k < events.length && Date.parse(events[k].at) === at; k++) {
      const e = events[k];
      if (e.label !== undefined) { if (e.add) labels.add(e.label); else labels.delete(e.label); } else closed = e.closed;
    }
    const b = band(closed, statusOf(labels));
    if (b !== out.at(-1).band) out.push({ at: Math.max(at, created), band: b });
  }
  return out;
}

// How many issues sat in each band, after each change: { points: [{ at, n: { band: count } }], now, total, epics }.
// Epics are left out: they stay open while their tickets close.
export function issueFlow(issues) {
  const counted = issues.filter((i) => !isEpic(i));
  const deltas = [];
  for (const i of counted) {
    const bands = issueBands(i);
    bands.forEach((c, k) => {
      deltas.push({ at: c.at, band: c.band, d: 1 });
      if (k) deltas.push({ at: c.at, band: bands[k - 1].band, d: -1 });
    });
  }
  deltas.sort((a, b) => a.at - b.at);
  const n = Object.fromEntries(BANDS.map(([k]) => [k, 0]));
  const points = [];
  for (const x of deltas) {
    n[x.band] += x.d;
    if (points.at(-1)?.at === x.at) points.at(-1).n = { ...n };
    else points.push({ at: x.at, n: { ...n } });
  }
  return { points, now: { ...n }, total: counted.length, epics: issues.length - counted.length };
}

// A ticket's page on the tracker: the address the tracker gave for it, else one made from the repository's remote
// (git@host:group/app.git or https://host/group/app.git → https://host/group/app/-/issues/12 on GitLab,
// https://host/group/app/issues/12 on GitHub). null when neither is known.
export function issueLinks({ issues = [], remote = '', tracker = 'gitlab' }) {
  const known = new Map(issues.filter((i) => i.url).map((i) => [Number(i.id), i.url]));
  const m = /^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)(?::\d+)?[:/](.+?)(?:\.git)?\/?$/.exec(String(remote).trim());
  const base = m && !/^\//.test(m[2]) ? `https://${m[1]}/${m[2]}` : null;
  // OpenProject's work packages are not under the repository's remote: only the address it gave is known.
  return (num) => known.get(Number(num)) ?? (base && tracker !== 'openproject' ? `${base}${tracker === 'github' ? '' : '/-'}/issues/${num}` : null);
}

// "3 open, 0 in progress, 0 in testing, 22 closed", top band first.
export const countsText = (n) => [...BANDS].reverse().map(([k, l]) => `${n[k]} ${l.toLowerCase()}`).join(', ');
