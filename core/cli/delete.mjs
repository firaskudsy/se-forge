// forge delete <slug> (decision 152): a project leaves the team repo. Its folder goes in one commit, which is pushed;
// git history keeps it, and the command prints the line that brings it back. Run inside the project's checkout, it also
// unlinks it: the kit's files there go (.forge/, the .claude files forge sync wrote, the kit's entries in
// .claude/settings.local.json, its git hooks and exclude lines); the app's code, branches and .env stay. It never
// touches the app's repository on its host or its tracker. Without --confirm <slug> it only says what would go.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { git } from '../policy/lib/context.mjs';

export class DeleteError extends Error {}

const SLUG = /^[a-z0-9][a-z0-9._-]*$/;
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const lines = (s) => String(s || '').split('\n').filter(Boolean);

// The project a checkout's .forge/project link names, even when its folder is already gone.
export function linkTarget(main) {
  const link = path.join(main, '.forge', 'project');
  try { return path.resolve(path.dirname(link), fs.readlinkSync(link)); } catch { return null; }
}

// What stops the delete now, each with the step that fixes it.
function problems({ team, slug, here, settled, force }) {
  const out = [];
  git(team, ['fetch', '-q'], 60000);
  if (!git(team, ['rev-parse', '--abbrev-ref', '@{u}']).ok) out.push(`The team repo's branch has no upstream, so the delete cannot be pushed: git -C ${team} push -u origin HEAD, then run this again.`);
  else if (Number(git(team, ['rev-list', '--count', 'HEAD..@{u}']).out) > 0) out.push(`The team repo is behind its remote: git -C ${team} pull --rebase, then run this again.`);
  const unsaved = lines(git(team, ['status', '--porcelain', '--', slug]).out);
  if (unsaved.length && !force) out.push(`${unsaved.length} change${unsaved.length === 1 ? '' : 's'} in ${slug}/ ${unsaved.length === 1 ? 'is' : 'are'} not saved, so git history will not have ${unsaved.length === 1 ? 'it' : 'them'} either: forge save first, or add --force to lose ${unsaved.length === 1 ? 'it' : 'them'}.`);
  if (here && !settled.ok) out.push(`Agents are still at work in this checkout or left work unfinished: /pause in the lead's session until "Safe to close", then close it.\n${settled.lines.map((l) => `    ${l}`).join('\n')}`);
  else if (here && fs.existsSync(path.join(here, '.claude', 'worktrees')) && fs.readdirSync(path.join(here, '.claude', 'worktrees'), { withFileTypes: true }).some((e) => e.isDirectory())) {
    out.push('Agents\' worktrees are still in .claude/worktrees: forge worktrees --clean removes the done ones.');
  }
  return out;
}

// Undoes forge init and forge sync in a checkout. Files forge wrote and someone edited since stay, and are named.
function unlink(main, marks) {
  const state = path.join(main, '.forge', 'state');
  const claude = path.join(main, '.claude');
  const left = [];
  let removed = 0;
  for (const [rel, hash] of Object.entries(readJson(path.join(state, 'sync-manifest.json'), { files: {} }).files)) {
    const abs = path.join(main, rel);
    if (!fs.existsSync(abs)) continue;
    if (sha(fs.readFileSync(abs, 'utf8')) !== hash) { left.push(rel); continue; }
    fs.rmSync(abs);
    removed++;
    for (let d = path.dirname(abs); d.startsWith(claude) && d !== claude; d = path.dirname(d)) {
      if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d); else break;
    }
  }
  // The kit's entries in the local settings, as settings-managed.json recorded them; the developer's own stay.
  const file = path.join(claude, 'settings.local.json');
  if (fs.existsSync(file)) {
    const s = readJson(file, {});
    const managed = readJson(path.join(state, 'settings-managed.json'), {});
    for (const level of ['allow', 'ask', 'deny']) {
      if (!s.permissions?.[level]) continue;
      s.permissions[level] = s.permissions[level].filter((r) => !(managed[level] || []).includes(r));
      if (!s.permissions[level].length) delete s.permissions[level];
    }
    if (s.permissions?.additionalDirectories) {
      s.permissions.additionalDirectories = s.permissions.additionalDirectories.filter((d) => !(managed.additionalDirectories || []).includes(d));
      if (!s.permissions.additionalDirectories.length) delete s.permissions.additionalDirectories;
    }
    if (s.permissions && !Object.keys(s.permissions).length) delete s.permissions;
    for (const [event, groups] of Object.entries(s.hooks || {})) {
      s.hooks[event] = groups.filter((g) => !(g.hooks || []).some((h) => String(h.command).includes(marks.hook)));
      if (!s.hooks[event].length) delete s.hooks[event];
    }
    if (s.hooks && !Object.keys(s.hooks).length) delete s.hooks;
    delete s.disableClaudeAiConnectors;
    delete s.autoCompactWindow;
    if (managed.attribution && s.attribution) { delete s.attribution.commit; delete s.attribution.pr; if (!Object.keys(s.attribution).length) delete s.attribution; }
    if (String(s.statusLine?.command || '').includes(marks.statusLine)) delete s.statusLine;
    for (const k of managed.env || []) delete s.env?.[k];
    if (s.env && !Object.keys(s.env).length) delete s.env;
    if (managed.apiKeyHelper && s.apiKeyHelper === managed.apiKeyHelper) delete s.apiKeyHelper;
    if (Object.keys(s).some((k) => k !== '$schema')) fs.writeFileSync(file, `${JSON.stringify(s, null, 2)}\n`);
    else { fs.rmSync(file); removed++; }
  }
  for (const d of [path.join(claude, 'worktrees'), claude]) if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d);
  // The kit's git hooks: the hooks path the project had before comes back.
  if (git(main, ['config', '--local', '--get', 'core.hooksPath']).out.includes('.forge/kit/core/githooks')) {
    const before = git(main, ['config', '--local', '--get', 'se-forge.previousHooksPath']).out;
    git(main, before ? ['config', '--local', 'core.hooksPath', before] : ['config', '--local', '--unset', 'core.hooksPath']);
  }
  git(main, ['config', '--local', '--unset', 'se-forge.previousHooksPath']);
  const exclude = path.join(main, '.git', 'info', 'exclude');
  if (fs.existsSync(exclude)) {
    const all = fs.readFileSync(exclude, 'utf8').split('\n');
    const [start, end] = [all.indexOf(marks.block[0]), all.indexOf(marks.block[1])];
    if (start >= 0 && end > start) fs.writeFileSync(exclude, [...all.slice(0, start), ...all.slice(end + 1)].join('\n'));
  }
  fs.rmSync(path.join(main, '.forge'), { recursive: true, force: true });
  return { removed, left };
}

