// Project configuration: <main worktree>/.forge/project/project.json, a link into the team repo
// (or $FORGE_CONFIG). Its "project" key holds the project's facts, its "policy" key the rules,
// "kit.version" the kit version the project pins. Values merge over the defaults below.
import fs from 'node:fs';
import { memberOf, deepMerge } from './system.mjs';
import path from 'node:path';

const ENGINEERS = ['frontend-engineer', 'mobile-engineer', 'backend-engineer', 'db-engineer', 'devops-engineer', 'qa-engineer'];
const READ_ONLY = ['code-reviewer', 'figma-ui-reviewer', 'scout', 'security-reviewer', 'spec-checker', 'db-reviewer', 'infra-reviewer', 'performance-reviewer', 'requirements-reviewer', 'owner-assistant'];
const DOCS_ONLY = ['planner', 'contract-analyst', 'product-analyst', 'designer', 'tracker-clerk', 'architect', 'project-manager'];

export const DEFAULTS = Object.freeze({
  // base: the branch tickets start from and merge into (decision 74: dev). promote: the branches work is
  // promoted to, in order, by a person (staging, then main for production). All of them are protected.
  branches: { base: 'dev', promote: ['staging', 'main'], protected: ['dev', 'staging', 'main', 'master'] },
  paths: {
    generated: [],
    protected: [],
    migrations: ['**/migrations/**', '**/Migrations/**', '**/alembic/versions/**', '**/prisma/migrations/**', '**/db/migrate/**'],
    sensitive: ['**/auth/**', '**/authentication/**', '**/authorization/**', '**/permissions/**', '**/payments/**', '**/billing/**'],
    adr: ['docs/adr/**'],
    // The API contract (OpenAPI spec) this repo owns; project.api.spec is added here.
    contract: [],
    ci: ['.github/workflows/**', '.gitlab-ci.yml', '.gitlab/ci/**'],
    cleanable: ['node_modules', 'dist', 'build', 'out', 'coverage', '.next', '.turbo', '.cache', 'bin', 'obj', 'target',
      '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.venv', 'tmp'],
    // The requirements panel's reports (decision 114) are reports too.
    reports: ['.forge/project/plans/**', '.forge/project/reviews/**', '.forge/project/bootstrap/panel/**', '.forge/handoffs/**'],
    docs: ['.forge/project/**', '.forge/handoffs/**'],
  },
  // scanner: "auto" uses gitleaks when installed, else the built-in patterns; "gitleaks" requires it.
  secrets: { allow: ['.env.example', '.env.sample', '.env.template', '.env.dist', '.env.schema'], extra: [], scanner: 'auto' },
  // readOnly roles write only paths.reports; docsOnly roles write only paths.docs. Both run inspection commands only.
  roles: { readOnly: READ_ONLY, docsOnly: DOCS_ONLY, readOnlyCommands: [] },
  // Checks run after each file edit; each rule is { glob, command, dir? }: {file} is the edited file, repo-relative,
  // and the command runs at the repo root; with dir (a service's folder in a repo holding several), both are
  // relative to that folder. The glob is always repo-relative.
  edits: { timeoutSec: 60, format: [], lint: [], typecheck: [] },
  // Commands the hook approves without a prompt (prefix match), on top of the gate commands. wrappers:
  // the project's scripts that run their arguments as a command (e.g. in a toolchain container); the
  // rules check the command inside, as they do for sudo or env.
  commands: { allow: [], wrappers: [] },
  // Checks the git pre-commit hook runs on staged files; each rule is { glob, command, dir? } and {files}
  // is the list of matching staged files.
  commit: { checks: [] },
  // Done needs tests (decision 50): for every side whose code the branch changes (code globs, minus
  // ignore), the branch must add or change a test (tests globs); and the plan's E2E: line either names
  // a flow (then the branch changes an end-to-end test and e2e.command passes) or says
  // "not applicable (<reason>)". Empty sides and e2e.tests: not enforced.
  tests: { sides: [], e2e: { tests: [], command: '' } },
  // Libraries the owner approved in the bootstrap's decision register (package names, no versions):
  // adding them does not ask again. Removing or updating dependencies still asks.
  deps: { approved: [] },
  network: { allowHosts: ['localhost', '127.0.0.1', '::1', '0.0.0.0'] },
  // MCP tools the agents may call, by tool-name prefix (mcp__<server>__), besides Figma's
  // (project.figma.toolPrefix). The hook refuses every other MCP tool (decision 91).
  mcp: { allow: [] },
  databases: { localHosts: ['localhost', '127.0.0.1', '::1', 'host.docker.internal'] },
  gates: {
    full: '',
    affected: '',
    timeoutSec: 900,
    agents: ENGINEERS,
    maxAttempts: 3,
    requirePushed: true,
    doneStatuses: ['In Testing', 'Done', 'Closed', 'Resolved'],
  },
  budget: { warn: 100000, block: 120000, leadWarn: 100000, maxCallsWithoutEdit: 25, engineers: ENGINEERS },
  // Per ticket, the circuit breaker (decision 127): past one of these the next engineer lane is refused and the
  // ticket is parked until a person lifts it (forge limits lift <ticket>).
  limits: { lanes: 4, blockerRounds: 2, qaFails: 2 },
  output: { heavy: [] },
  kit: {
    configPath: '.forge/project/project.json',
    codePaths: ['.claude/settings.json', '.claude/settings.local.json', '.githooks/**', '.forge/state/**', '.forge/kit/**'],
  },
});

