// gh and glab: merges, approvals, host settings and secrets are for humans;
// opening a ready PR/MR counts as "done" and needs green gates.
import { deny, ask } from '../decision.mjs';
import { parseFlags, has } from '../flags.mjs';

const done = (rule, reason, branch) => ({ decision: 'done', rule, reason, branch });

// API endpoints that change protection, merges, approvals, secrets, access or deployments.
const SENSITIVE_API = /\/(merge|merges|approve|approvals|unapprove)\b|\/protection\b|\/rulesets?\b|\/protected_(branches|tags|environments)|\/environments\b|\/(actions\/)?(secrets|variables)\b|\/collaborators\b|\/members\b|\/hooks\b|\/(deploy_)?keys\b/;

function api(argv, tool) {
  const f = parseFlags(argv.slice(2), { shortValue: 'XfFHqtp', longValue: ['--method', '--field', '--raw-field', '--header', '--input', '--jq', '--template', '--hostname', '--cache', '--preview'] });
  const method = String(f.short.get('X') || f.long.get('--method') || (has(f, 'fF', ['--field', '--raw-field', '--input']) ? 'POST' : 'GET')).toUpperCase();
  if (method === 'GET' || method === 'HEAD') return [];
  const endpoint = f.positional[0] || '';
  if (SENSITIVE_API.test(endpoint)) return [deny(`${tool}:api`, `\`${tool} api ${method} ${endpoint}\` changes merges, approvals, protection, secrets or access. That is for a human.`)];
  return [ask(`${tool}:api`, `\`${tool} api ${method} ${endpoint}\` changes data on the Git host.`)];
}

// Short options that take a value differ per gh subcommand (-a is --approve for "pr review"
// but --assignee for "pr create"), so each one gets its own spec.
const GH_SPECS = {
  'pr create': { shortValue: 'BbtFHRrlmaAp', longValue: ['--base', '--head', '--title', '--body', '--body-file', '--repo', '--label', '--assignee', '--reviewer', '--milestone', '--project', '--template'] },
  'pr review': { shortValue: 'bFR', longValue: ['--body', '--body-file', '--repo'] },
  'auth status': { shortValue: 'h', longValue: ['--hostname'] },
};

export function checkGh(argv) {
  const [, group, verb] = argv;
  const key = `${group} ${verb ?? ''}`.trim();
  const f = parseFlags(argv.slice(3), GH_SPECS[key] || { shortValue: 'R', longValue: ['--repo'] });
  if (group === 'api') return api(argv, 'gh');
  if (key === 'pr merge') return [deny('gh:merge', 'The lead merges a finished ticket into dev with `forge merge <ticket>`, which checks gates, reviews and the contract first; staging and main are merged by a person.')];
  if (key === 'pr review' && has(f, 'a', ['--approve'])) return [deny('gh:approve', 'Agents never approve pull requests.')];
  if (group === 'secret' || (group === 'variable' && verb !== 'list')) return [deny('gh:secrets', 'Repository secrets and variables are managed by humans.')];
  if (group === 'repo' && ['delete', 'archive', 'unarchive', 'rename', 'edit', 'transfer'].includes(verb)) return [deny('gh:repo-settings', 'Repository settings are managed by humans.')];
  if (group === 'auth' && (verb === 'token' || has(f, 't', ['--show-token']))) return [deny('gh:token', 'Never print a token.')];
  if (group === 'release' && ['create', 'delete', 'edit', 'upload', 'delete-asset'].includes(verb)) return [ask('gh:release', 'Releases can start deploy pipelines.')];
  if ((group === 'workflow' && ['run', 'enable', 'disable'].includes(verb)) || (group === 'run' && verb === 'rerun')) return [ask('gh:workflow', 'Running workflows can deploy or change infrastructure.')];
  if (key === 'pr create' && !has(f, 'd', ['--draft'])) return [done('gates:done', 'Opening a ready pull request means the work is done.', f.short.get('H') || f.long.get('--head') || null)];
  if (key === 'pr ready' && !f.long.has('--undo')) return [done('gates:done', 'Marking a pull request ready means the work is done.', null)];
  return [];
}

