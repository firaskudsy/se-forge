// forge merge <ticket>: the lead merges a finished ticket's MR/PR into the base branch (decision 75).
// It merges only when every check holds for the branch head on origin:
//   - the gates passed on that commit (recorded by forge gates or a finishing lane) and the tests rule holds;
//   - every review report in .forge/project/reviews/<ticket>/ passes (code, security and spec at least;
//     db, figma, qa and any other report present too) for that commit, or for an earlier one when the
//     commits since change only tests;
//   - the branch does not change the API contract (a person merges those);
//   - one open, ready MR/PR from the branch into the base branch, at that commit.
// The host is told the commit (glab --sha, gh --match-head-commit), so nothing pushed later is merged.
// Once merged, the ticket moves to Done and its issue closes (decision 118).
// In a system (decision 130), it merges in the repository the plan's Repo: names, with that repository's settings,
// and closes the issue on the system's board; a base branch that deploys on merge is left for a person (decision 133).
//
// forge merge <branch> (decision 148): the lead also merges the bootstrap's branches once the owner approved its review
// (chore/architecture, chore/bootstrap-contract, chore/starter) and a ticket's contract branch (chore/<n>-contract,
// from forge api apply). A contract branch changes only the contract and must pass forge api check at its head, a
// breaking change only with the owner's decision (--breaking-approved); once merged, forge merge tags the merge commit
// api-v<version> and pushes the tag. chore/architecture changes only documents; chore/starter needs green gates.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeContext, git, readState } from '../policy/lib/context.mjs';
import { testsCheck } from '../policy/lib/gates.mjs';
import { trackerEnv } from '../policy/lib/config.mjs';
import { matchAny } from '../policy/lib/paths.mjs';
import { readReport, PASSING } from '../policy/lib/reports.mjs';
import { memberOf, systemOf, deploysOn, repoOf } from '../policy/lib/system.mjs';
import { laneTarget, LaneError } from './lane.mjs';
import { checkAt, ApiError } from './api.mjs';

export { readReport };

export class MergeError extends Error {}

const TRACKER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../tracker/tracker.sh');

// A merged ticket is Done (decision 118). A failure is reported, never undoes the merge.
function closeTicket(ctx, ticket, note, cwd, env) {
  if (!/^\d+$/.test(String(ticket))) return `${ticket} is not a tracker issue number: no status to change`;
  const r = spawnSync('bash', [TRACKER, 'status', String(ticket), 'Done', '--comment', note], { cwd, encoding: 'utf8', env: { ...env, ...trackerEnv(ctx.project, env) } });
  if (r.status === 0) return `#${ticket} -> Done (its issue is closed)`;
  return `the tracker did not move #${ticket} (${((r.stderr || r.stdout || '').trim().split('\n').pop() || `exit ${r.status}`)}): run forge tracker status ${ticket} Done`;
}

const REQUIRED = ['code', 'security', 'spec'];