export const PROJECT_DEFAULTS = Object.freeze({
  name: '',
  client: '',
  host: 'gitlab',
  tracker: 'gitlab',
  // A system's one board (decision 131): the GitLab or GitHub project ("group/board") every ticket lives in.
  board: '',
  // project.tracker "openproject": its non-secret settings (the API key never goes here; see openprojectEnv).
  // boards maps a name to a basic board's id (/projects/<identifier>/boards/<id>); board is the shorthand for a
  // single board; defaultBoard (a name or an id) is the board used without --board, else board, else the first.
  openproject: { url: '', project: '', board: '', boards: {}, defaultBoard: '', readyStatus: '' },
  stack: { frontend: '', mobile: '', backend: '', database: '', cloud: '', other: '' },
  storiesPath: '',
  // toolPrefix: Figma's Claude Code plugin (claude plugin install figma) registers its server as plugin:figma:figma.
  figma: { fileKey: '', rootNode: '0:1', toolPrefix: 'mcp__plugin_figma_figma__' },
  // spec: the OpenAPI file's path in the repo that owns it (this repo, or contractRepo when this repo only
  // consumes the contract). pin: the approved api-v<semver> tag this repo builds against.
  // generate: the client generator command; {spec} is replaced by the pinned spec (forge api generate).
  api: { spec: '', contractRepo: '', pin: '', generate: '', generatedDir: '', specEnv: 'OPENAPI_SPEC_URL' },
  // Where the look comes from (decision 49): kit (designed in Figma by the designer agent), figma, pdf or
  // images (provided by the client, in .forge/project/bootstrap/screens/), or empty before discovery.
  design: { source: '' },
  // The model for each role tier (forge sync renders the agents with it). Aliases or full model names.
  models: { fast: 'haiku', standard: 'sonnet', deep: 'opus' },
  // US dollars per million tokens, per model family (opus, sonnet, haiku, fable) or full model name, set by a
  // person from the provider's price list: forge timeline shows what the work would cost on the API (decision
  // 97). Empty: tokens only.
  prices: {},
  // The database for local work and tests: the container image, and the migration commands (they read
  // the connection from the variable named by urlEnv).
  db: { image: '', migrate: '', rollback: '', urlEnv: 'DATABASE_URL' },
  coAuthor: true,
  mode: 'light',
});

// The lead's auto-compact window (autoCompactWindow, which forge sync writes), within the 100k-1M Claude
// Code accepts (decision 93). Claude Code compacts well before the window's end, keeping room for its reply
// (at about 66k of a 100k window, measured), so the window sits 100k past the handover line: the lead is
// warned first and has room to bring its handover up to date.
// The trackers core/tracker/adapters/ has an adapter for (project.tracker, forge init --tracker).
export const TRACKERS = Object.freeze(['gitlab', 'github', 'openproject']);

export const leadCompactAt = (budget) => Math.min(1000000, Math.max(100000, budget.leadWarn + 100000));

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const RULE_LISTS = new Set(['edits.format', 'edits.lint', 'edits.typecheck', 'commit.checks']);
const isStrings = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');
const SIDE_LISTS = new Set(['tests.sides']);
const PRICE_KEYS = ['input', 'cacheWrite5m', 'cacheWrite1h', 'cacheRead', 'output'];
const isPrice = (x) => isObj(x) && Object.keys(x).length === PRICE_KEYS.length && PRICE_KEYS.every((k) => typeof x[k] === 'number' && x[k] >= 0);

