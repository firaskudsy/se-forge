// Hook event handlers. Each takes the hook input and returns the JSON to print (or null).
import fs from 'node:fs';
import path from 'node:path';
import { makeContext, contextAt, systemRootOf } from './context.mjs';
import { checkMemberFile } from './rules/system.mjs';
import { resolvePath } from './paths.mjs';
import { combine, explain, deny, ask, HUMAN_MODES } from './decision.mjs';
import { checkBash } from './bash.mjs';
import { checkFileTool, WRITE_TOOLS } from './files.mjs';
import { laneFindings, laneAfterCall, laneTranscript, contextTokens } from './lanes.mjs';
import { verifyDone, laneStop } from './gates.mjs';
import { saveReminder } from './save.mjs';
import { isApproved, recordApproval } from './approvals.mjs';
import { parseShell } from './shell.mjs';
import { expand, base, cdTarget } from './bash.mjs';
import { splitGit, COMMIT_FLAGS } from './rules/git.mjs';
import { parseFlags } from './flags.mjs';
import { scanCommit } from './scan.mjs';
import { checkAfterEdit } from './edits.mjs';
import { roleFindings } from './roles.mjs';
import { autoAllowReason } from './allow.mjs';
import { mcpFindings } from './mcp.mjs';
import { laneDocuments } from './documents.mjs';
import { limitFindings } from './limits.mjs';
import { memberOf, agentLane, lanesIn, ticketTarget } from './system.mjs';
import { kitVersion, readKitFile, projectFacts } from './kit.mjs';
import { pacingState, pacingNote, pauseMessage } from './pacing.mjs';
import { record, noteCall, noteResult, noteEvent, clip, lastReply, sweepReplies } from './timeline.mjs';

const READ_ONLY_TOOLS = new Set(['Read', 'Grep', 'Glob', 'LS', 'NotebookRead', 'TodoWrite', 'TaskList', 'TaskGet', 'ToolSearch', 'AskUserQuestion']);
const READ_ONLY_CMDS = new Set(['ls', 'cat', 'head', 'tail', 'grep', 'rg', 'wc', 'pwd', 'echo', 'jq']);