// o: { _: [slug], confirm, force }. main: the main checkout forge runs in, or null; team: the team repo; settled: the
// checkout's worktrees ({ ok, lines }); marks: what forge sync writes ({ block, hook, statusLine }).
export function deleteProject(o, { main, team, settled = { ok: true, lines: [] }, marks, out }) {
  const slug = o._[0];
  if (!slug || !SLUG.test(slug)) throw new DeleteError('forge delete <slug> [--confirm <slug>] [--force] [--team-repo <path>]: the project\'s folder name in the team repo.');
  const folder = path.join(team, slug);
  const here = main && linkTarget(main) === path.resolve(folder) ? main : null;
  const exists = fs.existsSync(folder);
  if (!exists && !here) throw new DeleteError(`No project "${slug}" in the team repo (${team}).`);
  if (fs.existsSync(path.join(folder, 'system.json'))) throw new DeleteError(`${slug} is a system (decision 130): forge delete removes one app's project; a system's member checkouts are not supported yet.`);
  const tracked = exists ? lines(git(team, ['ls-files', '--', slug]).out).length : 0;
  const generated = here ? Object.keys(readJson(path.join(here, '.forge', 'state', 'sync-manifest.json'), { files: {} }).files).length : 0;

  out(`forge delete ${slug} ${o.confirm === slug ? 'will' : 'would'}:`);
  if (exists) out(`  - remove ${slug}/ from the team repo ${team} (${tracked} file${tracked === 1 ? '' : 's'} in git) in one commit, and push it`);
  else out(`  - (${slug}/ is already gone from the team repo ${team})`);
  if (here) out(`  - unlink this checkout (${here}): .forge/ (its handovers and its history: the timeline behind the dashboard, the gates approved, which live only on this machine), the ${generated} .claude files forge wrote, the kit's entries in .claude/settings.local.json, its git hooks and exclude lines. The app's code, branches and .env stay.`);
  out('  It never touches the app\'s repository on its host or its tracker issues.');
  if (!here) out(`  A checkout linked to ${slug} keeps its link: after a pull of the team repo, run forge delete ${slug} in it to unlink it.`);

  const found = problems({ team, slug, here, settled, force: o.force === true });
  if (found.length) { out(`\nNot yet:\n${found.map((p) => `  - ${p}`).join('\n')}`); return 1; }
  if (o.confirm !== slug) {
    if (o.confirm !== undefined) throw new DeleteError(`--confirm must be the project's name: --confirm ${slug}`);
    out(`\nTo delete it, type its name: forge delete ${slug} --confirm ${slug}`);
    return 0;
  }

  if (here) {
    const { removed, left } = unlink(here, marks);
    out(`unlinked ${here}: removed .forge/ and ${removed} file${removed === 1 ? '' : 's'} forge wrote${left.length ? `; left, edited since forge wrote them: ${left.join(', ')}` : ''}`);
  }
  if (!exists) return 0;
  if (!tracked) { fs.rmSync(folder, { recursive: true, force: true }); out(`removed ${folder} (it was never saved, so there is no commit)`); return 0; }
  git(team, ['rm', '-r', '-q', '--', slug]);
  fs.rmSync(folder, { recursive: true, force: true });
  const c = git(team, ['commit', '-q', '-m', `${slug}: delete the project (forge delete)`, '--', slug]);
  if (!c.ok) throw new DeleteError(`commit failed: ${c.err}`);
  const commit = git(team, ['rev-parse', '--short', 'HEAD']).out;
  const p = git(team, ['push', '-q'], 60000);
  out(p.ok ? `deleted ${slug} from the team repo and pushed (commit ${commit})` : `deleted ${slug} in the team repo (commit ${commit}), but the push failed: ${p.err.split('\n')[0]}. Push the team repo when you can.`);
  out(`To bring it back: git -C ${team} revert --no-edit ${commit} && git -C ${team} push${here ? `, then forge init --project ${slug} in ${here}` : ''}`);
  return 0;
}
