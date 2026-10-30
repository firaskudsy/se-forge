// git: protected branches, force pushes, skipped hooks, bulk staging, discarded work.
import path from 'node:path';
import { deny, ask } from '../decision.mjs';
import { parseFlags, has } from '../flags.mjs';
import { git } from '../context.mjs';
import { globToRegex } from '../paths.mjs';

const GLOBAL_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--super-prefix', '--config-env']);

export function splitGit(argv) {
  let i = 1;
  let dir = null;
  const configs = [];
  while (i < argv.length && argv[i].startsWith('-')) {
    const a = argv[i];
    if (a === '-C') dir = argv[i + 1];
    if (a === '-c') configs.push(argv[i + 1] ?? '');
    if (a.startsWith('--config-env=')) configs.push(a.slice(13));
    i += GLOBAL_WITH_VALUE.has(a) ? 2 : 1;
  }
  return { dir, configs, sub: argv[i] ?? '', args: argv.slice(i + 1) };
}

export function isProtected(branch, config) {
  if (!branch) return false;
  const name = branch.replace(/^refs\/heads\//, '');
  return [config.branches.base, ...config.branches.promote, ...config.branches.protected].some((p) => (p.includes('*') ? globToRegex(p).test(name) : p === name));
}

const touchesHooksPath = (s) => /^core\.hookspath\b/i.test(s.trim());

function push(g, ctx, cwd) {
  const out = [];
  const f = parseFlags(g.args, { shortValue: 'o', longValue: ['--repo', '--receive-pack', '--exec', '--push-option'] });
  if (has(f, 'n', ['--dry-run'])) return out;
  if (has(f, 'f', ['--force', '--force-with-lease'])) out.push(deny('git:force-push', 'Force-pushing is not allowed. Add a new commit instead of rewriting pushed history.'));
  if (f.long.has('--mirror')) out.push(deny('git:push-mirror', '`git push --mirror` overwrites every ref on the remote.'));
  if (f.long.has('--all') || f.long.has('--branches')) out.push(deny('git:push-all', '`git push --all` pushes every local branch, including protected ones. Push your feature branch by name.'));
  if (f.long.has('--prune')) out.push(deny('git:push-prune', '`git push --prune` can delete remote branches.'));
  if (f.long.has('--no-verify')) out.push(deny('git:no-verify', '--no-verify skips the checks that protect the repo.'));
  const opts = [f.short.get('o'), f.long.get('--push-option')].filter((v) => typeof v === 'string');
  if (opts.some((o) => /^ci\.skip$/i.test(o))) out.push(deny('git:ci-skip', 'Skipping CI with a push option is not allowed.'));
  if (f.long.has('--tags') || f.long.has('--follow-tags')) out.push(ask('git:push-tags', 'Pushing tags can start release or deploy pipelines.'));

  const deleting = has(f, 'd', ['--delete']);
  const [, ...refspecs] = f.positional;
  const current = () => {
    const r = git(cwd, ['symbolic-ref', '--short', '-q', 'HEAD']);
    return r.ok ? r.out : null;
  };
  const targets = [];
  if (!refspecs.length && !deleting) targets.push({ dst: current(), force: false });
  for (const spec of refspecs) {
    const force = spec.startsWith('+');
    const s = force ? spec.slice(1) : spec;
    let dst;
    if (deleting) dst = s;
    else if (s.includes(':')) dst = s.slice(s.indexOf(':') + 1) || null;
    else dst = s === 'HEAD' || s === '@' ? current() : s;
    if (!deleting && s.includes(':') && s.startsWith(':')) targets.push({ dst: s.slice(1), force, del: true });
    else targets.push({ dst, force, del: deleting });
  }
  for (const t of targets) {
    if (!t.dst) continue;
    if (t.force) out.push(deny('git:force-push', `\`+${t.dst}\` is a force push. Add a new commit instead of rewriting pushed history.`));
    const isTag = t.dst.startsWith('refs/tags/')
      || (!t.dst.startsWith('refs/') && git(cwd, ['show-ref', '--verify', '-q', `refs/tags/${t.dst}`]).ok
        && !git(cwd, ['show-ref', '--verify', '-q', `refs/heads/${t.dst}`]).ok);
    if (isTag) out.push(ask('git:push-tags', `Pushing tag ${t.dst.replace(/^refs\/tags\//, '')} can start release or deploy pipelines.`));
    else if (isProtected(t.dst, ctx.config)) {
      out.push(deny(t.del ? 'git:delete-protected' : 'git:push-protected',
        t.del ? `Deleting the protected branch ${t.dst} is for a human.`
          : `Never push to ${t.dst.replace(/^refs\/heads\//, '')}. Push a feat|fix|chore/<ticket>-<slug> branch and open a pull request.`));
    }
  }
  return out;
}

export const COMMIT_FLAGS = { shortValue: 'mFcCt', longValue: ['--message', '--file', '--author', '--date', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--trailer', '--cleanup', '--template'] };

function commit(g) {
  const f = parseFlags(g.args, COMMIT_FLAGS);
  const out = [];
  if (has(f, 'n', ['--no-verify'])) out.push(deny('git:no-verify', '`git commit -n/--no-verify` skips the commit hooks.'));
  if (has(f, 'a', ['--all'])) out.push(deny('git:bulk-add', '`git commit -a` stages every tracked change. Stage explicit paths with `git add <path>` first.'));
  return out;
}

const BULK_PATHS = new Set(['.', './', ':/', ':', '*', ':(top)', ':/*']);

function add(g, ctx) {
  const f = parseFlags(g.args, { longValue: ['--chmod', '--pathspec-from-file'] });
  const out = [];
  if (has(f, 'Au', ['--all', '--update', '--no-ignore-removal']) || f.positional.some((p) => BULK_PATHS.has(p) || p === ctx.root || p === `${ctx.root}/`)) {
    out.push(deny('git:bulk-add', 'Stage explicit paths (`git add path/to/file`, dotfiles included). `git add .`, `-A` and `-u` are not allowed.'));
  }
  if (has(f, 'f', ['--force'])) out.push(ask('git:force-add', '`git add -f` stages files the repo ignores on purpose.'));
  return out;
}

function discards(g) {
  const out = [];
  const f = parseFlags(g.args, { shortValue: 'm', longValue: ['--source'] });
  const d = (what) => ask('git:discard', `${what} throws away uncommitted work that may not be yours.`);
  switch (g.sub) {
    case 'reset':
      if (['--hard', '--merge', '--keep'].some((x) => f.long.has(x))) out.push(d('`git reset --hard`'));
      break;
    case 'clean':
      if (has(f, 'f', ['--force']) && !has(f, 'n', ['--dry-run'])) out.push(d('`git clean -f`'));
      break;
    case 'checkout':
      if (has(f, 'f', ['--force']) || (f.afterDashDash && f.positional.length) || f.positional.includes('.')) out.push(d('`git checkout -- <paths>`'));
      break;
    case 'restore':
      if (!has(f, 'S', ['--staged']) || has(f, 'W', ['--worktree'])) out.push(d('`git restore`'));
      break;
    case 'stash':
      if (['drop', 'clear'].includes(g.args[0])) out.push(d(`\`git stash ${g.args[0]}\``));
      break;
    case 'worktree':
      // A plain `git worktree remove` refuses a worktree with changes; --force deletes them with it.
      if (g.args[0] === 'remove' && g.args.slice(1).some((a) => a === '-f' || a === '--force' || /^-[a-z]*f/.test(a))) out.push(d('`git worktree remove --force`'));
      break;
    default:
  }
  return out;
}

function branch(g, ctx) {
  const f = parseFlags(g.args, { longValue: ['--set-upstream-to', '--contains', '--merged', '--no-merged', '--points-at', '--sort', '--format'] });
  const deleting = has(f, 'dD', ['--delete']);
  const moving = has(f, 'mMf', ['--move', '--force']);
  if (!deleting && !moving) return [];
  if (f.positional.some((b) => isProtected(b, ctx.config))) return [deny('git:protected-branch', 'Deleting, renaming or force-moving a protected branch is for a human.')];
  if (f.short.has('D') || (deleting && has(f, 'f', ['--force']))) return [ask('git:discard', '`git branch -D` deletes unmerged commits.')];
  return [];
}

// An api-v<semver> tag marks an approved contract version: forge merge sets it when it merges the contract's branch
// (decision 148), or a person does.
function tag(g) {
  const f = parseFlags(g.args, { shortValue: 'mFu', longValue: ['--message', '--file', '--local-user', '--sort', '--contains', '--no-contains', '--points-at', '--merged', '--no-merged', '--format', '--cleanup', '--color'] });
  if (has(f, 'ln', ['--list', '--verify']) || !f.positional.length) return [];
  if (!/^api-v/.test(f.positional[0])) return [];
  return [ask('gate:contract', `Tag ${f.positional[0]} marks an approved API contract version. forge merge <the contract's branch> sets it when it merges (decision 148); otherwise a person creates, moves or deletes it.`)];
}

function config(g) {
  const f = parseFlags(g.args, { longValue: ['--file', '--blob', '--type', '--default'] });
  const reading = ['--get', '--get-all', '--get-regexp', '--list', '-l'].some((x) => f.long.has(x) || g.args.includes(x));
  if (!reading && f.positional.some(touchesHooksPath)) return [deny('git:hooks-path', 'Changing core.hooksPath turns off the repository hooks.')];
  if (!reading && f.positional.length >= 2 && (f.long.has('--global') || f.long.has('--system'))) {
    return [ask('git:global-config', 'Changing global git config affects every repository on this machine.')];
  }
  return [];
}

export function checkGit(argv, ctx) {
  const g = splitGit(argv);
  const cwd = g.dir ? path.resolve(ctx.cwd, g.dir) : ctx.cwd;
  const out = [];
  if (g.configs.some(touchesHooksPath)) out.push(deny('git:hooks-path', 'Overriding core.hooksPath turns off the repository hooks.'));
  switch (g.sub) {
    case 'push': out.push(...push(g, ctx, cwd)); break;
    case 'commit': out.push(...commit(g)); break;
    case 'add': out.push(...add(g, ctx)); break;
    case 'branch': out.push(...branch(g, ctx)); break;
    case 'config': out.push(...config(g)); break;
    case 'tag': out.push(...tag(g)); break;
    case 'filter-branch':
    case 'filter-repo': out.push(ask('git:rewrite', 'Rewriting history needs a human decision.')); break;
    case 'update-ref':
      if (g.args.some((a) => isProtected(a, ctx.config))) out.push(deny('git:protected-branch', 'Moving a protected branch ref is for a human.'));
      break;
    case 'rm': {
      const f = parseFlags(g.args);
      if (!f.long.has('--cached') && has(f, 'r')) out.push(ask('repo:delete', '`git rm -r` deletes folders from the repo.'));
      break;
    }
    default: out.push(...discards(g));
  }
  return out;
}

// git subcommands that may name a secret file without reading it.
export function gitSecretSafe(argv) {
  const g = splitGit(argv);
  if (['status', 'check-ignore', 'ls-files'].includes(g.sub)) return true;
  return g.sub === 'rm' && g.args.includes('--cached');
}