function branchFromPlan(ctx, ticket) {
  const dir = path.join(ctx.mainRoot, '.forge', 'project', 'plans');
  const plan = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).find((f) => f.startsWith(`${ticket}-`) && f.endsWith('.md'));
  if (!plan) return null;
  return /^Branch:\s*`?([^\s`]+)`?/mi.exec(fs.readFileSync(path.join(dir, plan), 'utf8'))?.[1] ?? null;
}

function run(cmd, args, cwd, env) {
  const r = spawnSync(cmd, args, { cwd, env, encoding: 'utf8' });
  if (r.error) throw new MergeError(`${cmd} is not available (${r.error.code}); install it and log in (${cmd} auth login)`);
  return { ok: r.status === 0, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}

// The open MR/PR from branch into base as { id, draft, sha }, or null.
function findRequest(host, branch, base, cwd, env) {
  if (host === 'github') {
    const r = run('gh', ['pr', 'list', '--head', branch, '--base', base, '--state', 'open', '--json', 'number,isDraft,headRefOid'], cwd, env);
    if (!r.ok) throw new MergeError(`gh pr list failed: ${r.err}`);
    const [pr] = JSON.parse(r.out || '[]');
    return pr ? { id: String(pr.number), draft: pr.isDraft, sha: pr.headRefOid } : null;
  }
  const r = run('glab', ['mr', 'list', '--source-branch', branch, '--target-branch', base, '--output', 'json'], cwd, env);
  if (!r.ok) throw new MergeError(`glab mr list failed: ${r.err}`);
  const [mr] = JSON.parse(r.out || '[]');
  return mr ? { id: String(mr.iid), draft: Boolean(mr.draft || mr.work_in_progress), sha: mr.sha } : null;
}

function hostMerge(host, id, sha, cwd, env) {
  return host === 'github'
    ? run('gh', ['pr', 'merge', id, '--merge', '--match-head-commit', sha], cwd, env)
    : run('glab', ['mr', 'merge', id, '--yes', '--sha', sha], cwd, env);
}

const SETUP = /^chore\/(architecture|bootstrap-contract|starter|(\d+)-contract)$/;
const DOCS = /(^|\/)(docs\/|README|CHANGELOG)|\.(md|mmd|svg|png)$/;

function ready(host, id, cwd, env) {
  return host === 'github' ? run('gh', ['pr', 'ready', id], cwd, env) : run('glab', ['mr', 'update', id, '--ready'], cwd, env);
}

// The bootstrap's branches and a ticket's contract branch (decision 148).
function mergeSetup(branch, { breakingApproved = false }, env, cwd, out) {
  const ctx = makeContext({ cwd }, env);
  if (memberOf(ctx.mainRoot)) throw new MergeError(`${branch}: in a system, a person merges it in its repository.`);
  const root = ctx.mainRoot;
  const base = ctx.config.branches.base;
  const kind = SETUP.exec(branch);
  const contract = kind[1] === 'bootstrap-contract' || Boolean(kind[2]);
  if (!git(root, ['fetch', '-q', 'origin', base, branch], 60000).ok) throw new MergeError(`git fetch origin ${base} ${branch} failed: is ${branch} pushed?`);
  const head = git(root, ['rev-parse', `origin/${branch}`]).out;
  const files = git(root, ['diff', '--name-only', `origin/${base}...origin/${branch}`]).out.split('\n').filter(Boolean);
  const problems = [];
  if (!files.length) problems.push(`${branch} changes nothing against ${base}`);
  // The bootstrap's branches go in on the owner's approval of its review, which the lead records in review.md.
  if (!kind[2]) {
    const review = path.join(root, '.forge', 'project', 'bootstrap', 'review.md');
    if (!/^\W*Approved\b/mi.test(fs.existsSync(review) ? fs.readFileSync(review, 'utf8') : '')) problems.push('the owner\'s approval of the bootstrap review is not recorded: once they approved, write "Approved: <date>, by the owner" at the top of .forge/project/bootstrap/review.md');
  }
  if (kind[1] === 'starter' && !readState(ctx, 'gates.json', {})[head]?.ok) problems.push(`gates have not passed on ${branch}@${head.slice(0, 8)} (forge gates on that commit)`);
  if (kind[1] === 'architecture') {
    const code = files.filter((f) => !DOCS.test(f));
    if (code.length) problems.push(`${branch} changes more than documents (${code.slice(0, 3).join(', ')}): code goes in a ticket`);
  }
  let version = null;
  if (contract) {
    const other = files.filter((f) => !matchAny(ctx.config.paths.contract, f));
    if (other.length) problems.push(`${branch} changes more than the contract (${other.slice(0, 3).join(', ')}): the rest goes in a ticket`);
    if (!other.length && files.length) {
      let c;
      try { c = checkAt(env, root, `origin/${branch}`); } catch (e) { if (e instanceof ApiError) throw new MergeError(e.message); throw e; }
      if (!c.ok) problems.push(`forge api check fails at ${head.slice(0, 8)}:\n${c.text.split('\n').slice(-6).map((l) => `    ${l}`).join('\n')}`);
      else if (c.breaking && !breakingApproved) problems.push('the contract has breaking changes: the owner decides how consumers move (ask them; once they agree, forge merge ' + branch + ' --breaking-approved)');
      version = c.version;
      if (version && git(root, ['rev-parse', '--verify', '-q', `refs/tags/api-v${version}`]).ok) problems.push(`api-v${version} exists already: raise info.version`);
    }
  }
  if (!problems.length) {
    const req = findRequest(ctx.project.host, branch, base, root, env);
    if (!req) problems.push(`no open MR/PR from ${branch} into ${base}`);
    else if (req.sha !== head) problems.push(`MR/PR ${req.id} is at ${String(req.sha).slice(0, 8)}, origin/${branch} at ${head.slice(0, 8)}: fetch and check again`);
    else {
      if (req.draft) {
        const r = ready(ctx.project.host, req.id, root, env);
        if (!r.ok) throw new MergeError(`MR/PR ${req.id} is a draft and could not be marked ready: ${r.err || r.out}`);
      }
      const r = hostMerge(ctx.project.host, req.id, head, root, env);
      if (!r.ok) throw new MergeError(`the host refused the merge of ${req.id}: ${r.err || r.out}`);
      out(`merged ${branch}@${head.slice(0, 8)} into ${base} (MR/PR ${req.id})`);
      if (version) {
        // The approved contract's tag, on the merge commit (decision 148).
        const fetched = git(root, ['fetch', '-q', 'origin', base], 60000);
        const at = fetched.ok ? git(root, ['rev-parse', `origin/${base}`]).out : '';
        const has = at && git(root, ['merge-base', '--is-ancestor', head, at]).ok;
        const tagged = has && git(root, ['tag', `api-v${version}`, at]).ok && git(root, ['push', '-q', 'origin', `refs/tags/api-v${version}`], 60000).ok;
        out(tagged ? `tagged api-v${version} on ${base}@${at.slice(0, 8)} and pushed it: API and UI work on it can start${kind[2] ? ` (put it on plan ${kind[2]}'s Contract: line)` : ''}` : `NOT TAGGED: tag api-v${version} on ${base} once the merge is there: forge merge ${branch} again does it`);
        return tagged ? 0 : 1;
      }
      return 0;
    }
  }
  out(`NOT MERGED: ${branch}@${head.slice(0, 8)} into ${base}\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return 1;
}