export function checkGlab(argv) {
  const [, group, verb] = argv;
  const f = parseFlags(argv.slice(3), { shortValue: 'tdlabsSmRF', longValue: ['--title', '--description', '--source-branch', '--target-branch', '--label', '--assignee', '--reviewer', '--milestone', '--repo'] });
  const key = `${group} ${verb ?? ''}`.trim();
  if (group === 'api') return api(argv, 'glab');
  if (key === 'mr merge') return [deny('glab:merge', 'The lead merges a finished ticket into dev with `forge merge <ticket>`, which checks gates, reviews and the contract first; staging and main are merged by a person.')];
  if (key === 'mr approve') return [deny('glab:approve', 'Agents never approve merge requests.')];
  if (group === 'variable' || (key === 'ci get' && argv.includes('--with-variables'))) return [deny('glab:secrets', 'CI/CD variables are managed by humans and may hold secrets.')];
  if (group === 'repo' && ['delete', 'archive', 'transfer', 'update'].includes(verb)) return [deny('glab:repo-settings', 'Project settings are managed by humans.')];
  if (group === 'auth' && has(f, 't', ['--show-token'])) return [deny('glab:token', 'Never print a token.')];
  if (group === 'release' && ['create', 'delete', 'upload'].includes(verb)) return [ask('glab:release', 'Releases can start deploy pipelines.')];
  if ((group === 'ci' || group === 'pipeline') && ['run', 'retry', 'trigger'].includes(verb)) return [ask('glab:pipeline', 'Running pipelines can deploy or change infrastructure.')];
  if (key === 'mr create' && !has(f, '', ['--draft', '--wip'])) return [done('gates:done', 'Opening a ready merge request means the work is done.', f.short.get('s') || f.long.get('--source-branch') || null)];
  if (key === 'mr update' && f.long.has('--ready')) return [done('gates:done', 'Marking a merge request ready means the work is done.', null)];
  return [];
}

// forge merge (decision 75) is the lead's: lanes, reviewers and the other agents never merge.
export function checkForgeMerge(c, a0, ctx) {
  if (a0 !== 'forge' || c.argv[1] !== 'merge' || !ctx.agentId) return [];
  return [deny('forge:merge', 'Only the lead merges, with `forge merge`, after the review pass. Report that the branch is ready instead.')];
}

// forge lane (system mode, decision 130) is the lead's: it gives each agent its worktree.
export function checkForgeLane(c, a0, ctx) {
  if (a0 !== 'forge' || c.argv[1] !== 'lane' || !ctx.agentId) return [];
  return [deny('forge:lane', 'Only the lead opens and closes lanes (forge lane). Work in the worktree the lead gave you.')];
}

// forge limits lift (decision 127) is a person's: a lifted limit is the owner's decision, never an agent's or the lead's.
export function checkForgeLimits(c, a0) {
  if (a0 !== 'forge' || c.argv[1] !== 'limits' || c.argv[2] !== 'lift') return [];
  return [deny('limits:lift', 'Only a person lifts a ticket\'s limit (decision 127): park the ticket and tell the owner. The owner runs forge limits lift <ticket> in a terminal, or types ! forge limits lift <ticket> in this session.')];
}

// forge llm add, use and remove (decision 140) are a person's: which server the agents run on, and with whose key, is
// the owner's choice. The list (forge llm) is anyone's; it names where keys are, never a key.
export function checkForgeLlm(c, a0) {
  if (a0 !== 'forge' || c.argv[1] !== 'llm' || !['add', 'use', 'remove'].includes(c.argv[2])) return [];
  return [deny('llm:person', 'Only a person chooses the model server (forge llm, decision 140). Ask the owner; they run forge llm use <name> (or claude) in a terminal, or type ! forge llm use <name> in this session.')];
}

// forge new (decision 79) writes a whole skeleton, its Dockerfiles and its CI at once: the lead asks a person
// first (CI and image changes ask one by one otherwise); lanes never start a project.
export function checkForgeNew(c, a0, ctx) {
  if (a0 !== 'forge' || c.argv[1] !== 'new') return [];
  if (ctx.agentId) return [deny('forge:new', 'Only the lead starts a project with forge new, after the owner approved the stack.')];
  return [ask('forge:new', '`forge new` writes the starter skeleton, its Dockerfiles and its CI into this repository.')];
}
