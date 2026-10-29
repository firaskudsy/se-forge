#!/usr/bin/env node
// forge: puts the se-forge kit into a client checkout, without committing anything to it.
//   forge setup --team-repo <path> [--kit-repo <git url>] [--pacing on|off]
//                                         this machine's team repo clone; where kit versions come from; pacing
//   forge init --project <slug> [--new] [--client <name>] [--host gitlab|github] [--tracker gitlab|github|openproject] [--force]
//                                         also creates the dev and staging branches from main when missing (never pushed)
//   forge sync [--force]                  write the project's pinned kit version and its overrides into this checkout
//   forge upgrade --to <version>          pin the project to another kit version and sync
//   forge doctor                          health check (exit 1 on any failure)
//   forge save [-m <message>]             commit and push this project's folder in the team repo
//   forge gates                           the "done" check on the current branch
//   forge merge <ticket> [--branch <b>]    the lead merges a ticket into dev: gates, tests, reviews and contract checked
//   forge tracker <command> [args]        the project's tracker (see the tracker skill)
//   forge handover <name> [--from-tree] [worktree]
//   forge api check|fetch|generate        the API contract: lint + breaking changes + version rule; pinned spec; client
//   forge config check <file>             validate a project.json (or a proposal) before it is applied
//   forge design sample <image> [--at "x,y x,y"] [--region x,y,w,h] [--top N]   exact colours of a provided screen
//   forge docs check <file|folder> ...   decision records are MADR, Mermaid diagrams render (Docker)
//   forge new [--backend <b> --db <d>] [--frontend react] [--mobile flutter --app-id <id>] [--title <t>] [--host gitlab|github]   the starter skeleton
//   forge metrics <ticket> [--branch <b>] [--record]   the tokens a ticket used, from the local session logs
//   forge timeline [<ticket>] [--days <n>] [--json | --csv]   where the time went: waits for you, agents, gates,
//                                         refusals and failures, from the hooks' log (.forge/state/timeline-*.jsonl)
//   forge timeline import                 the history before the hooks' log, from Claude Code's session logs
//   forge dashboard [--days <n>] [--ticket 11,12] [--out <file>] [--no-open] [--offline] [--watch [--every <min>]]   charts in tabs and a ticket table
//                                         in one local page (.forge/state/dashboard.html), with a CSV next to it;
//                                         --text prints its numbers instead and writes nothing (the lead's report)
//   forge shot <image> "<what>" [--ticket <n>]   keep a picture of the app for the dashboard (team repo, shots/)
//   forge shot --playwright <report.json> [--ticket <n>]   the last screen of each passed test in a Playwright report
//   forge shot --dir <folder> [--ticket <n>]   each picture in a folder with its record (Flutter: build/forge-shots)
//   forge shot                            the project's pictures
//   forge app [up [--fresh] [--no-open] | down]   the app on this Mac from its Compose file: what runs and where to
//                                         open it; up builds, starts, waits until healthy and opens it; down stops it
//   forge limits [lift <ticket>]          each open ticket's use of its limits (decision 127); lift: a person gives a
//                                         parked ticket one more allowance
//   forge system check [<system.json>]   a system's description (decision 130): its repositories, branches, deploys,
//                                         services and environment variable names
//   forge system init --system <slug> [--from <system.json>] [--workspace <dir>]   clone every member repository
//                                         side by side (origin stays the original; no branch created), link each to
//                                         the system's team folder, and make the workspace root the lead's home
//   forge lane open <ticket> [--name <n>] [--review] | close <path>   in a system: a worktree in the member
//                                         repository the ticket's plan names (Repo:), for one agent (the lead's)
//   forge pacing                          plan usage and pacing level (exit 0 green, 1 amber, 2 red, 3 off/unknown)
//   forge llm [add <name> --url <address> --model <model> [--key-file <file>] | use <name>|claude | remove <name>]
//                                         a self-hosted model server instead of Claude (decision 140): the servers
//                                         this machine knows; use: this checkout's agents run there from the next session
//   forge worktrees [--clean]             the agents' worktrees: running, done or unfinished (exit 0 when safe to
//                                         close); --clean removes the done ones, never anything unfinished
//   forge version
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, leadCompactAt, TRACKERS, trackerEnv, openprojectEnv } from '../policy/lib/config.mjs';
import { git, mainRootOf, makeContext } from '../policy/lib/context.mjs';
import { KIT_ROOT, kitVersion } from '../policy/lib/kit.mjs';
import { gatesCommand } from '../policy/lib/handlers.mjs';
import { pacingState } from '../policy/lib/pacing.mjs';
import { serverPrefix } from '../policy/lib/mcp.mjs';
import { check as apiCheck, fetchSpec, generate as apiGenerate, ApiError } from './api.mjs';
import { sample as designSample, DesignError } from './design.mjs';
import { merge, MergeError } from './merge.mjs';
import { checkDocs, DocsError } from './docs.mjs';
import { newProject, StarterError } from './starter.mjs';
import { metrics, MetricsError } from './metrics.mjs';
import { timeline } from './timeline.mjs';
import { importHistory } from './timeline-import.mjs';
import { dashboardModel, writeDashboard, stampFile } from './dashboard/page.mjs';
import { clock } from './dashboard/format.mjs';
import { renderText } from './dashboard/text.mjs';
import { readIssues } from './dashboard/issues.mjs';
import { architectureModel } from './dashboard/architecture.mjs';
import { shot, ShotError, screensCheck } from './shot.mjs';
import { app, appInfo, AppError } from './app.mjs';
import { checkSystem, memberOf, memberSettings, systemOf } from '../policy/lib/system.mjs';
import { lane, LaneError } from './lane.mjs';
import { limits, LimitsError } from './limits.mjs';
import { llm, llmFor, llmDoctor, llmLabel, LlmError } from './llm.mjs';
import { llmInUse } from '../policy/lib/llm.mjs';
import { record, clip } from '../policy/lib/timeline.mjs';

const BASE_EXCLUDES = ['/.forge/', '/.claude/settings.local.json', '/.claude/worktrees/'];
const BLOCK = ['# se-forge:begin (managed by forge sync; local only, never committed)', '# se-forge:end'];
const OUR_HOOK = '.forge/kit/core/policy/bin/forge-hook.mjs';
const KIT_PARTS = ['core', 'adapters', 'extras', 'VERSION', 'package.json', 'CHANGELOG.md'];
const OUR_STATUS_LINE = '.forge/kit/extras/pacing/';

const userConfigFile = (env) => env.FORGE_USER_CONFIG || path.join(os.homedir(), '.config', 'se-forge', 'config.json');
const cacheRoot = (env) => env.FORGE_CACHE_DIR || path.join(os.homedir(), '.cache', 'se-forge', 'kits');
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`); };
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');
const readVersion = (dir) => { try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(); } catch { return null; } };

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=');
      if (v !== undefined) opts[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('-')) opts[k] = argv[++i];
      else opts[k] = true;
    } else if (a === '-m') opts.message = argv[++i];
    else opts._.push(a);
  }
  return opts;
}

// The main checkout of the git repository the command runs in.
function checkout(cwd) {
  const top = git(cwd, ['rev-parse', '--show-toplevel']);
  if (!top.ok) throw new UsageError('Run forge inside a git repository (the client project).');
  const main = mainRootOf(cwd);
  return { main, linked: path.resolve(top.out) !== path.resolve(main) };
}

function teamRepo(env) {
  const p = readJson(userConfigFile(env), {}).teamRepo;
  if (!p) throw new UsageError('No team repo configured. Clone se-forge-projects, then: forge setup --team-repo <path>');
  if (!git(p, ['rev-parse', '--show-toplevel']).ok) throw new UsageError(`The team repo ${p} is not a git repository.`);
  return p;
}

function projectFolder(main) {
  const link = path.join(main, '.forge', 'project');
  if (!fs.existsSync(path.join(link, 'project.json'))) throw new UsageError('This checkout is not set up: forge init --project <slug>');
  return fs.realpathSync(link);
}

// The kit at the project's pinned version: this forge itself, a cached copy, or a fresh clone by tag.
function kitSource(version, env) {
  if (version === kitVersion()) return KIT_ROOT;
  const dir = path.join(cacheRoot(env), version);
  if (readVersion(dir) === version) return dir;
  const repo = env.FORGE_KIT_REPO || readJson(userConfigFile(env), {}).kitRepo;
  if (!repo) throw new UsageError(`This project pins se-forge ${version}; this forge is ${kitVersion()}. Tell forge where kit versions come from: forge setup --kit-repo <git url of se-forge>`);
  const tmp = `${dir}.tmp-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const r = spawnSync('git', ['clone', '-q', '--depth', '1', '--branch', `v${version}`, repo, tmp], { encoding: 'utf8' });
  if (r.status !== 0) throw new UsageError(`Cannot fetch se-forge v${version} from ${repo}: ${(r.stderr || '').trim().split('\n').pop()}`);
  if (readVersion(tmp) !== version) { fs.rmSync(tmp, { recursive: true, force: true }); throw new UsageError(`Tag v${version} in ${repo} does not contain VERSION ${version}.`); }
  fs.rmSync(path.join(tmp, '.git'), { recursive: true, force: true });
  fs.rmSync(dir, { recursive: true, force: true });
  fs.renameSync(tmp, dir);
  return dir;
}