export function merge({ ticket, branch: given = null, breakingApproved = false }, env, cwd, out) {
  if (SETUP.test(String(ticket ?? ''))) return mergeSetup(String(ticket), { breakingApproved }, env, cwd, out);
  if (!ticket || !/^[\w.-]+$/.test(String(ticket))) throw new MergeError('forge merge <ticket> [--branch <name>] | <chore/architecture | chore/bootstrap-contract | chore/starter | chore/<n>-contract> [--breaking-approved]');
  let ctx = makeContext({ cwd }, env);
  const me = memberOf(ctx.mainRoot);
  let repoName = me?.repo ?? null;
  if (me && repoName === null) {
    // The workspace root: the ticket's repository.
    let t;
    try { t = laneTarget(ctx.mainRoot, ticket); } catch (e) { if (e instanceof LaneError) throw new MergeError(e.message); throw e; }
    repoName = t.repo.name;
    ctx = makeContext({ cwd: t.dir }, env);
  }
  const root = ctx.mainRoot;
  const base = ctx.config.branches.base;
  const branch = given || branchFromPlan(ctx, ticket);
  if (!branch) throw new MergeError(`No plan .forge/project/plans/${ticket}-*.md with a Branch: line; pass --branch <name>.`);
  if ([base, ...ctx.config.branches.promote, ...ctx.config.branches.protected].includes(branch)) throw new MergeError(`${branch} is not a ticket branch.`);
  const fetched = git(root, ['fetch', '-q', 'origin', base, branch], 60000);
  if (!fetched.ok) throw new MergeError(`git fetch origin ${base} ${branch} failed: ${fetched.err ?? ''}`.trim());
  const head = git(root, ['rev-parse', `origin/${branch}`]).out;
  const problems = [];

  if (!readState(ctx, 'gates.json', {})[head]?.ok) problems.push(`gates have not passed on ${branch}@${head.slice(0, 8)} (forge gates on that commit)`);
  const tests = testsCheck(ctx, root, branch, `origin/${branch}`);
  if (!tests.ok) problems.push(tests.reason);

  const files = git(root, ['diff', '--name-only', `origin/${base}...origin/${branch}`]).out.split('\n').filter(Boolean);
  const contract = files.filter((f) => matchAny(ctx.config.paths.contract, f));
  if (contract.length) problems.push(`the branch changes the API contract (${contract.join(', ')}): a person merges it (decision 29)`);

  const testGlobs = [...ctx.config.tests.sides.flatMap((s) => s.tests), ...ctx.config.tests.e2e.tests];
  const dir = path.join(root, '.forge', 'project', 'reviews', String(ticket));
  const present = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)) : [];
  for (const name of [...new Set([...REQUIRED, ...present])]) {
    const file = path.join(dir, `${name}.md`);
    if (!fs.existsSync(file)) { problems.push(`no ${name} review (.forge/project/reviews/${ticket}/${name}.md)`); continue; }
    const { verdict, commit } = readReport(fs.readFileSync(file, 'utf8'));
    if (!verdict || !PASSING.has(verdict)) { problems.push(`${name} review verdict is ${verdict ?? 'missing'}`); continue; }
    const reviewed = commit && git(root, ['rev-parse', '--verify', '-q', `${commit}^{commit}`]).out;
    if (!reviewed) { problems.push(`${name} review names no known commit (a "Commit: <sha>" line)`); continue; }
    if (reviewed === head) continue;
    if (!git(root, ['merge-base', '--is-ancestor', reviewed, head]).ok) { problems.push(`${name} review is of ${reviewed.slice(0, 8)}, which is not on ${branch}`); continue; }
    const since = git(root, ['diff', '--name-only', reviewed, head]).out.split('\n').filter(Boolean);
    const untested = since.filter((f) => !testGlobs.length || !matchAny(testGlobs, f));
    if (untested.length) problems.push(`${name} review is of ${reviewed.slice(0, 8)}; since then ${untested.slice(0, 3).join(', ')}${untested.length > 3 ? ', …' : ''} changed: review again`);
  }

  if (!problems.length) {
    const req = findRequest(ctx.project.host, branch, base, root, env);
    if (!req) problems.push(`no open MR/PR from ${branch} into ${base}`);
    else if (req.draft) problems.push(`MR/PR ${req.id} is a draft: mark it ready (the done check runs)`);
    else if (req.sha !== head) problems.push(`MR/PR ${req.id} is at ${String(req.sha).slice(0, 8)}, origin/${branch} at ${head.slice(0, 8)}: fetch and check again`);
    // Decision 133: merging into a branch that deploys is a person's, unless the system lets the lead merge there.
    const sys = me ? systemOf(root) : null;
    const deploys = sys ? deploysOn(sys, repoName, base) : [];
    const leadMay = (repoOf(sys, repoName)?.deploys ?? []).filter((d) => d.branch === base).every((d) => d.merge === 'lead');
    if (!problems.length && deploys.length && !leadMay) {
      out(`READY FOR A PERSON: ${branch}@${head.slice(0, 8)} passed every check, but merging into ${base} deploys to ${deploys.join(', ')} (decision 133).\nA person merges MR/PR ${req.id} in ${repoName}; the ticket closes when it is merged.`);
      return 3;
    }
    if (!problems.length) {
      const r = hostMerge(ctx.project.host, req.id, head, root, env);
      if (!r.ok) throw new MergeError(`the host refused the merge of ${req.id}: ${r.err || r.out}`);
      out(`merged ${branch}@${head.slice(0, 8)} into ${base} (MR/PR ${req.id})${r.out ? `\n${r.out}` : ''}`);
      out(closeTicket(ctx, ticket, `Merged into ${base}: ${branch}@${head.slice(0, 12)}, MR/PR ${req.id} (forge merge). Done (decision 118).`, root, env));
      return 0;
    }
  }
  out(`NOT MERGED: ${branch}@${head.slice(0, 8)} into ${base}\n${problems.map((p) => `- ${p}`).join('\n')}`);
  return 1;
}