const BOARD_ID = /^[1-9]\d*$/;
const isBoardId = (x) => (Number.isInteger(x) && x > 0) || (typeof x === 'string' && BOARD_ID.test(x));
// project.openproject: strings for url, project, readyStatus; board ids as numbers or digit strings (kept as strings).
function checkOpenproject(v, base, where, errors) {
  const out = { ...base, boards: {} };
  for (const [k, x] of Object.entries(v)) {
    if (k.startsWith('$')) continue;
    if (!(k in base)) errors.push(`unknown key ${where}.${k}`);
    else if (k === 'board') { if (x === '' || isBoardId(x)) out.board = String(x); else errors.push(`${where}.board must be a board id (the number in /boards/<id>)`); }
    else if (k === 'defaultBoard') { if (x === '' || isBoardId(x) || typeof x === 'string') out.defaultBoard = String(x); else errors.push(`${where}.defaultBoard must be a board name from ${where}.boards or a board id`); }
    else if (k === 'boards') {
      if (!isObj(x) || Object.entries(x).some(([n, id]) => !/^[A-Za-z][\w.-]*$/.test(n) || n === 'all' || !isBoardId(id))) errors.push(`${where}.boards must map a name (letters, digits, _ . -; not "all") to a board id, e.g. { "issues": 109, "frontend": 110 }`);
      else out.boards = Object.fromEntries(Object.entries(x).map(([n, id]) => [n, String(id)]));
    } else if (typeof x !== 'string') errors.push(`${where}.${k} must be a string`);
    else out[k] = x;
  }
  if (out.defaultBoard && !BOARD_ID.test(out.defaultBoard) && !(out.defaultBoard in out.boards)) errors.push(`${where}.defaultBoard "${out.defaultBoard}" is not a name in ${where}.boards`);
  return out;
}

// The environment the OpenProject adapter reads, from project.openproject; a variable already set wins.
export function openprojectEnv(project, env = process.env) {
  const o = project.openproject ?? PROJECT_DEFAULTS.openproject;
  const boards = o.boards ?? {};
  const def = o.defaultBoard ? (boards[o.defaultBoard] ?? o.defaultBoard) : o.board || '';
  const values = {
    OPENPROJECT_URL: o.url,
    OPENPROJECT_PROJECT: o.project,
    OPENPROJECT_BOARDS: Object.entries(boards).map(([n, id]) => `${n}=${id}`).join(','),
    OPENPROJECT_BOARD: def,
    OPENPROJECT_READY_STATUS: o.readyStatus,
  };
  return Object.fromEntries(Object.entries(values).filter(([k, x]) => x && !env[k]));
}

// The extra environment `forge tracker` (and forge merge) runs the adapter with.
export function trackerEnv(project, env = process.env) {
  const tracker = env.FORGE_TRACKER || project.tracker;
  // A system's one board (decision 131): every repository's tickets go to it.
  const repoVar = { github: 'GH_REPO', gitlab: 'GITLAB_REPO' }[project.tracker];
  return {
    FORGE_TRACKER: tracker,
    ...(project.board && repoVar ? { [repoVar]: project.board } : {}),
    ...(tracker === 'openproject' ? openprojectEnv(project, env) : {}),
  };
}

function merge(base, over, at, errors) {
  if (!isObj(over)) return base;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const where = at ? `${at}.${k}` : k;
    if (k.startsWith('$')) continue;
    if (!(k in base)) { errors.push(`unknown key ${where}`); continue; }
    const b = base[k];
    if (where === 'project.openproject') {
      if (!isObj(v)) { errors.push(`${where} must be an object`); continue; }
      out[k] = checkOpenproject(v, b, where, errors);
    } else if (where === 'project.prices') {
      if (!isObj(v) || Object.entries(v).some(([m, x]) => !/^[\w.:[\]-]+$/.test(m) || !isPrice(x))) errors.push(`${where} must map a model to { "input": n, "cacheWrite5m": n, "cacheWrite1h": n, "cacheRead": n, "output": n } in dollars per million tokens`);
      else out[k] = v;
    } else if (isObj(b)) {
      if (!isObj(v)) errors.push(`${where} must be an object`);
      else out[k] = merge(b, v, where, errors);
    } else if (SIDE_LISTS.has(where.replace(/^policy\./, ''))) {
      if (!Array.isArray(v) || v.some((x) => !isObj(x) || typeof x.name !== 'string' || !isStrings(x.code) || !isStrings(x.tests) || (x.ignore !== undefined && !isStrings(x.ignore)))) {
        errors.push(`${where} must be a list of { "name": "...", "code": [globs], "tests": [globs], "ignore": [globs] }`);
      } else out[k] = v;
    } else if (RULE_LISTS.has(where.replace(/^policy\./, ''))) {
      if (!Array.isArray(v) || v.some((x) => !isObj(x) || typeof x.glob !== 'string' || typeof x.command !== 'string')) errors.push(`${where} must be a list of { "glob": "...", "command": "..." }`);
      else if (v.some((x) => x.dir !== undefined && (typeof x.dir !== 'string' || !x.dir || x.dir.startsWith('/') || x.dir.split('/').includes('..')))) errors.push(`${where}: "dir" is a folder inside the repository, e.g. "backend"`);
      else out[k] = v;
    } else if (Array.isArray(b)) {
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) errors.push(`${where} must be a list of strings`);
      else out[k] = v;
    } else if (typeof b === 'number' && typeof v === 'string' && /^\d+$/.test(v)) {
      out[k] = Number(v); // templates write numbers as quoted placeholders so the file stays valid JSON
    } else if (typeof v !== typeof b) {
      errors.push(`${where} must be a ${typeof b}`);
    } else {
      out[k] = v;
    }
  }
  return out;
}