function copyTree(from, to) {
  const st = fs.statSync(from);
  if (st.isFile()) { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(from, to); fs.chmodSync(to, st.mode); return; }
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (['.DS_Store', 'node_modules', '.git'].includes(e.name)) continue;
    copyTree(path.join(from, e.name), path.join(to, e.name));
  }
}

function writeExcludes(main, generated) {
  const file = path.join(main, '.git', 'info', 'exclude');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n') : [];
  const start = lines.indexOf(BLOCK[0]);
  const end = lines.indexOf(BLOCK[1]);
  const kept = start >= 0 && end > start ? [...lines.slice(0, start), ...lines.slice(end + 1)] : lines;
  const entries = [...BASE_EXCLUDES, ...generated, ...memberExcludes(main)];
  const body = [BLOCK[0], ...entries, BLOCK[1]];
  const text = `${[...kept.filter((l, i) => l !== '' || i < kept.length - 1), ...body].join('\n')}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A system's workspace root holds its member repositories side by side; its own Git repository leaves them out.
function memberExcludes(main) {
  if (memberOf(main)?.repo !== null || !memberOf(main)) return [];
  try { return JSON.parse(fs.readFileSync(path.join(main, '.forge', 'project', 'system.json'), 'utf8')).repos.map((r) => `/${r.path || r.name}/`); } catch { return []; }
}

// The kit's git hooks, by absolute path so every worktree of the repository runs them. A hooks path the
// project already used (husky, lefthook) is remembered and chained after the kit's checks.
function installGitHooks(main, kitDir) {
  const ours = path.join(kitDir, 'core', 'githooks');
  const current = git(main, ['config', '--local', '--get', 'core.hooksPath']).out;
  if (current && path.resolve(main, current) !== ours && !current.includes('.forge/kit/core/githooks')) {
    git(main, ['config', '--local', 'se-forge.previousHooksPath', current]);
  }
  git(main, ['config', '--local', 'core.hooksPath', ours]);
}

// Local Claude settings: the kit's hooks and permissions, merged into what the developer already has.
// Entries the kit added before are recorded in .forge/state, so an upgrade can drop stale ones.
// With pacing on, the kit's status line records the plan usage; a status line of the developer's own
// in this file is kept (pacing then has no data). Returns whether the kit's status line is in place.
// The project's folder in the team repo (behind the .forge/project link, outside the checkout) is an
// additional working directory, so plans and reports are read and written without a prompt per file;
// the safety hooks treat it as .forge/project.
function applySettings(main, kitDir, { branches = [], coAuthor = true, pacing = false, projectDir, compactAt, llm = null }) {
  const file = path.join(main, '.claude', 'settings.local.json');
  const managedFile = path.join(main, '.forge', 'state', 'settings-managed.json');
  const tpl = JSON.parse(fs.readFileSync(path.join(kitDir, 'adapters/claude/settings.local.template.json'), 'utf8'));
  // One deny rule per protected branch for each {{BRANCH}} line (the hook checks every form; this is the fast path).
  for (const level of ['allow', 'ask', 'deny']) tpl.permissions[level] = tpl.permissions[level].flatMap((r) => (r.includes('{{BRANCH}}') ? branches.map((b) => r.replaceAll('{{BRANCH}}', b)) : [r]));
  const current = readJson(file, {});
  const old = readJson(managedFile, { allow: [], ask: [], deny: [] });
  current.permissions ??= {};
  for (const level of ['allow', 'ask', 'deny']) {
    const mine = new Set(tpl.permissions[level]);
    const kept = (current.permissions[level] || []).filter((r) => !(old[level] || []).includes(r) || mine.has(r));
    current.permissions[level] = [...new Set([...kept, ...mine])];
  }
  current.hooks ??= {};
  for (const [event, groups] of Object.entries(current.hooks)) {
    current.hooks[event] = groups.filter((g) => !(g.hooks || []).some((h) => String(h.command).includes(OUR_HOOK)));
    if (!current.hooks[event].length) delete current.hooks[event];
  }
  for (const [event, groups] of Object.entries(tpl.hooks)) current.hooks[event] = [...(current.hooks[event] || []), ...groups];
  // The person's claude.ai connectors (mail, documents, calendars) stay out of client projects (decision 91).
  current.disableClaudeAiConnectors = tpl.disableClaudeAiConnectors;
  // The lead compacts a little past its handover line instead of stopping for /clear (decision 93).
  if (compactAt) current.autoCompactWindow = compactAt;
  // coAuthor false: Claude Code adds no attribution to commits and PRs (the commit-msg hook strips leftovers).
  if (!coAuthor) current.attribution = { ...(current.attribution || {}), commit: '', pr: '' };
  else if (old.attribution && current.attribution) { delete current.attribution.commit; delete current.attribution.pr; if (!Object.keys(current.attribution).length) delete current.attribution; }
  const dirs = (current.permissions.additionalDirectories || []).filter((d) => !(old.additionalDirectories || []).includes(d));
  current.permissions.additionalDirectories = [...new Set([...dirs, projectDir])];
  const ourLine = (s) => String(s?.command || '').includes(OUR_STATUS_LINE);
  if (pacing && (!current.statusLine || ourLine(current.statusLine))) current.statusLine = { type: 'command', command: `node "${path.join(kitDir, 'extras', 'pacing', 'statusline.mjs')}"` };
  if (!pacing && ourLine(current.statusLine)) delete current.statusLine;
  // A self-hosted model server (forge llm, decision 140): its address, model names and key helper, or none on Claude.
  current.env ??= {};
  for (const k of old.env || []) delete current.env[k];
  if (old.apiKeyHelper && current.apiKeyHelper === old.apiKeyHelper) delete current.apiKeyHelper;
  if (llm) { Object.assign(current.env, llm.env); current.apiKeyHelper = llm.apiKeyHelper; }
  if (!Object.keys(current.env).length) delete current.env;
  writeJson(file, current);
  writeJson(managedFile, { ...Object.fromEntries(['allow', 'ask', 'deny'].map((l) => [l, tpl.permissions[l]])), attribution: !coAuthor, additionalDirectories: [projectDir], env: llm ? Object.keys(llm.env) : [], apiKeyHelper: llm?.apiKeyHelper ?? null });
  return ourLine(current.statusLine);
}

async function sync(main, o, env, out) {
  const folder = projectFolder(main);
  const pj = readJson(path.join(folder, 'project.json'), {});
  const version = pj.kit?.version || kitVersion();
  const src = kitSource(version, env);
  const { renderClaude } = await import(pathToFileURL(path.join(src, 'adapters/claude/render.mjs')).href);
  const { project: facts, errors: invalid } = loadConfig(main, env);
  if (invalid.length) throw new UsageError(`project.json is invalid, nothing written:\n  ${invalid.join('\n  ')}\n(forge config check <file> checks a fix)`);
  // A system's workspace root renders its agents without worktree isolation: each works in the lane forge gives it.
  // The stack picks the guides the agents preload (decision 137); a system's adds every repository's.
  const stack = [...Object.values(facts.stack ?? {}), ...(readJson(path.join(folder, 'system.json'), {}).repos ?? []).map((r) => r.stack)].filter((v) => typeof v === 'string');
  const { files, access } = renderClaude({ kitRoot: src, overrides: path.join(folder, 'kit'), models: facts.models, isolation: memberOf(main)?.repo !== null, stack });

  const manifestFile = path.join(main, '.forge', 'state', 'sync-manifest.json');
  const previous = readJson(manifestFile, { files: {} }).files;
  const tracked = new Set(git(main, ['ls-files', '--', '.claude']).out.split('\n').filter(Boolean));
  const conflicts = [];
  for (const [rel, text] of files) {
    const abs = path.join(main, rel);
    if (tracked.has(rel)) { conflicts.push(`${rel} belongs to the client repo (tracked); rename the kit's version with an override`); continue; }
    if (!fs.existsSync(abs)) continue;
    const now = sha(fs.readFileSync(abs, 'utf8'));
    if (!(rel in previous) && now !== sha(text)) conflicts.push(`${rel} exists and is not the kit's`);
    else if (rel in previous && now !== previous[rel] && !o.force) conflicts.push(`${rel} was edited in place; move the change to ${path.join(folder, 'kit')}/ and run forge sync (or --force to discard it)`);
  }
  const stale = Object.keys(previous).filter((rel) => !files.has(rel));
  for (const rel of stale) {
    const abs = path.join(main, rel);
    if (fs.existsSync(abs) && sha(fs.readFileSync(abs, 'utf8')) !== previous[rel] && !o.force) conflicts.push(`${rel} is no longer in the kit but was edited in place`);
  }
  if (conflicts.length) throw new UsageError(`Nothing written. Resolve first:\n  ${conflicts.join('\n  ')}`);

  const kitDir = path.join(main, '.forge', 'kit');
  fs.rmSync(kitDir, { recursive: true, force: true });
  for (const part of KIT_PARTS) if (fs.existsSync(path.join(src, part))) copyTree(path.join(src, part), path.join(kitDir, part));
  for (const rel of stale) {
    fs.rmSync(path.join(main, rel), { force: true });
    for (let d = path.dirname(path.join(main, rel)); d.startsWith(path.join(main, '.claude')) && d !== path.join(main, '.claude'); d = path.dirname(d)) {
      if (fs.existsSync(d) && !fs.readdirSync(d).length) fs.rmdirSync(d); else break;
    }
  }
  const manifest = {};
  for (const [rel, text] of files) {
    fs.mkdirSync(path.dirname(path.join(main, rel)), { recursive: true });
    fs.writeFileSync(path.join(main, rel), text);
    manifest[rel] = sha(text);
  }
  writeJson(manifestFile, { version, files: manifest });
  writeJson(path.join(main, '.forge', 'state', 'roles.json'), access);
  const generated = [...new Set([...files.keys()].map((rel) => (rel.startsWith('.claude/skills/') ? `/${rel.split('/').slice(0, 3).join('/')}/` : `/${rel}`)))];
  writeExcludes(main, generated);
  const { config, project } = loadConfig(main, env);
  const machine = readJson(userConfigFile(env), {});
  const pacing = machine.pacing === true;
  const server = llmFor({ stateDir: path.join(main, '.forge', 'state'), kitDir, cfg: machine, settings: readJson(path.join(main, '.claude', 'settings.local.json'), {}), managed: readJson(path.join(main, '.forge', 'state', 'settings-managed.json'), {}) });
  if (server.warn) out(`model server: ${server.warn}`);
  const paced = applySettings(main, kitDir, { branches: [...new Set([config.branches.base, ...config.branches.promote, ...config.branches.protected])].filter((b) => !b.includes('*')), coAuthor: project.coAuthor, pacing, projectDir: folder, compactAt: Math.min(leadCompactAt(config.budget), server.settings?.compactAt ?? Infinity), llm: server.settings ?? null });
  writeJson(path.join(main, '.forge', 'state', 'pacing.json'), { enabled: paced });
  if (pacing && !paced) out('pacing: .claude/settings.local.json has a status line of your own; remove it and run forge sync to use pacing');
  installGitHooks(main, kitDir);
  out(`synced se-forge ${version}: ${Object.keys(access).length} agents, ${new Set([...files.keys()].filter((r) => r.startsWith('.claude/skills/')).map((r) => r.split('/')[2])).size} skills, ${[...files.keys()].filter((r) => r.startsWith('.claude/commands/')).length} commands${stale.length ? `, removed ${stale.length} stale` : ''}`);
}