// A plan named in a spawn prompt, with its Branch: and Gates: header lines.
const PLAN_REF = /(?:^|[\s"'`(])((?:[\w./~-]*\/)?plans\/[\w.-]+\.md)\b/;
// The asks a lane turns into a question for the lead instead of a prompt (decision 149), with what it does instead.
const PACKAGE = 'use only approved packages (policy.deps.approved), or stop here and put it in your report as a question for the owner (the package, why, and what you would use instead)';
const LANE_QUESTIONS = new Map([
  ['deps:change', PACKAGE],
  ['deps:image', PACKAGE],
  ['net:outside', 'work without it, or stop here and put it in your report as a question for the owner (the address and why; they can add the host to policy.network.allowHosts)'],
]);
const SECURITY = /security|auth|permission|payment|pii|personal/i;
const ARCHITECTURE = /architecture|stack/i;

// The gate names on a plan's Gates: line, without the notes in parentheses: "performance (… docs/architecture/
// nfr.md …)" is a performance gate only.
function gateNames(line) {
  let s = line;
  while (/\([^()]*\)/.test(s)) s = s.replace(/\([^()]*\)/g, ' ');
  return s.split('(')[0];
}

function planGates(input, ctx) {
  const m = PLAN_REF.exec(input.tool_input?.prompt || '');
  if (!m) return null;
  const file = [m[1], path.join(ctx.mainRoot, m[1]), path.join(ctx.cwd, m[1]), path.join(systemRootOf(ctx) ?? ctx.mainRoot, m[1])].find((p) => path.isAbsolute(p) && fs.existsSync(p));
  if (!file) return null;
  const text = fs.readFileSync(file, 'utf8').slice(0, 4000);
  const gates = (/^Gates:\s*(.+)$/mi.exec(text)?.[1] || 'none').replace(/[`*]/g, '').trim();
  const branch = /^Branch:\s*`?([^\s`]+)`?/mi.exec(text)?.[1] || null;
  const contract = (/^Contract:\s*(.+)$/mi.exec(text)?.[1] || 'none').replace(/[`*]/g, '').trim();
  const repo = /^Repo:\s*`?([^\s`]+)`?/mi.exec(text)?.[1] || null;
  return { file, gates, branch, contract, repo };
}

// At a system's workspace root (decision 130), an engineer works in its ticket's lane: the prompt names it, in the
// repository the plan's Repo: line names. The lane's context is the one the contract is checked in.
function systemLane(input, plan, type, ctx) {
  const ws = systemRootOf(ctx);
  if (!ws) return { findings: [], at: ctx };
  const lane = lanesIn(input.tool_input?.prompt, ws)[0];
  const open = `forge lane open ${/^(\d+)-/.exec(path.basename(plan?.file ?? ''))?.[1] ?? '<ticket>'}`;
  if (!lane) return { findings: [deny('lane:none', `In a system, ${type} works in its ticket's lane: run \`${open}\` and name the lane's path in the prompt (cd there first, work only there).`)], at: ctx };
  const at = makeContext({ ...input, cwd: lane }, ctx.env);
  const repo = memberOf(at.mainRoot)?.repo;
  if (plan?.repo && repo !== plan.repo) return { findings: [deny('lane:repo', `${path.basename(plan.file)} changes ${plan.repo}, but the lane ${lane} is in ${repo}: one ticket, one repository (decision 131). Run \`${open}\`.`)], at };
  return { findings: [], at };
}

// Contract first: API, UI and mobile work start only on an approved contract version, which exists as an
// api-v<semver> tag in this repo or is the version the project pins (project.api.pin).
const CONTRACT_BUILDERS = new Set(['backend-engineer', 'frontend-engineer', 'mobile-engineer']);
function contractFindings(plan, type, ctx) {
  if (!CONTRACT_BUILDERS.has(type) || /^none\b/i.test(plan.contract)) return [];
  const name = path.basename(plan.file);
  const version = /\bapi-v\d+\.\d+\.\d+\b/.exec(plan.contract)?.[0];
  if (!version) return [deny('contract:unapproved', `Plan ${name} has Contract: ${plan.contract}. ${type} starts only on an approved contract version: a person merges the contract's merge request and tags it api-v<semver>, then the plan names that tag.`)];
  const tagged = ctx.git(['rev-parse', '-q', '--verify', `refs/tags/${version}`]).ok;
  if (tagged || ctx.project.api.pin === version) return [];
  return [deny('contract:unapproved', `Plan ${name} builds against ${version}, which is not approved here: no such tag in this repo${ctx.project.api.pin ? `, and the project pins ${ctx.project.api.pin}` : ''}. A person tags the approved contract (and sets project.api.pin where the contract lives in another repo), then fetch the tags.`)];
}

// Engineers run on the model forge sync rendered for their tier (decision 94): a spawn's model= that differs
// is refused, so the lead cannot move implementation to a costlier model. Aliases compare by family.
const FAMILIES = ['opus', 'sonnet', 'haiku', 'fable'];
const family = (m) => FAMILIES.find((f) => String(m).toLowerCase().includes(f)) ?? String(m).toLowerCase();
function modelFindings(input, type, ctx) {
  const asked = input.tool_input?.model;
  if (!asked) return [];
  let rendered = null;
  try { rendered = /^model:\s*(\S+)/m.exec(fs.readFileSync(path.join(ctx.mainRoot, '.claude', 'agents', `${type}.md`), 'utf8'))?.[1] ?? null; } catch { /* not rendered here */ }
  const own = rendered ?? ctx.project.models.standard;
  if (family(asked) === family(own)) return [];
  return [deny('models:tier', `${type} runs on its own model (${own}), not ${asked}: spawn it without model=. Opus judgment comes from the planner and the security reviewer.`)];
}

function spawnFindings(input, ctx) {
  const type = String(input.tool_input?.subagent_type || '').replace(/^.*:/, '');
  if (!ctx.config.budget.engineers.includes(type)) return [];
  const out = [...modelFindings(input, type, ctx)];
  const plan = planGates(input, ctx);
  const lane = systemLane(input, plan, type, ctx);
  out.push(...lane.findings);
  if (!plan) return out;
  const names = gateNames(plan.gates);
  if (!/^none$/i.test(plan.gates) && SECURITY.test(names) && !isApproved(ctx, 'security', plan.branch)) {
    out.push(ask('gate:security', `Plan ${path.basename(plan.file)} is tagged "${plan.gates}". A human approves before a lane implements it on ${plan.branch ?? 'its branch'}: ask the owner in writing and hold the ticket; they approve with ! forge approve <ticket> (decision 149).`, { gate: 'security', record: true, branch: plan.branch }));
  }
  if (ARCHITECTURE.test(names) && !isApproved(ctx, 'architecture', plan.branch)) out.push(ask('gate:architecture', `Plan ${path.basename(plan.file)} changes the architecture or stack ("${plan.gates}"). A human approves it: ask the owner in writing and hold the ticket; they approve with ! forge approve <ticket> (decision 149).`, { gate: 'architecture', record: true, branch: plan.branch }));
  out.push(...contractFindings(plan, type, lane.at));
  return out;
}

function readOnlyCall(input) {
  if (READ_ONLY_TOOLS.has(input.tool_name)) return true;
  if (input.tool_name !== 'Bash') return false;
  return parseShell(input.tool_input?.command || '').every((c) => c.redirects.every((r) => r.op === '<' || r.target === '/dev/null')
    && (READ_ONLY_CMDS.has(c.argv[0]) || (c.argv[0] === 'git' && ['status', 'diff', 'log', 'show', 'branch'].includes(c.argv[1]))));
}

// `git commit` anywhere in the call: scan what it would add, including paths staged by the same call.
// The commit runs in the folder after any `cd` before it (a system's lane, decision 130).
function commitScan(input, ctx) {
  let here = ctx.cwd;
  const cmds = expand(parseShell(input.tool_input?.command || ''), 0, ctx.config.commands.wrappers)
    .map((c) => { if (base(c.argv[0]) === 'cd') here = cdTarget(here, c.argv[1], ctx); return { ...c, here: here ?? ctx.cwd }; })
    .filter((c) => base(c.argv[0]) === 'git');
  const commits = cmds.filter((c) => splitGit(c.argv).sub === 'commit' && !c.argv.includes('--dry-run'));
  if (!commits.length) return [];
  const paths = [];
  for (const c of cmds) {
    const g = splitGit(c.argv);
    if (g.sub === 'add') paths.push(...parseFlags(g.args, { longValue: ['--chmod', '--pathspec-from-file'] }).positional);
    if (g.sub === 'commit') paths.push(...parseFlags(g.args, COMMIT_FLAGS).positional);
  }
  const dir = splitGit(commits[0].argv).dir;
  const where = dir ? path.resolve(commits[0].here, dir) : commits[0].here;
  return scanCommit(contextAt(ctx, where), where, paths);
}

// A file tool's call, with its path made absolute, and the context of the repository the file is in: another one than
// the call's for an agent at a system's workspace root writing in a member repository's lane (decision 130).
function fileCall(input, ctx) {
  const ti = input.tool_input ?? {};
  const key = ti.file_path !== undefined ? 'file_path' : ti.notebook_path !== undefined ? 'notebook_path' : null;
  if (!key || typeof ti[key] !== 'string') return { input, ctx };
  const abs = resolvePath(ti[key], ctx.cwd, ctx.home);
  return { input: { ...input, tool_input: { ...ti, [key]: abs } }, ctx: contextAt(ctx, path.dirname(abs)) };
}

function allFindings(input, ctx) {
  const f = fileCall(input, ctx);
  const findings = [...roleFindings(f.input, f.ctx), ...laneFindings(input, ctx), ...checkMemberFile(input, f.ctx, ctx, WRITE_TOOLS.has(input.tool_name))];
  if (input.tool_name === 'Bash') findings.push(...checkBash(input.tool_input?.command ?? '', ctx));
  findings.push(...checkFileTool(f.input, f.ctx));
  findings.push(...mcpFindings(input, ctx));
  if (input.tool_name === 'Agent' || input.tool_name === 'Task') findings.push(...spawnFindings(input, ctx), ...limitFindings(input, ctx));
  if (!ctx.agentId && ['Agent', 'Task', 'Workflow'].includes(input.tool_name)) {
    const pace = pacingState(ctx);
    if (pace.level === 'red') findings.push(deny('pacing:pause', pauseMessage(pace)));
  }
  return findings;
}

const preOutput = (decision, reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason } });

// FORGE_DEBUG=1 appends one line per hook call to .forge/state/debug.log (paths and numbers only).
function debug(ctx, event, extra) {
  if (ctx.env.FORGE_DEBUG !== '1') return;
  const file = laneTranscript(ctx.input);
  const line = { at: new Date().toISOString(), event, tool: ctx.input.tool_name, agent: ctx.agentType, transcript: file, exists: file ? fs.existsSync(file) : null, tokens: contextTokens(file), ...extra };
  fs.mkdirSync(ctx.stateDir, { recursive: true });
  fs.appendFileSync(path.join(ctx.stateDir, 'debug.log'), `${JSON.stringify(line)}\n`);
}

export function preToolUse(input, env) {
  const ctx = makeContext(input, env);
  debug(ctx, 'pre');
  const out = decide(input, ctx);
  noteCall(ctx, out);
  return out;
}

function decide(input, ctx) {
  const node = Number(process.versions.node.split('.')[0]);
  if (node < 22 && !readOnlyCall(input)) {
    return preOutput('deny', `[kit:node] The safety hooks need Node 22 or newer; this machine runs ${process.versions.node}. Agents may only read until Node is upgraded.`);
  }
  if (ctx.kitVersion && ctx.kitVersion !== kitVersion() && !readOnlyCall(input)) {
    return preOutput('deny', `[kit:version] This project pins se-forge ${ctx.kitVersion}; this checkout runs ${kitVersion()}. Agents may only read until a human runs forge sync.`);
  }
  if (ctx.configErrors.length && !readOnlyCall(input)) {
    return preOutput('deny', `[kit:config] The policy config ${ctx.configSource} is invalid (${ctx.configErrors.join('; ')}). Agents may only read until a human fixes it.`);
  }
  let findings = allFindings(input, ctx);
  const dones = findings.filter((f) => f.decision === 'done');
  findings = findings.filter((f) => f.decision !== 'done');
  // Every done claim in the command is checked (two tickets joined by && are two claims), until the first refusal.
  const claims = [...new Map(dones.map((d) => [`${d.cwd}|${d.branch}|${d.ticket}`, d])).values()];
  for (const d of findings.some((f) => f.decision === 'deny') ? [] : claims) {
    const where = d.cwd === undefined ? ctx.cwd : d.cwd;
    if (where === null || !fs.existsSync(where)) {
      findings.push(deny('gates:done', `${d.reason} The command moves to a folder the hook cannot read (\`cd\` with a variable, or a folder that does not exist), so the claim cannot be checked. Run it from the project's folder.`));
      break;
    }
    let at = where === ctx.cwd ? ctx : makeContext({ ...ctx.input, cwd: where }, ctx.env);
    let dir = where;
    // At a system's workspace root, a ticket is done in the repository its plan names (decision 130).
    const ws = d.ticket ? systemRootOf(at) : null;
    const t = ws ? ticketTarget(ws, d.ticket) : null;
    if (t?.dir && fs.existsSync(t.dir)) { dir = t.dir; at = makeContext({ ...ctx.input, cwd: dir }, ctx.env); }
    const r = verifyDone(at, dir, d.branch, d.ticket);
    if (r.ok) continue;
    // A ticket with no branch at all (its work is in the team repo or a setting) has no gates to check: the
    // lead asks the person instead (decision 116). An agent is still refused.
    findings.push(r.noBranch && !ctx.agentId ? ask('gates:done', `${d.reason} ${r.reason}`) : deny('gates:done', `${d.reason} ${r.reason}`));
    if (!r.noBranch) break;
  }
  if (input.tool_name === 'Bash' && !findings.some((f) => f.decision === 'deny')) findings.push(...commitScan(input, ctx));
  let result = combine(findings);
  // A lane never waits on a person for a package or an outside address (decision 149): it is refused with what to do,
  // the lead asks the owner in writing and holds the ticket, and the owner's ! forge approve <ticket> --package <name>
  // approves a package.
  if (result.decision === 'ask' && ctx.agentId && result.findings.every((f) => LANE_QUESTIONS.has(f.rule))) {
    result = { decision: 'deny', findings: result.findings.map((f) => ({ ...f, reason: `${f.reason} A lane does not wait for the owner (decision 149): ${LANE_QUESTIONS.get(f.rule)}; the lead asks them and holds the ticket.` })) };
  }
  if (result.decision === 'ask' && !HUMAN_MODES.has(ctx.permissionMode)) {
    result = { decision: 'deny', findings: result.findings.map((f) => ({ ...f, reason: `${f.reason} This needs a human approval, which cannot be given in ${ctx.permissionMode} mode.` })) };
  }
  if (result.decision === 'allow') {
    const why = input.tool_name === 'Bash' && autoAllowReason(input.tool_input?.command, ctx);
    return why ? preOutput('allow', `[allow:project] ${why}`) : null;
  }
  return preOutput(result.decision, explain(result));
}

export function postToolUse(input, env) {
  const ctx = makeContext(input, env);
  noteResult(ctx, false);
  // A gated call that ran in a mode where asks reach a person was approved by that person.
  if (HUMAN_MODES.has(ctx.permissionMode) && (WRITE_TOOLS.has(input.tool_name) || ['Bash', 'Agent', 'Task'].includes(input.tool_name))) {
    for (const f of allFindings(input, ctx)) {
      if (f.decision === 'ask' && f.record) recordApproval(ctx, f.gate, f.branch ?? ctx.branch(), { tool: input.tool_name, rule: f.rule });
    }
  }
  const msg = [laneAfterCall(input, ctx), pacingNote(ctx, pacingState(ctx))].filter(Boolean).join('\n') || null;
  const f = fileCall(input, ctx);
  const failed = WRITE_TOOLS.has(input.tool_name) ? checkAfterEdit(f.input, f.ctx) : null;
  if (!msg && !failed) return null;
  const out = {};
  if (failed) Object.assign(out, { decision: 'block', reason: failed });
  if (msg) out.hookSpecificOutput = { hookEventName: 'PostToolUse', additionalContext: msg };
  return out;
}

export function postToolUseFailure(input, env) {
  noteResult(makeContext(input, env), true);
  return null;
}

// The events that only go into the timeline (prompts, compaction, session end, API errors, auto-mode denials, Claude
// Code's notifications).
export function note(input, env) {
  noteEvent(makeContext(input, env));
  return null;
}

export function subagentStop(input, env) {
  const ctx = makeContext(input, env);
  // At a system's workspace root an agent works in the lane its prompt names (decision 130): the gates are that
  // worktree's, and its documents come back to the root, where the lead reads them.
  const ws = systemRootOf(ctx);
  const lane = ws ? agentLane(laneTranscript(input), ws) : null;
  const at = lane ? makeContext({ ...input, cwd: lane }, env) : ctx;
  const documents = laneDocuments(lane ? { ...at, mainRoot: ws } : ctx);
  debug(ctx, 'stop', { root: at.root, documents });
  const out = laneStop(lane ? { ...input, cwd: lane } : input, at);
  const reply = { ...lastReply(ctx), ...(lane ? { repo: memberOf(at.mainRoot)?.repo ?? undefined } : {}) };
  if (out?.decision === 'block') record(ctx, 'agent.sent-back', { why: clip(out.reason), ...reply });
  else record(ctx, out?.systemMessage ? 'agent.gates-failed' : 'agent.stop', { context: contextTokens(laneTranscript(input)) ?? undefined, documents: documents.length || undefined, why: clip(out?.systemMessage), ...reply });
  sweepReplies(ctx);
  return out;
}

// The lead's turn ends: it waits for a person, unless the save reminder sends it back.
export function stop(input, env) {
  const ctx = makeContext(input, env);
  const out = saveReminder(input, ctx);
  if (!ctx.agentId) {
    record(ctx, out ? 'turn.sent-back' : 'turn.end', { ...(out ? { rule: 'save', why: clip(out.reason) } : {}), ...lastReply(ctx) });
    sweepReplies(ctx);
  }
  return out;
}

// Warnings about this machine and project, shared by both injections.
function warnings(ctx) {
  const out = [];
  if (Number(process.versions.node.split('.')[0]) < 22) out.push(`WARNING: Node ${process.versions.node} is older than 22; agents may only read until it is upgraded.`);
  if (ctx.kitVersion && ctx.kitVersion !== kitVersion()) out.push(`WARNING: this project pins se-forge ${ctx.kitVersion}; this checkout runs ${kitVersion()}. Agents may only read until a human runs forge sync.`);
  if (ctx.configErrors.length) out.push(`WARNING: the project config is invalid (${ctx.configErrors.join('; ')}). Agents may only read until a human fixes it.`);
  if (ctx.configSource && !ctx.config.gates.full) out.push('WARNING: no gate command (policy.gates.full) is configured, so no work can be marked done.');
  const pace = pacingState(ctx);
  if (pace.level === 'red') out.push(`WARNING [pacing:pause]: ${pauseMessage(pace)}`);
  if (pace.level === 'amber') out.push(`[pacing] Plan usage: ${pace.text}. Finish what is running, prefer reviews and QA, start nothing large.`);
  return out;
}

const k = (n) => `${Math.round(n / 1000)}k`;

// The project's own extra rules, kept in the team repo next to its overrides.
function projectRules(ctx) {
  try {
    const text = fs.readFileSync(path.join(ctx.mainRoot, '.forge', 'project', 'kit', 'rules.md'), 'utf8').trim();
    return text ? `# Project rules\n\n${text}` : '';
  } catch {
    return '';
  }
}

// SessionStart: the shared rules, the project's facts and pending handovers, injected into the
// lead's context. Nothing is written into the client repo.
export function sessionStart(input, env) {
  const ctx = makeContext(input, env);
  noteEvent(ctx);
  if (!ctx.configSource) {
    return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'se-forge hooks are wired here, but the project is not linked: run `forge init` (see `forge doctor`). Until then the safety rules use their defaults.' } };
  }
  const { warn, block, leadWarn } = ctx.config.budget;
  const head = [`se-forge ${kitVersion()} is active. Lanes hand over at ${k(warn)} context and stop at ${k(block)}; the lead hands over at ${k(leadWarn)}.`, ...warnings(ctx)];
  const handoffs = [path.join(ctx.mainRoot, '.forge', 'handoffs')]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d).filter((f) => /-handover\.md$/.test(f)).map((f) => path.join(d, f)))
    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
    .slice(0, 5)
    .map((f) => path.relative(ctx.mainRoot, f));
  if (handoffs.length) head.push(`Pending handovers (newest first): ${handoffs.join(', ')}. Read the relevant one before starting; resume with the handover skill.`);
  if (['clear', 'compact', 'resume'].includes(input.source)) head.unshift(`RESUME (${input.source}): read the newest handover, check git status and the branch, then carry on from "Remaining".`);
  const changed = kitChange(ctx);
  if (changed) head.unshift(changed);
  // A checkout whose project moved to another machine (forge export, decision 151) starts nothing.
  const moved = path.join(ctx.mainRoot, '.forge', 'state', 'exported.json');
  if (fs.existsSync(moved)) head.unshift(`MOVED: this project was exported on ${(/"at":\s*"([^"]{16})/.exec(fs.readFileSync(moved, 'utf8'))?.[1] ?? 'an earlier date').replace('T', ' ')} UTC (forge export) and runs on another machine now. Start nothing here: no agent, ticket or merge. Tell the owner; forge import <file> brings it back.`);
  // The main session also gets the lead's own rules: how it asks the owner (decision 136). Lanes never do.
  const text = [head.join('\n'), readKitFile('core/AGENTS.md').trim(), readKitFile('core/LEAD.md').trim(), projectRules(ctx), projectFacts(ctx)].filter(Boolean).join('\n\n');
  return { hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } };
}

// The lead's handover names the kit version whose skills it follows (`Kit: <version>`). When the active kit is
// another one, the handover may carry rules the kit has changed since (decision 121).
function kitChange(ctx) {
  const file = path.join(ctx.mainRoot, '.forge', 'handoffs', 'lead-handover.md');
  if (!fs.existsSync(file)) return null;
  const written = /^\W*Kit\W*:?\W*(?:se-forge\s+)?(\d+\.\d+\.\d+[\w.-]*)/mi.exec(fs.readFileSync(file, 'utf8').slice(0, 4000))?.[1] ?? null;
  const now = kitVersion();
  if (written === now) return null;
  return `KIT CHANGED: .forge/handoffs/lead-handover.md was written for se-forge ${written ?? 'an older version (no Kit: line)'}; ${now} is active now. Before acting on the handover, read what changed (.forge/kit/CHANGELOG.md, the sections after ${written ?? 'the version the project pinned before'}) and re-read the skills you follow (the lead: .claude/skills/pipeline/SKILL.md). Where the handover's rules disagree with a skill, follow the skill: rules come from the kit; the handover keeps the state and the owner's own orders. Then set its first line to "Kit: ${now}".`;
}

// An agent of a system's workspace root starts at the root, not in a worktree (decision 130).
const SYSTEM_LANE = 'SYSTEM: you start at the system\'s workspace root. Work only in the lane your task names (<workspace>/<repo>/.claude/worktrees/<name>): begin every shell command with `cd <lane> && `, and give files their absolute path inside the lane. Never change the workspace root or a repository\'s main checkout.';

// The skills Claude Code loaded into an agent before its first turn (decision 137): its agent file's `skills:` list,
// as forge sync rendered it. The timeline keeps them, since a preloaded skill makes no Skill call to record.
function preloadedSkills(ctx, type) {
  if (!/^[\w-]+$/.test(String(type || ''))) return undefined;
  try {
    const front = /^---\n([\s\S]*?)\n---/.exec(fs.readFileSync(path.join(ctx.mainRoot, '.claude', 'agents', `${type}.md`), 'utf8'))?.[1] ?? '';
    const list = (/^skills:[ \t]*\n((?:[ \t]+-[^\n]*(?:\n|$))+)/m.exec(front)?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean);
    return list.length ? list : undefined;
  } catch { return undefined; }
}

// SubagentStart: every lane gets the shared rules, the lane rules and the project's facts,
// also inside a worktree where no project files exist.
export function subagentStart(input, env) {
  const ctx = makeContext(input, env);
  record(ctx, 'agent.start', { skills: preloadedSkills(ctx, input.agent_type) });
  if (!ctx.configSource) return null;
  const system = systemRootOf(ctx) ? SYSTEM_LANE : '';
  const text = [...warnings(ctx), system, readKitFile('core/AGENTS.md').trim(), readKitFile('core/LANES.md').trim(), projectRules(ctx), projectFacts(ctx)].filter(Boolean).join('\n\n');
  return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: text } };
}

// `forge-hook gates`: run the done check on the current branch (for people and for light mode).
export function gatesCommand(env, cwd = process.cwd()) {
  const ctx = makeContext({ cwd }, env);
  return verifyDone(ctx, cwd);
}