const TOP_KEYS = new Set(['$schema', 'kit', 'project', 'policy']);

// Returns { config, project, kitVersion, source, errors }. Unknown keys and wrong types are
// errors: the caller refuses write actions until the file is fixed. No file: safe defaults.
export function loadConfig(mainRoot, env = process.env) {
  const file = env.FORGE_CONFIG || path.join(mainRoot, DEFAULTS.kit.configPath);
  const fallback = { config: structuredClone(DEFAULTS), project: structuredClone(PROJECT_DEFAULTS), kitVersion: null, source: null, errors: [] };
  if (!fs.existsSync(file)) return fallback;
  const errors = [];
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return { ...fallback, source: file, errors: [`cannot parse: ${e.message}`] };
  }
  for (const k of Object.keys(raw ?? {})) if (!TOP_KEYS.has(k)) errors.push(`unknown key ${k}`);
  // A member repository of a system (decision 130): its own settings (repos/<repo>/project.json in the system's
  // team folder) over the system's.
  const member = env.FORGE_CONFIG ? null : memberOf(mainRoot);
  if (member?.repo) {
    const own = path.join(path.dirname(file), 'repos', member.repo, 'project.json');
    if (fs.existsSync(own)) {
      try {
        const over = JSON.parse(fs.readFileSync(own, 'utf8'));
        for (const k of Object.keys(over ?? {})) if (!['$schema', 'project', 'policy'].includes(k)) errors.push(`repos/${member.repo}/project.json: ${k === 'kit' ? 'the kit version is the system\'s, in its project.json' : `unknown key ${k}`}`);
        raw = deepMerge(raw ?? {}, { project: over?.project ?? {}, policy: over?.policy ?? {} });
      } catch (e) { errors.push(`repos/${member.repo}/project.json: cannot parse: ${e.message}`); }
    }
  }
  const config = merge(structuredClone(DEFAULTS), raw?.policy ?? {}, 'policy', errors);
  const project = merge(structuredClone(PROJECT_DEFAULTS), raw?.project ?? {}, 'project', errors);
  if (config.budget.warn >= config.budget.block) errors.push('policy.budget.warn must be below policy.budget.block');
  for (const k of ['lanes', 'blockerRounds', 'qaFails']) if (!Number.isInteger(config.limits?.[k]) || config.limits[k] < 1) errors.push(`policy.limits.${k} must be a whole number, 1 or more`);
  if (!['auto', 'gitleaks', 'builtin'].includes(config.secrets.scanner)) errors.push('policy.secrets.scanner must be auto, gitleaks or builtin');
  if (!['github', 'gitlab'].includes(project.host)) errors.push('project.host must be github or gitlab');
  if (project.tracker && !TRACKERS.includes(project.tracker)) errors.push(`project.tracker must be ${TRACKERS.join(', ')}`);
  if (!['light', 'full'].includes(project.mode)) errors.push('project.mode must be light or full');
  if (!['', 'kit', 'figma', 'pdf', 'images'].includes(project.design.source)) errors.push('project.design.source must be kit, figma, pdf or images');
  for (const [tier, model] of Object.entries(project.models)) if (!/^[\w.:[\]-]+$/.test(model)) errors.push(`project.models.${tier} must be a model name (e.g. sonnet, opus, claude-opus-5-5)`);
  // Project facts that the rules need, so they are written once.
  if (project.api.generatedDir) config.paths.generated = [...new Set([...config.paths.generated, project.api.generatedDir])];
  if (project.storiesPath) config.paths.protected = [...new Set([...config.paths.protected, project.storiesPath])];
  if (project.api.spec && !project.api.contractRepo) config.paths.contract = [...new Set([...config.paths.contract, project.api.spec])];
  if (project.api.pin && !/^api-v\d+\.\d+\.\d+$/.test(project.api.pin)) errors.push('project.api.pin must be a tag like api-v1.2.0');
  const kitVersion = typeof raw?.kit?.version === 'string' ? raw.kit.version : null;
  return { config, project, kitVersion, source: file, errors, member };
}