function projectTemplate(slug, o) {
  const host = o.host || 'gitlab';
  return {
    kit: { version: kitVersion() },
    project: { name: slug, client: o.client || '', host, tracker: o.tracker || host, mode: 'light', coAuthor: true },
    policy: { gates: { full: '' } },
  };
}

async function init(o, env, cwd, out) {
  const { main, linked } = checkout(cwd);
  if (linked) throw new UsageError(`Run forge init in the main checkout (${main}), not in a worktree.`);
  const slug = o.project;
  if (o.tracker !== undefined && !TRACKERS.includes(o.tracker)) throw new UsageError(`--tracker must be ${TRACKERS.join(', ')}`);
  if (!slug || slug === true || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) throw new UsageError('forge init needs --project <slug> (lowercase letters, digits, . _ -), e.g. acme-portal');
  const tracked = git(main, ['ls-files', '--', '.forge', '.claude/settings.local.json']).out.split('\n').filter(Boolean);
  if (tracked.length) throw new UsageError(`Kit files are tracked in this repository: ${tracked.join(', ')}. The kit must stay out of client repos: git rm --cached them first.`);
  const team = teamRepo(env);
  const folder = path.join(team, slug);
  if (!fs.existsSync(path.join(folder, 'project.json'))) {
    if (!o.new) throw new UsageError(`No project "${slug}" in the team repo (${folder}). Use --new to create it.`);
    for (const d of ['plans', 'specs', 'contracts', 'reviews', 'bootstrap', 'architecture', 'kit']) { fs.mkdirSync(path.join(folder, d), { recursive: true }); fs.writeFileSync(path.join(folder, d, '.gitkeep'), ''); }
    writeJson(path.join(folder, 'project.json'), projectTemplate(slug, o));
    fs.writeFileSync(path.join(folder, 'metrics.md'), `# Metrics: ${slug}\n\n| Ticket | Estimate | Actual | Bugs after release | Rework | AI cost |\n|---|---|---|---|---|---|\n`);
    out(`created ${folder} (fill in project.json, then forge save)`);
  }
  const forge = path.join(main, '.forge');
  for (const d of ['state', 'handoffs']) fs.mkdirSync(path.join(forge, d), { recursive: true });
  const link = path.join(forge, 'project');
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing) {
    const target = existing.isSymbolicLink() ? path.resolve(forge, fs.readlinkSync(link)) : null;
    if (target !== path.resolve(folder)) {
      if (!o.force) throw new UsageError(`.forge/project already points at ${target ?? 'a folder'}. Use --force to relink it to ${folder}.`);
      fs.rmSync(link, { recursive: true, force: true });
    }
  }
  if (!fs.lstatSync(link, { throwIfNoEntry: false })) fs.symlinkSync(folder, link, 'dir');
  writeExcludes(main, []);
  out(`linked .forge/project -> ${folder}`);
  await sync(main, o, env, out);
  branchesInit(main, loadConfig(main, env).config, out);
  out('next: forge doctor');
  return 0;
}

// .forge/project of a checkout linked to a team folder; another link is replaced only with --force.
function linkCheckout(main, folder, o) {
  const forge = path.join(main, '.forge');
  for (const d of ['state', 'handoffs']) fs.mkdirSync(path.join(forge, d), { recursive: true });
  const link = path.join(forge, 'project');
  const existing = fs.lstatSync(link, { throwIfNoEntry: false });
  if (existing) {
    const target = existing.isSymbolicLink() ? path.resolve(forge, fs.readlinkSync(link)) : null;
    if (target === path.resolve(folder)) return;
    if (!o.force) throw new UsageError(`${main}: .forge/project already points at ${target ?? 'a folder'}. Use --force to relink it to ${folder}.`);
    fs.rmSync(link, { recursive: true, force: true });
  }
  fs.symlinkSync(folder, link, 'dir');
}

