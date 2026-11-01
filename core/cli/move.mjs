// forge export / forge import (decision 151): a project's work moves to another machine. Everything else already
// travels by git (the app's branches, the team repo's plans and reports); these carry what lives only in this checkout:
// .forge/handoffs (the lead's handover, which /resume continues from) and .forge/state (the timeline behind the
// dashboard, the gates approved per branch, each ticket's lanes for its limits, the tracker's last read), with no key
// and no .env. Export checks the work is paused, saved and pushed, writes one file and marks this checkout as moved, so
// its lead starts nothing; import, in a fresh clone on the other machine, links it (forge init) and puts them back.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { git } from '../policy/lib/context.mjs';

export class MoveError extends Error {}

const FORMAT = 1;
// This machine's own files in .forge/state: the page and its stamp, what forge sync wrote here (forge init writes them
// again on the other machine), the model server and pacing this machine chose, and the moved mark itself.
const MACHINE = new Set(['dashboard.html', 'dashboard.csv', 'dashboard.stamp.js', 'settings-managed.json', 'sync-manifest.json', 'roles.json', 'pacing.json', 'llm.json', 'exported.json']);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const pad = (n) => String(n).padStart(2, '0');
const stampOf = (t) => { const d = new Date(t); return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`; };
// A remote without its user or token; git@host:group/app.git and https://host/group/app compare as host/group/app.
const bare = (url) => String(url || '').replace(/\/\/[^@/]+@/, '//');
const where = (url) => bare(url).replace(/^[a-z+]+:\/\//i, '').replace(/^[^@/]+@([^:/]+):/, '$1/').replace(/\.git$/, '').replace(/\/+$/, '').toLowerCase();
const count = (dir) => { let n = 0; for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? count(path.join(dir, e.name)) : 1; return n; };
// Only folders and plain files come in from an export: no link that could point outside the checkout.
const plain = (src) => { const s = fs.lstatSync(src); return s.isDirectory() || s.isFile(); };

function tar(args) {
  const r = spawnSync('tar', args, { encoding: 'utf8' });
  if (r.status !== 0) throw new MoveError(`tar ${args[0]} failed: ${(r.stderr || r.error?.message || '').trim().split('\n').pop()}`);
}

// What would be lost or left behind by moving now, each with the step that fixes it.
function problems({ main, folder, settled }) {
  const out = [];
  if (!settled.ok) out.push(`Agents are still at work or left work unfinished: run /pause in the lead's session, until "Safe to close".\n${settled.lines.map((l) => `    ${l}`).join('\n')}`);
  if (!fs.existsSync(path.join(main, '.forge', 'handoffs', 'lead-handover.md'))) out.push('No lead handover to continue from: /pause in the lead\'s session writes .forge/handoffs/lead-handover.md.');
  const team = git(folder, ['rev-parse', '--show-toplevel']).out;
  const rel = path.relative(team, folder) || '.';
  const unsaved = git(team, ['status', '--porcelain', '--', rel]).out;
  if (unsaved) out.push(`The team repo has changes not saved: forge save (${unsaved.split('\n').length} file${unsaved.split('\n').length === 1 ? '' : 's'}).`);
  else if (!git(team, ['rev-parse', '--abbrev-ref', '@{u}']).ok) out.push(`The team repo's branch has no remote to push to: git -C ${team} push -u origin HEAD.`);
  else if (Number(git(team, ['rev-list', '--count', '@{u}..HEAD']).out) > 0) out.push(`The team repo has commits not pushed: git -C ${team} push.`);
  const changed = git(main, ['status', '--porcelain']).out;
  if (changed) out.push(`This checkout has changes not committed (${changed.split('\n').length}): commit and push them, or they stay on this machine.`);
  for (const b of git(main, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']).out.split('\n').filter(Boolean)) {
    const n = Number(git(main, ['rev-list', '--count', b, '--not', '--remotes']).out);
    if (n > 0) out.push(`Branch ${b} has ${n} commit${n === 1 ? '' : 's'} on no remote: git push -u origin ${b} (or delete the branch if it is not needed).`);
  }
  return out;
}

// forge export [--out <file>] [--force]. settled: forge worktrees' answer ({ ok, lines }); server: the model server
// this checkout runs on, from the machine's settings ({ name, url, models, context } or null).
export function exportProject(o, { main, folder, env, out, settled, server = null, kitRepo = null, now = Date.now }) {
  const slug = path.basename(folder);
  const found = problems({ main, folder, settled });
  // --check: whether it is ready, and what would go, with nothing written.
  if (o.check === true) {
    const state = path.join(main, '.forge', 'state');
    const handoffs = path.join(main, '.forge', 'handoffs');
    const n = (fs.existsSync(state) ? fs.readdirSync(state).filter((e) => !MACHINE.has(e)).reduce((x, e) => x + (fs.statSync(path.join(state, e)).isDirectory() ? count(path.join(state, e)) : 1), 0) : 0);
    out(`${found.length ? `Not ready to move ${slug}:\n${found.map((p) => `- ${p}`).join('\n')}` : `Ready to move ${slug}.`}\nforge export would carry ${fs.existsSync(handoffs) ? count(handoffs) : 0} handover files and ${n} state files${server ? `, and name the model server ${server.name} (not its key)` : ''}.`);
    return found.length ? 1 : 0;
  }
  if (found.length && o.force !== true) throw new MoveError(`Not ready to move ${slug}:\n${found.map((p) => `- ${p}`).join('\n')}\nThen run forge export again (--force exports anyway, leaving those behind).`);
  const at = now();
  const file = typeof o.out === 'string' ? path.resolve(o.out) : path.join(env.HOME || os.homedir(), `${slug}-forge-${stampOf(at)}.tgz`);
  const team = git(folder, ['rev-parse', '--show-toplevel']).out;
  const manifest = {
    format: FORMAT,
    project: slug,
    kit: fs.existsSync(path.join(main, '.forge', 'kit', 'VERSION')) ? fs.readFileSync(path.join(main, '.forge', 'kit', 'VERSION'), 'utf8').trim() : null,
    exportedAt: new Date(at).toISOString(),
    app: bare(git(main, ['remote', 'get-url', 'origin']).out) || null,
    team: bare(git(team, ['remote', 'get-url', 'origin']).out) || null,
    kitRepo,
    llm: server,
    left: o.force === true ? found : [],
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-export-'));
  try {
    const root = path.join(tmp, slug);
    fs.mkdirSync(root);
    const handoffs = path.join(main, '.forge', 'handoffs');
    const state = path.join(main, '.forge', 'state');
    if (fs.existsSync(handoffs)) fs.cpSync(handoffs, path.join(root, 'handoffs'), { recursive: true, filter: plain });
    fs.mkdirSync(path.join(root, 'state'), { recursive: true });
    if (fs.existsSync(state)) for (const e of fs.readdirSync(state)) if (!MACHINE.has(e)) fs.cpSync(path.join(state, e), path.join(root, 'state', e), { recursive: true, filter: plain });
    fs.writeFileSync(path.join(root, 'forge-export.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    tar(['-czf', file, '-C', tmp, slug]);
    const n = { handoffs: fs.existsSync(path.join(root, 'handoffs')) ? count(path.join(root, 'handoffs')) : 0, state: count(path.join(root, 'state')) };
    // This checkout is moved: its lead starts nothing here until forge import brings the project back.
    fs.writeFileSync(path.join(state, 'exported.json'), `${JSON.stringify({ at: manifest.exportedAt, file }, null, 2)}\n`);
    const mb = (fs.statSync(file).size / 1048576).toFixed(1);
    out(`exported ${slug}: ${file} (${mb} MB: ${n.handoffs} handover files, ${n.state} state files; no key, no .env)${found.length ? `\nleft behind (--force):\n${found.map((p) => `- ${p.split('\n')[0]}`).join('\n')}` : ''}`);
    out(`This checkout is marked as moved: its lead starts nothing here. Don't run the project on two machines at once.`);
    out(['On the other machine, in this order:',
      `  1. scp "${file}" <machine>:~`,
      `  2. git clone ${manifest.team ?? '<the team repo>'} ~/code/se-forge-projects`,
      `     forge setup --team-repo ~/code/se-forge-projects${kitRepo ? ` --kit-repo ${kitRepo}` : ''}`,
      `  3. git clone ${manifest.app ?? '<the app repo>'} ~/code/${slug} && cd ~/code/${slug}`,
      `  4. forge import ~/${path.basename(file)}`].join('\n'));
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// forge import <file> [--force], in a clone of the app on the other machine. init: forge init for this checkout;
// teamRepo: this machine's team repo (it throws when none is set up); machine: this machine's settings.
export async function importProject(o, { main, env, out, init, teamRepo, machine = {} }) {
  const file = o._[0] ? path.resolve(String(o._[0])) : '';
  if (!file || !fs.existsSync(file)) throw new MoveError(`forge import <file from forge export>${file ? `: ${file} does not exist` : ''}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-import-'));
  try {
    tar(['-xzf', file, '-C', tmp]);
    const top = fs.readdirSync(tmp).filter((d) => fs.existsSync(path.join(tmp, d, 'forge-export.json')));
    if (top.length !== 1) throw new MoveError(`${file} is not a forge export (no forge-export.json in it).`);
    const root = path.join(tmp, top[0]);
    const m = readJson(path.join(root, 'forge-export.json'), {});
    if (m.format !== FORMAT || !/^[a-z0-9][a-z0-9._-]*$/.test(m.project || '')) throw new MoveError(`${file} is a forge export this forge cannot read (format ${m.format ?? 'unknown'}); install the forge that exported it.`);
    const slug = m.project;
    const origin = git(main, ['remote', 'get-url', 'origin']).out;
    if (m.app && where(origin) !== where(m.app) && o.force !== true) throw new MoveError(`This checkout's origin is ${bare(origin) || 'not set'}, but ${slug} was exported from a clone of ${m.app}. Run forge import in a clone of it: git clone ${m.app} (--force imports here anyway).`);
    let team;
    try { team = teamRepo(); } catch { throw new MoveError(`No team repo on this machine yet. First:\n  git clone ${m.team ?? '<the team repo>'} ~/code/se-forge-projects\n  forge setup --team-repo ~/code/se-forge-projects${m.kitRepo ? ` --kit-repo ${m.kitRepo}` : ''}\nthen forge import again.`); }
    if (m.team && where(git(team, ['remote', 'get-url', 'origin']).out) !== where(m.team) && o.force !== true) throw new MoveError(`This machine's team repo (${team}) is not ${m.team}, where ${slug}'s plans are: forge setup --team-repo <your clone of ${m.team}> (--force imports anyway).`);
    if (!fs.existsSync(path.join(team, slug, 'project.json'))) throw new MoveError(`The team repo (${team}) has no ${slug} yet: git -C ${team} pull, then forge import again.`);
    git(team, ['fetch', '-q'], 60000);
    if (Number(git(team, ['rev-list', '--count', 'HEAD..@{u}']).out) > 0) throw new MoveError(`The team repo is behind its remote: git -C ${team} pull, then forge import again.`);
    // A checkout with history of its own keeps it, unless it is the one this project was exported from.
    const state = path.join(main, '.forge', 'state');
    const own = fs.existsSync(state) && fs.readdirSync(state).some((f) => /^timeline-.*\.jsonl$/.test(f));
    const movedFrom = fs.existsSync(path.join(state, 'exported.json'));
    if (own && !movedFrom && o.force !== true) throw new MoveError(`This checkout already has a history of its own (.forge/state/timeline-*.jsonl). forge import --force replaces it with ${slug}'s.`);
    const link = path.join(main, '.forge', 'project');
    if (!fs.existsSync(path.join(link, 'project.json')) || fs.realpathSync(link) !== fs.realpathSync(path.join(team, slug))) await init({ project: slug, force: o.force });
    for (const part of ['handoffs', 'state']) if (fs.existsSync(path.join(root, part))) fs.cpSync(path.join(root, part), path.join(main, '.forge', part), { recursive: true, force: true, filter: plain });
    fs.rmSync(path.join(state, 'exported.json'), { force: true });
    out(`imported ${slug}, exported ${m.exportedAt?.slice(0, 16).replace('T', ' ')} UTC: ${fs.existsSync(path.join(root, 'handoffs')) ? count(path.join(root, 'handoffs')) : 0} handover files and ${count(path.join(root, 'state'))} state files.${m.left?.length ? `\nLeft behind on the other machine (it was exported with --force):\n${m.left.map((p) => `- ${p.split('\n')[0]}`).join('\n')}` : ''}`);
    // The rest is a person's: a key, the app's .env, and where the lead runs.
    const steps = [];
    const s = m.llm;
    if (s?.name) {
      const known = machine.llm?.[s.name];
      const models = s.models || {};
      const one = new Set(Object.values(models)).size === 1;
      if (!known) {
        steps.push(`copy the key of the model server ${s.name} from the other machine (it is never exported) to ~/.config/se-forge/llm-${s.name}-key, then chmod 600 it`);
        steps.push(`forge llm add ${s.name} --url ${s.url}${one ? ` --model ${models.opus}` : ` --opus ${models.opus} --sonnet ${models.sonnet} --haiku ${models.haiku}`}${s.context ? ` --context ${s.context}` : ''}`);
      }
      steps.push(`forge llm use ${s.name}   (${slug} ran on it, not on Claude)`);
    }
    steps.push('copy the app\'s .env files from the other machine, if it has any (they are never exported)');
    steps.push('forge doctor');
    steps.push(`tmux new -s ${slug}, then claude, then /resume   (tmux keeps the lead running when you disconnect)`);
    out(`Your turn, in this order:\n${steps.map((x, i) => `  ${i + 1}. ${x}`).join('\n')}`);
    return 0;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