const SYSTEM_USAGE = 'forge system check [<system.json>] | forge system init --system <slug> [--from <system.json>] [--workspace <dir>] [--force]';
const SYSTEM_DIRS = ['plans', 'specs', 'contracts', 'reviews', 'bootstrap', 'architecture', 'kit', 'changes', 'repos'];

// forge system (decisions 130-133): an existing system of several repositories.
async function system(o, env, cwd, out) {
  const verb = o._[0];
  const readSystem = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new UsageError(`${file}: ${e.code === 'ENOENT' ? 'not found' : `cannot parse: ${e.message}`}`); } };
  if (verb === 'check') {
    let file = o._[1] ? path.resolve(cwd, o._[1]) : null;
    if (!file) { const { main } = checkout(cwd); file = path.join(main, '.forge', 'project', 'system.json'); }
    const errors = checkSystem(readSystem(file));
    out(errors.length ? `${file}: ${errors.length} problem${errors.length === 1 ? '' : 's'}\n${errors.map((e) => `- ${e}`).join('\n')}` : `${file}: ok`);
    return errors.length ? 1 : 0;
  }
  if (verb !== 'init') throw new UsageError(SYSTEM_USAGE);
  const slug = o.system;
  if (!slug || slug === true || !/^[a-z0-9][a-z0-9._-]*$/.test(slug)) throw new UsageError(`forge system init needs --system <slug>. ${SYSTEM_USAGE}`);
  const folder = path.join(teamRepo(env), slug);
  if (typeof o.from === 'string') {
    const given = readSystem(path.resolve(cwd, o.from));
    const there = path.join(folder, 'system.json');
    if (fs.existsSync(there) && JSON.stringify(readSystem(there)) !== JSON.stringify(given) && !o.force) throw new UsageError(`${there} exists and differs from ${o.from}. Use --force to replace it.`);
    fs.mkdirSync(folder, { recursive: true });
    writeJson(there, given);
  }
  const sys = readSystem(path.join(folder, 'system.json'));
  const errors = checkSystem(sys);
  if (sys.name !== slug) errors.push(`name is ${sys.name}, the system is ${slug}`);
  if (errors.length) throw new UsageError(`${path.join(folder, 'system.json')}:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  if (!fs.existsSync(path.join(folder, 'project.json'))) {
    for (const d of SYSTEM_DIRS) { fs.mkdirSync(path.join(folder, d), { recursive: true }); fs.writeFileSync(path.join(folder, d, '.gitkeep'), ''); }
    const pj = projectTemplate(slug, { host: sys.board.host, tracker: sys.board.host });
    pj.project.board = sys.board.project;
    pj.project.mode = 'full';
    writeJson(path.join(folder, 'project.json'), pj);
    fs.writeFileSync(path.join(folder, 'metrics.md'), `# Metrics: ${slug}\n\n| Ticket | Estimate | Actual | Bugs after release | Rework | AI cost |\n|---|---|---|---|---|---|\n`);
    out(`created ${folder}`);
  }
  const home = os.homedir();
  const ws = path.resolve(String(o.workspace && o.workspace !== true ? o.workspace : sys.workspace || `~/code/${slug}`).replace(/^~(?=$|\/)/, home));
  fs.mkdirSync(ws, { recursive: true });
  // The workspace root: the lead's home, a local Git repository that holds only the kit's files (never pushed).
  if (!git(ws, ['rev-parse', '--show-toplevel']).ok || path.resolve(git(ws, ['rev-parse', '--show-toplevel']).out) !== fs.realpathSync(ws)) {
    git(ws, ['init', '-q', '-b', 'main']);
    git(ws, ['-c', 'user.name=forge', '-c', 'user.email=forge@localhost', 'commit', '-q', '--allow-empty', '-m', `workspace of the ${slug} system (local only, never pushed)`]);
  }
  const problems = [];
  for (const repo of sys.repos) {
    const dest = path.join(ws, repo.path || repo.name);
    if (!fs.existsSync(path.join(dest, '.git'))) {
      out(`cloning ${repo.name} from ${repo.url}`);
      const r = spawnSync('git', ['clone', '-q', repo.url, dest], { encoding: 'utf8', env });
      if (r.status !== 0) { problems.push(`${repo.name}: git clone failed: ${(r.stderr || '').trim().split('\n').pop()}`); continue; }
    } else {
      const origin = git(dest, ['remote', 'get-url', 'origin']).out;
      if (origin && origin !== repo.url) problems.push(`${repo.name}: ${dest} has origin ${origin}, the description says ${repo.url} (kept as it is)`);
    }
    const tracked = git(dest, ['ls-files', '--', '.forge', '.claude/settings.local.json']).out.split('\n').filter(Boolean);
    if (tracked.length) { problems.push(`${repo.name}: kit files are tracked there (${tracked.join(', ')}): git rm --cached them first`); continue; }
    linkCheckout(dest, folder, o);
    writeJson(path.join(dest, '.forge', 'repo.json'), { system: slug, repo: repo.name });
    const own = path.join(folder, 'repos', repo.name, 'project.json');
    if (!fs.existsSync(own)) { fs.mkdirSync(path.dirname(own), { recursive: true }); writeJson(own, memberSettings(sys, repo)); }
    await sync(dest, o, env, out);
  }
  linkCheckout(ws, folder, o);
  writeJson(path.join(ws, '.forge', 'repo.json'), { system: slug, repo: null });
  await sync(ws, o, env, out);
  out(`system ${slug}: ${sys.repos.length - problems.filter((p) => /clone failed|tracked/.test(p)).length} of ${sys.repos.length} repositories in ${ws}; the board is ${sys.board.project}`);
  for (const p of problems) out(`! ${p}`);
  out(`next: fill each repository's settings (${path.join(folder, 'repos', '<repo>', 'project.json')}: its gate command and tests), forge save, then open Claude Code in ${ws}`);
  return problems.some((p) => /clone failed|tracked/.test(p)) ? 1 : 0;
}

// Decision 74: every project has its base branch (dev) and the promotion branches (staging, main). The
// missing ones are created locally from the production branch (the last promotion branch), never pushed:
// a person pushes and protects them.
function branchesInit(main, config, out) {
  const all = [config.branches.base, ...config.branches.promote].filter((b) => !b.includes('*'));
  const has = (ref) => git(main, ['rev-parse', '--verify', '-q', ref]).ok;
  const prod = all[all.length - 1];
  const created = [];
  for (const b of all) {
    if (has(`refs/heads/${b}`)) continue;
    const from = [`origin/${b}`, `refs/heads/${prod}`, `origin/${prod}`].find(has);
    if (!from) { out(`branch ${b}: nothing to create it from (no ${prod} yet); create it after the first commit`); continue; }
    if (git(main, ['branch', b, from]).ok) created.push(`${b} (from ${from.replace('refs/heads/', '')})`);
  }
  if (created.length) out(`created branches ${created.join(', ')}`);
  const unpushed = all.filter((b) => !has(`refs/remotes/origin/${b}`));
  if (unpushed.length) out(`push them and protect all of ${all.join(', ')} (core/server/<host>.md): git push -u origin ${unpushed.join(' ')}`);
}

// OpenProject is reached with curl and jq; its settings come from project.openproject (or the environment), and
// the API key from one of four places (core/tracker/openproject-key.sh), reported by name, never by value.
function openprojectDoctor(project, env, check) {
  const missing = ['curl', 'jq'].filter((c) => spawnSync(c, ['--version']).status !== 0);
  if (missing.length) check('warn', `tracker openproject needs ${missing.join(' and ')} (brew install ${missing.join(' ')}, apt install ${missing.join(' ')})`);
  const vars = { ...openprojectEnv(project, env), ...Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith('OPENPROJECT_'))) };
  const unset = ['OPENPROJECT_URL', 'OPENPROJECT_PROJECT'].filter((n) => !vars[n]);
  if (unset.length) check('warn', `tracker openproject: ${unset.join(' and ')} not set (project.openproject.${unset.map((n) => n === 'OPENPROJECT_URL' ? 'url' : 'project').join(' and ')} in project.json)`);
  const key = path.join(KIT_ROOT, 'core/tracker/openproject-key.sh');
  const r = spawnSync('bash', ['-c', '. "$1" && op_find_key && printf %s "$op_key_source"', 'doctor', key], { encoding: 'utf8', env: { ...env, ...vars } });
  if (r.status === 0) check('ok', `tracker openproject: API key from ${r.stdout.trim()}`);
  else check('warn', (r.stderr || 'tracker openproject: no API key found').trim().split('\n').pop());
  const boards = (vars.OPENPROJECT_BOARDS || '').split(',').filter(Boolean);
  if (boards.length || vars.OPENPROJECT_BOARD) check('ok', `tracker openproject: boards ${boards.join(', ') || vars.OPENPROJECT_BOARD}${vars.OPENPROJECT_BOARD ? `; default board ${vars.OPENPROJECT_BOARD}` : ''}`);
  else check('info', 'tracker openproject: no boards configured, status mode (list board groups by status; status moves no cards)');
}

// The system's description and each member repository: in the workspace, linked, its settings valid, its gate set and
// its own branches on origin.
function systemDoctor(main, env, check) {
  const sys = systemOf(main);
  const errors = sys ? checkSystem(sys) : ['no system.json in the team folder'];
  check(errors.length ? 'fail' : 'ok', errors.length ? `system.json: ${errors.join('; ')} (forge system check)` : `system ${sys.name}: ${sys.repos.length} repositories, the board ${sys.board.project}`);
  for (const r of errors.length ? [] : sys.repos) {
    const dir = path.join(main, r.path || r.name);
    if (!fs.existsSync(path.join(dir, '.git'))) { check('fail', `${r.name}: not in the workspace (${dir}): forge system init`); continue; }
    if (memberOf(dir)?.repo !== r.name) { check('fail', `${r.name}: not linked to the system: forge system init`); continue; }
    const c = loadConfig(dir, env);
    if (c.errors.length) { check('fail', `${r.name}: ${c.errors.join('; ')}`); continue; }
    const away = [c.config.branches.base, ...c.config.branches.promote].filter((b) => !git(dir, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`]).ok);
    if (!c.config.gates.full) check('warn', `${r.name}: no gate command (repos/${r.name}/project.json, policy.gates.full): nothing there can be marked done`);
    else if (away.length) check('warn', `${r.name}: ${away.join(', ')} not on origin, but the description names ${away.length === 1 ? 'it' : 'them'} (system.json)`);
    else check('ok', `${r.name}: gate ${c.config.gates.full}; base ${c.config.branches.base}`);
  }
}

async function doctor(env, cwd, out) {
  const results = [];
  const check = (level, msg) => results.push({ level, msg });
  const node = Number(process.versions.node.split('.')[0]);
  check(node >= 22 ? 'ok' : 'fail', `Node ${process.versions.node}${node >= 22 ? '' : ' (22 or newer required)'}`);
  check(spawnSync('gitleaks', ['version']).status === 0 ? 'ok' : 'warn', 'gitleaks for the commit secret scan (else built-in patterns are used)');
  const compose = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8' });
  check(compose.status === 0 ? 'ok' : 'warn', compose.status === 0 ? `Docker Compose ${compose.stdout.trim()} (the app, its tests and the gate run in containers)` : 'Docker with Compose v2 is not available: the app, its tests and the gate run in containers (decision 72)');
  let main;
  try { ({ main } = checkout(cwd)); } catch (e) { check('fail', e.message); return report(results, out); }
  try { check('ok', `team repo ${teamRepo(env)}`); } catch (e) { check('fail', e.message); }
  let folder = null;
  try { folder = projectFolder(main); check('ok', `.forge/project -> ${folder}`); } catch { check('fail', '.forge/project is missing or broken: forge init --project <slug>'); }
  if (folder) {
    const { config, project, kitVersion: pin, errors } = loadConfig(main, env);
    check(errors.length ? 'fail' : 'ok', errors.length ? `project.json: ${errors.join('; ')}` : 'project.json is valid');
    if (project.api.spec && !project.api.contractRepo) {
      const has = fs.existsSync(path.join(main, project.api.spec));
      const newest = git(main, ['tag', '-l', 'api-v*', '--sort=-v:refname']).out.split('\n').find((t) => /^api-v\d+\.\d+\.\d+$/.test(t));
      check(has ? 'ok' : 'warn', has ? `API contract ${project.api.spec}; newest approved version ${newest || 'none yet'}` : `API contract ${project.api.spec} does not exist yet`);
    }
    if (project.api.contractRepo) check(project.api.pin ? 'ok' : 'warn', project.api.pin ? `API contract from ${project.api.contractRepo}, pinned at ${project.api.pin}` : `API contract from ${project.api.contractRepo}, but no version is pinned (project.api.pin)`);
    const cli = { gitlab: 'glab', github: 'gh' }[project.tracker];
    const missing = [cli, 'jq'].filter((c) => c && spawnSync(c, ['--version']).status !== 0);
    if (project.tracker === 'openproject') openprojectDoctor(project, env, check);
    else if (cli) check(missing.length ? 'warn' : 'ok', missing.length ? `tracker ${project.tracker} needs ${missing.join(' and ')} (brew install ${missing.join(' ')}; then ${cli} auth login)` : `tracker ${project.tracker}: ${cli} and jq installed`);
    const have = readVersion(path.join(main, '.forge', 'kit'));
    check(have && have === (pin || have) ? 'ok' : 'fail', have ? `kit ${have} in .forge/kit${pin && pin !== have ? ` but the project pins ${pin}: forge sync` : ''}` : 'no kit in .forge/kit: forge sync');
    // A system's workspace root has no gate and no origin of its own: each member repository has both (decision 130).
    const root = memberOf(main)?.repo === null;
    if (root) systemDoctor(main, env, check);
    else check(config.gates.full ? 'ok' : 'warn', config.gates.full ? `gate command: ${config.gates.full}` : 'no gate command (policy.gates.full): nothing can be marked done');
    const manifest = readJson(path.join(main, '.forge', 'state', 'sync-manifest.json'), { files: {} }).files;
    const changed = Object.entries(manifest).filter(([rel, h]) => !fs.existsSync(path.join(main, rel)) || sha(fs.readFileSync(path.join(main, rel), 'utf8')) !== h).map(([rel]) => rel);
    check(changed.length ? 'fail' : 'ok', changed.length ? `generated files missing or edited in place: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' …' : ''} (forge sync)` : `${Object.keys(manifest).length} generated files intact`);
    const all = root ? [] : [config.branches.base, ...config.branches.promote].filter((b) => !b.includes('*'));
    const away = all.filter((b) => !git(main, ['rev-parse', '--verify', '-q', `refs/remotes/origin/${b}`]).ok);
    if (!root) check(away.length ? 'warn' : 'ok', away.length ? `branches missing on origin: ${away.join(', ')} (forge init creates them; a person pushes and protects them)` : `branches ${all.join(', ')} on origin`);
    const dirty = git(folder, ['status', '--porcelain', '--', '.']).out;
    check(dirty ? 'warn' : 'ok', dirty ? 'unsaved changes in the team repo: forge save' : 'team repo folder saved');
    if (project.design.source === 'figma' || project.figma.fileKey) check(...figmaServer(main, project.figma.toolPrefix, env));
    for (const s of screensCheck(main, folder)) check(s.level, s.msg);
  }
  const exclude = fs.existsSync(path.join(main, '.git/info/exclude')) ? fs.readFileSync(path.join(main, '.git/info/exclude'), 'utf8') : '';
  check(exclude.includes(BLOCK[0]) ? 'ok' : 'fail', exclude.includes(BLOCK[0]) ? 'kit files excluded from git' : 'kit files are not excluded from git: forge sync');
  const visible = git(main, ['status', '--porcelain', '--', '.forge', '.claude']).out.split('\n').filter(Boolean);
  const trackedKit = git(main, ['ls-files', '--', '.forge', '.claude/settings.local.json']).out.split('\n').filter(Boolean);
  check(visible.length || trackedKit.length ? 'fail' : 'ok', visible.length || trackedKit.length ? `kit files visible to git: ${[...trackedKit, ...visible].slice(0, 5).join(', ')}` : 'nothing from the kit is visible to git');
  const settings = readJson(path.join(main, '.claude', 'settings.local.json'), {});
  const hooked = JSON.stringify(settings.hooks || {}).includes(OUR_HOOK);
  check(hooked ? 'ok' : 'fail', hooked ? 'safety hooks wired in .claude/settings.local.json' : 'safety hooks missing: forge sync');
  const sealed = settings.disableClaudeAiConnectors === true;
  check(sealed ? 'ok' : 'fail', sealed ? 'claude.ai connectors off in this project' : 'claude.ai connectors (mail, documents, calendars) are on in this project: forge sync');
  const hooksPath = git(main, ['config', '--get', 'core.hooksPath']).out;
  check(hooksPath.endsWith(path.join('.forge', 'kit', 'core', 'githooks')) ? 'ok' : 'fail', hooksPath.includes('.forge/kit/core/githooks') ? 'git hooks wired' : `git hooks not wired (core.hooksPath is ${hooksPath || 'unset'}; something reset it, e.g. husky): forge sync`);
  const stateDir = path.join(main, '.forge', 'state');
  const pace = pacingState({ stateDir, env });
  const machine = readJson(userConfigFile(env), {});
  if (machine.pacing === true && pace.level === 'off' && !env.ANTHROPIC_API_KEY && !llmInUse(stateDir)) check('warn', 'pacing is on for you but not in this checkout: forge sync');
  else check('info', pace.level === 'off' ? `pacing off: ${pace.why}` : pace.level === 'unknown' ? `pacing on: ${pace.why}` : `pacing on: ${pace.level}, ${pace.text} (recorded ${pace.age}s ago)`);
  if (folder) {
    const { config, project } = loadConfig(main, env);
    for (const r of await llmDoctor({ stateDir, kitDir: path.join(main, '.forge', 'kit'), cfg: machine, settings, managed: readJson(path.join(stateDir, 'settings-managed.json'), {}), models: project.models, budget: config.budget, env })) check(r.level, r.msg);
  }
  check('info', 'server gates are not checked automatically yet: follow core/server/<host>.md');
  return report(results, out);
}

// Figma's MCP server for a project whose screens are in Figma: installed and logged in (GUIDE.md, B8).
// `claude mcp list` prints one "<server>: <address> - <status>" line per server.
function figmaServer(main, prefix, env) {
  const r = spawnSync('claude', ['mcp', 'list'], { cwd: main, env, encoding: 'utf8', timeout: 120000 });
  if (!r.stdout) return ['warn', "Figma's MCP server not checked: `claude mcp list` did not run"];
  const line = r.stdout.split('\n').find((l) => l.includes(': ') && serverPrefix(l.slice(0, l.indexOf(': '))) === prefix);
  if (!line) return ['warn', "the screens are in Figma, but Figma's MCP server is not installed: claude plugin install figma (GUIDE.md, B8)"];
  const status = line.slice(line.lastIndexOf(' - ') + 3).trim();
  return status.startsWith('✔') ? ['ok', "Figma's MCP server connected"] : ['warn', `Figma's MCP server: ${status.replace(/^[^\p{L}]+/u, '')}. Log in through /plugin (GUIDE.md, B8)`];
}

function report(results, out) {
  const mark = { ok: '✓', warn: '!', fail: '✗', info: '·' };
  for (const r of results) out(`${mark[r.level]} ${r.msg}`);
  return results.some((r) => r.level === 'fail') ? 1 : 0;
}

function save(o, cwd, out) {
  const { main } = checkout(cwd);
  const folder = projectFolder(main);
  const team = git(folder, ['rev-parse', '--show-toplevel']).out;
  const rel = path.relative(team, folder);
  git(team, ['add', '--', rel]);
  if (!git(team, ['diff', '--cached', '--name-only', '--', rel]).out) { out('nothing to save'); return 0; }
  const msg = `${path.basename(folder)}: ${typeof o.message === 'string' ? o.message : 'update plans and reports'}`;
  const c = git(team, ['commit', '-q', '-m', msg, '--', rel]);
  if (!c.ok) throw new UsageError(`commit failed: ${c.err}`);
  const p = git(team, ['push', '-q'], 60000);
  out(p.ok ? `saved and pushed: ${msg}` : `saved locally (push failed: ${p.err.split('\n')[0]}); push the team repo when you can`);
  return 0;
}

// The agents' worktrees (.claude/worktrees/, one per lane). Claude Code locks a lane's worktree while the
// agent works, with "(pid N …)" in the reason: a live pid is a running agent; a dead one means the agent was
// cut off (a sleep, a lost connection) and the lock is stale. Done means clean with every commit on the remote;
// anything else is unfinished work (decision 95).
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function worktrees(o, cwd, out) {
  const { main } = checkout(cwd);
  // At a system's workspace root, the lanes of every member repository too (forge lane, decision 134).
  const repos = [main, ...(memberOf(main)?.repo === null ? (systemOf(main)?.repos ?? []).map((r) => path.join(main, r.path || r.name)).filter((d) => fs.existsSync(path.join(d, '.git'))) : [])];
  const entries = [];
  for (const repo of repos) {
    for (const line of git(repo, ['worktree', 'list', '--porcelain']).out.split('\n')) {
      if (line.startsWith('worktree ')) entries.push({ path: line.slice(9), repo });
      else if (entries.length && line.startsWith('branch ')) entries.at(-1).branch = line.slice(7).replace(/^refs\/heads\//, '');
      else if (entries.length && line.startsWith('locked')) entries.at(-1).lock = line.slice(6).trim();
    }
  }
  const lanes = entries.filter((w) => path.resolve(w.path) !== path.resolve(w.repo));
  const rows = lanes.map((w) => {
    const name = w.branch ? w.branch.replace(/[^\w.-]+/g, '-') : path.basename(w.path);
    const pid = Number(/\bpid (\d+)/.exec(w.lock ?? '')?.[1]);
    if (w.lock !== undefined && (!pid || alive(pid))) return { ...w, name, state: 'running', why: pid ? `an agent is working there (pid ${pid})` : 'locked by hand: unlock it if no one is working there' };
    const cut = w.lock !== undefined ? ', its agent was cut off' : '';
    const handed = fs.existsSync(path.join(main, '.forge', 'handoffs', `${name}-handover.md`));
    const unfinished = (why) => (handed ? { ...w, name, state: 'handed over', why: `${why}${cut}; .forge/handoffs/${name}-handover.md continues it` } : { ...w, name, state: 'unfinished', why: `${why}${cut}` });
    if (git(w.path, ['status', '--porcelain']).out) return unfinished('uncommitted changes');
    if (!git(w.path, ['branch', '-r', '--contains', 'HEAD']).out) return unfinished('commits not pushed');
    return { ...w, name, state: 'done', why: `clean, everything pushed${cut}` };
  });
  const mark = { running: '!', unfinished: '✗', 'handed over': '·', done: '✓' };
  for (const r of rows) {
    let note = '';
    if (r.state === 'done' && o.clean) {
      if (r.lock !== undefined) git(r.repo, ['worktree', 'unlock', r.path]);
      note = git(r.repo, ['worktree', 'remove', r.path]).ok ? ' (removed)' : ' (could not remove it)';
    }
    if (r.state === 'unfinished') note = `: forge handover ${r.name} --from-tree ${path.relative(main, r.path)}`;
    out(`${mark[r.state]} ${path.relative(main, r.path)}  ${r.branch ?? 'detached'}  ${r.state}, ${r.why}${note}`);
  }
  const open = rows.filter((r) => r.state === 'running' || r.state === 'unfinished');
  const kept = rows.filter((r) => r.state === 'handed over').length;
  const left = rows.filter((r) => r.state === 'done').length;
  if (!open.length) { out(`Safe to close: no agent is working and nothing is unfinished${kept ? ` (${kept} handed over, kept for the next agent)` : ''}.${left && !o.clean ? ` ${left} finished worktree(s) left; forge worktrees --clean removes them.` : ''}`); return 0; }
  out(`Not yet: ${open.filter((r) => r.state === 'running').length} running, ${open.filter((r) => r.state === 'unfinished').length} unfinished. Wait for running agents; give each unfinished one a handover (the command above), then check again.`);
  return 1;
}

function passthrough(script, args, extraEnv, env, cwd) {
  const r = spawnSync('bash', [path.join(KIT_ROOT, script), ...args], { cwd, stdio: 'inherit', env: { ...env, ...extraEnv } });
  return r.status ?? 1;
}

// Commands that act on a set-up checkout run with the kit version that checkout pins.
function delegate(cmd, argv, env, cwd) {
  if (env.FORGE_DELEGATED || !['gates', 'tracker', 'handover', 'save', 'api', 'new'].includes(cmd)) return null;
  let main;
  try { ({ main } = checkout(cwd)); } catch { return null; }
  const kitDir = path.join(main, '.forge', 'kit');
  const v = readVersion(kitDir);
  if (!v || v === kitVersion() || path.resolve(kitDir) === path.resolve(KIT_ROOT)) return null;
  const r = spawnSync('node', [path.join(kitDir, 'core/cli/forge.mjs'), ...argv], { cwd, stdio: 'inherit', env: { ...env, FORGE_DELEGATED: '1' } });
  return r.status ?? 1;
}

// A command a person runs in a terminal goes into the timeline; one an agent runs is already there as its call.
const LOGGED = new Set(['init', 'sync', 'upgrade', 'save', 'gates', 'merge', 'tracker', 'handover', 'api', 'new', 'metrics', 'worktrees', 'shot']);
function noteCommand(argv, env, cwd, code, ms, why) {
  if (env.CLAUDECODE === '1' || !LOGGED.has(argv[0])) return;
  try {
    const ctx = makeContext({ cwd }, env);
    record(ctx, code === 0 ? 'forge.done' : 'forge.fail', { what: clip(`forge ${argv.join(' ')}`, 120), ms, code, why: clip(why) });
  } catch { /* the timeline never blocks work */ }
}

export async function main(argv, env = process.env, cwd = process.cwd(), out = (s) => process.stdout.write(`${s}\n`)) {
  const [cmd] = argv;
  const delegated = delegate(cmd, argv, env, cwd);
  if (delegated !== null) return delegated;
  const started = Date.now();
  let why;
  const code = await run(argv, env, cwd, out, (e) => { why = e; });
  noteCommand(argv, env, cwd, code, Date.now() - started, why);
  return code;
}

async function run(argv, env, cwd, out, failed) {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  try {
    switch (cmd) {
      case 'setup': {
        const cfg = readJson(userConfigFile(env), {});
        if (o['team-repo'] && o['team-repo'] !== true) {
          const p = path.resolve(cwd, o['team-repo']);
          if (!git(p, ['rev-parse', '--show-toplevel']).ok) throw new UsageError(`${p} is not a git repository.`);
          cfg.teamRepo = p;
        }
        if (o['kit-repo'] && o['kit-repo'] !== true) cfg.kitRepo = o['kit-repo'];
        if (o.pacing !== undefined) {
          if (!['on', 'off'].includes(o.pacing)) throw new UsageError('forge setup --pacing on|off');
          cfg.pacing = o.pacing === 'on';
        }
        if (!cfg.teamRepo) throw new UsageError('forge setup --team-repo <path to your clone of se-forge-projects> [--kit-repo <git url of se-forge>] [--pacing on|off]');
        writeJson(userConfigFile(env), cfg);
        out(`team repo: ${cfg.teamRepo}${cfg.kitRepo ? `\nkit repo: ${cfg.kitRepo}` : ''}\npacing: ${cfg.pacing ? 'on' : 'off'}`);
        if (o.pacing !== undefined) out(`run forge sync in each checkout to ${cfg.pacing ? 'add' : 'remove'} the pacing status line${cfg.pacing && env.ANTHROPIC_API_KEY ? '; pacing stays off while ANTHROPIC_API_KEY is set (API billing has no plan windows)' : ''}`);
        return 0;
      }
      case 'init': return await init(o, env, cwd, out);
      case 'sync': await sync(checkout(cwd).main, o, env, out); return 0;
      case 'upgrade': {
        if (!o.to || o.to === true || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(o.to)) throw new UsageError('forge upgrade --to <version>, e.g. 0.2.0');
        const { main: m } = checkout(cwd);
        const file = path.join(projectFolder(m), 'project.json');
        const raw = readJson(file, {});
        const from = raw.kit?.version;
        raw.kit = { ...(raw.kit || {}), version: o.to };
        writeJson(file, raw);
        try { await sync(m, o, env, out); } catch (e) { raw.kit.version = from; writeJson(file, raw); throw e; }
        out(`project pinned to se-forge ${o.to} (was ${from}); run forge save so teammates get it`);
        return 0;
      }
      case 'doctor': return await doctor(env, cwd, out);
      case 'save': return save(o, cwd, out);
      case 'gates': {
        const r = gatesCommand(env, cwd);
        out(r.ok ? `gates green${r.sha ? ` on ${r.sha.slice(0, 8)}` : ''}${r.cached ? ' (recorded)' : ''}` : `NOT DONE: ${r.reason}`);
        return r.ok ? 0 : 1;
      }
      case 'merge': {
        const { main: m } = checkout(cwd);
        return merge({ ticket: o._[0], branch: typeof o.branch === 'string' ? o.branch : null }, env, m, out);
      }
      case 'tracker': {
        const { main: m } = checkout(cwd);
        const { project } = loadConfig(m, env);
        // A system's one board (decision 131), and OpenProject's settings from project.openproject.
        return passthrough('core/tracker/tracker.sh', rest, trackerEnv(project, env), env, m);
      }
      case 'handover': {
        const { main: m } = checkout(cwd);
        const { config } = loadConfig(m, env);
        return passthrough('core/skills/handover/scripts/handover.sh', rest, { FORGE_BASE_BRANCH: config.branches.base }, env, cwd);
      }
      case 'api': {
        const sub = o._[0];
        if (sub === 'check') return apiCheck(o, env, cwd, out);
        if (sub === 'fetch') { out(fetchSpec(env, cwd)); return 0; }
        if (sub === 'generate') return apiGenerate(env, cwd, out);
        throw new UsageError('forge api check [--spec <file>] [--base <tag>] | fetch | generate');
      }
      case 'new': {
        const { main: m } = checkout(cwd);
        const { project } = loadConfig(m, env);
        const str = (v) => (typeof v === 'string' ? v : undefined);
        newProject({ backend: str(o.backend), db: str(o.db), frontend: str(o.frontend), mobile: str(o.mobile), appId: str(o['app-id']), title: str(o.title) || project.name, host: str(o.host) || project.host, backendDir: str(o['backend-dir']) }, { kitRoot: KIT_ROOT, root: m, out });
        return 0;
      }
      case 'metrics': {
        const { main: m } = checkout(cwd);
        const branchOf = (t) => {
          const dir = path.join(m, '.forge', 'project', 'plans');
          const plan = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find((f) => f.startsWith(`${t}-`) && f.endsWith('.md'));
          return plan ? (/^Branch:\s*`?([^\s`]+)`?/mi.exec(fs.readFileSync(path.join(dir, plan), 'utf8'))?.[1] ?? null) : null;
        };
        metrics({ ticket: o._[0], branch: typeof o.branch === 'string' ? o.branch : null, record: o.record === true }, { main: m, env, out, branchOf });
        return 0;
      }
      case 'docs': {
        if (o._[0] !== 'check') throw new UsageError('forge docs check <file|folder> ...');
        const r = checkDocs(o._.slice(1), { cwd });
        out(r.text);
        return r.ok ? 0 : 1;
      }
      case 'design': {
        if (o._[0] !== 'sample' || !o._[1]) throw new UsageError('forge design sample <image> [--at "x,y x,y"] [--region x,y,w,h] [--top N]');
        const file = path.resolve(cwd, o._[1]);
        if (!fs.existsSync(file)) throw new UsageError(`${file} does not exist.`);
        out(designSample(file, { at: typeof o.at === 'string' ? o.at.split(/\s+/).filter(Boolean) : [], region: typeof o.region === 'string' ? o.region : null, top: Number(o.top) || 12 }));
        return 0;
      }
      case 'config': {
        const file = o._[1];
        if (o._[0] !== 'check' || !file) throw new UsageError('forge config check <project.json or a proposal>');
        const abs = path.resolve(cwd, file);
        if (!fs.existsSync(abs)) throw new UsageError(`${abs} does not exist.`);
        const { errors } = loadConfig(cwd, { ...env, FORGE_CONFIG: abs });
        out(errors.length ? `INVALID ${file}:\n  ${errors.join('\n  ')}` : `valid: ${file}`);
        return errors.length ? 1 : 0;
      }
      case 'pacing': {
        const { main: m } = checkout(cwd);
        const pace = pacingState({ stateDir: path.join(m, '.forge', 'state'), env });
        const advice = { green: 'normal pace', amber: 'finish what is running, prefer reviews and QA, start nothing large', red: 'pause: hand over and resume at the reset (skill pacing)' };
        out(pace.text ? `${pace.level.toUpperCase()}: ${pace.text}; recorded ${pace.age}s ago. ${advice[pace.level]}` : `${pace.level.toUpperCase()}: ${pace.why}`);
        return { green: 0, amber: 1, red: 2 }[pace.level] ?? 3;
      }
      case 'worktrees': return worktrees(o, cwd, out);
      case 'llm': {
        let m = null;
        try { m = checkout(cwd).main; } catch { /* the list, add and remove work anywhere */ }
        const c = m ? loadConfig(m, env) : null;
        return await llm(o, { env, cwd, out, cfgFile: userConfigFile(env), main: m, sync: () => sync(m, {}, env, out), budget: c?.config.budget, models: c?.project.models });
      }
      case 'dashboard': {
        const { main: m } = checkout(cwd);
        const folder = projectFolder(m);
        const top = git(folder, ['rev-parse', '--show-toplevel']);
        if (!top.ok) throw new UsageError(`${folder} is not in a git repository (the team repo).`);
        const { config, project, kitVersion: pinned } = loadConfig(m, env);
        const usage = 'forge dashboard [--text] [--days <n>] [--ticket 11,12] [--out <file>] [--no-open] [--offline] [--watch [--every <minutes>]]';
        if (o.days !== undefined && !(Number(o.days) > 0)) throw new UsageError(usage);
        const watch = o.watch === true;
        const every = o.every === undefined ? 5 : Number(o.every);
        if (watch && o.text === true) throw new UsageError(`--watch keeps the page current; --text prints once. ${usage}`);
        if ((watch || o.every !== undefined) && !(every >= 1)) throw new UsageError(`--every takes minutes, 1 or more (with --watch). ${usage}`);
        const only = typeof o.ticket === 'string' ? o.ticket.split(',').map((t) => Number(t.replace(/^#/, ''))).filter((n) => n > 0) : null;
        const file = typeof o.out === 'string' ? path.resolve(cwd, o.out) : path.join(m, '.forge', 'state', 'dashboard.html');
        // A system's workspace root covers every member repository (decision 130), and reads the system's board.
        const repos = memberOf(m)?.repo === null ? (systemOf(m)?.repos ?? []).map((r) => {
          const dir = path.join(m, r.path || r.name);
          return { name: r.name, dir, base: loadConfig(dir, env).config.branches.base, stateDir: path.join(dir, '.forge', 'state') };
        }).filter((r) => fs.existsSync(path.join(r.dir, '.git'))) : null;
        const build = async () => {
          // The tracker's issues and their history (decision 122); --offline draws from the last read.
          const issues = project.tracker ? await readIssues({ main: m, stateDir: path.join(m, '.forge', 'state'), tracker: project.tracker, board: project.board, env, offline: o.offline === true }) : null;
          const model = dashboardModel({ main: m, folder, teamRoot: top.out, base: config.branches.base, stateDir: path.join(m, '.forge', 'state'), prices: project.prices, engineers: config.budget.engineers, days: o.days ? Number(o.days) : null, only, kit: { active: readVersion(path.join(m, '.forge', 'kit')), pinned, cli: kitVersion(), llm: llmLabel(path.join(m, '.forge', 'state'), readJson(userConfigFile(env), {})) }, issues, app: o.text === true ? null : appInfo(m, env),
            architecture: o.text === true ? null : architectureModel({ main: m, folder, base: config.branches.base, project, config, env, stateDir: path.join(m, '.forge', 'state') }), watch: watch ? { every } : null, limits: config.limits, tracker: project.tracker, repos,
            stack: [...Object.values(project.stack ?? {}), ...(systemOf(m)?.repos ?? []).map((r) => r.stack)].filter((v) => typeof v === 'string'), promote: config.branches.promote });
          if (o.text === true) return { model };
          return { model, ...writeDashboard(model, { project: project.name || path.basename(m), out: file }) };
        };
        const first = await build();
        if (o.text === true) { out(renderText(first.model, { project: project.name || path.basename(m) }).trimEnd()); return 0; }
        const summary = (x) => `${x.tickets.length} tickets, ${x.progress.ticketsDone.length} of ${x.progress.totalTickets} merged`;
        out(`dashboard: ${first.html}\ntable: ${first.csv}\n${summary(first.model)}${first.model.lines.some((e) => e.source === 'import') ? '' : ' (forge timeline import adds the history before 0.2.6)'}`);
        if (o['no-open'] !== true && process.platform === 'darwin') spawnSync('open', [first.html], { stdio: 'ignore' });
        if (!watch) return 0;
        // --watch (decision 126): a new page every few minutes until Ctrl+C; the open page reloads itself.
        out(`watching: a new page every ${every} minute${every === 1 ? '' : 's'}; the open page reloads itself. Ctrl+C stops.`);
        return await new Promise((resolve) => {
          let busy = false;
          const timer = setInterval(async () => {
            if (busy) return;
            busy = true;
            try { out(`${clock(Date.now())} rebuilt: ${summary((await build()).model)}`); } catch (e) { out(`${clock(Date.now())} not rebuilt (${e.message}); trying again in ${every} minute${every === 1 ? '' : 's'}`); }
            busy = false;
          }, Number(env.FORGE_WATCH_MS) || every * 60000);
          const stop = () => {
            clearInterval(timer);
            fs.rmSync(stampFile(file), { force: true });
            out('stopped watching; the page stays as it was last built');
            resolve(0);
          };
          process.once('SIGINT', stop);
          process.once('SIGTERM', stop);
        });
      }
      case 'system': return await system(o, env, cwd, out);
      case 'lane': return lane(o, { main: checkout(cwd).main, out });
      case 'app': {
        const { main: m } = checkout(cwd);
        return app(o, { main: m, env, out });
      }
      case 'limits': {
        const { main: m } = checkout(cwd);
        const { config } = loadConfig(m, env);
        return limits(o, { main: m, folder: projectFolder(m), config, out });
      }
      case 'shot': {
        const { main: m } = checkout(cwd);
        return shot(o, { folder: projectFolder(m), cwd, out });
      }
      case 'timeline': {
        const { main: m } = checkout(cwd);
        if (o._[0] === 'import') {
          const r = importHistory({ main: m, stateDir: path.join(m, '.forge', 'state'), env });
          out(r.lines ? `imported ${r.lines} lines from ${r.sessions} session(s) and ${r.agents} agent(s), ${r.replies} model replies, ${r.from.slice(0, 16)} to ${r.to.slice(0, 16)}${r.cutoff ? ` (before the hooks' first line, ${r.cutoff.slice(0, 16)}; after it only tokens the hooks did not record)` : ''}: .forge/state/timeline-import.jsonl` : 'nothing to import: no Claude Code session logs for this checkout');
          return 0;
        }
        if (o.days !== undefined && !(Number(o.days) > 0)) throw new UsageError('forge timeline [<ticket>] [--days <n>] [--json | --csv]');
        const { project } = loadConfig(m, env);
        return timeline({ ticket: o._[0], days: o.days, json: o.json === true, csv: o.csv === true }, { stateDir: path.join(m, '.forge', 'state'), out, prices: project.prices });
      }
      case 'version': out(kitVersion()); return 0;
      default: {
        const lines = fs.readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(1);
        out(lines.slice(0, lines.findIndex((l) => !l.startsWith('//'))).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
        return cmd ? 1 : 0;
      }
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ApiError || e instanceof DesignError || e instanceof MergeError || e instanceof DocsError || e instanceof StarterError || e instanceof MetricsError || e instanceof ShotError || e instanceof AppError || e instanceof LimitsError || e instanceof LaneError || e instanceof LlmError) { process.stderr.write(`forge ${cmd}: ${e.message}\n`); failed(e.message); return 2; }
    throw e;
  }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
