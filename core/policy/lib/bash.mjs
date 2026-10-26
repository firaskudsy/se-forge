// Bash tool calls: parse, see through wrappers, and run every rule on every simple command.
import path from 'node:path';
import { parseShell } from './shell.mjs';
import { contextAt } from './context.mjs';
import { checkMemberGit } from './rules/system.mjs';
import { checkGit } from './rules/git.mjs';
import { checkGh, checkGlab, checkForgeMerge, checkForgeNew, checkForgeLimits, checkForgeLane, checkForgeLlm } from './rules/hosts.mjs';
import { checkSecrets, checkDownloadAndRun } from './rules/secrets.mjs';
import { checkKeys } from './rules/keys.mjs';
import { checkOps } from './rules/ops.mjs';
import { checkOutput } from './rules/output.mjs';
import { checkTracker } from './rules/tracker.mjs';

export const base = (w) => String(w ?? '').split('/').pop();

const SIMPLE_WRAPPERS = new Set(['command', 'builtin', 'exec', 'nohup', 'time', 'noglob', 'caffeinate', 'doas', 'unbuffer']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);
// Shell grammar words the parser leaves at the start of a simple command: the command after them runs.
// `for x in …`, `select x in …`, `case w in` and the closing words run nothing themselves.
const KEYWORD_PREFIX = new Set(['do', 'then', 'else', 'elif', 'if', 'while', 'until', '!', '{']);
const KEYWORD_ONLY = new Set(['done', 'fi', 'esac', '}']);
const SUDO_VALUE = new Set(['-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T']);

function skipOptions(argv, valued = new Set()) {
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') i += valued.has(argv[i]) ? 2 : 1;
  if (argv[i] === '--') i++;
  return argv.slice(i);
}

// The command a container runs: `docker [compose] exec|run … <service|container|image> <command…>` (and
// podman, nerdctl, docker-compose). Dev containers mount the repo (decision 72), so what runs inside is
// checked like a command on the host. Flags that take a value are listed so the value is not read as the
// service or image; `-e NAME=value` becomes an assignment the database and secret rules see.
const ENGINES = new Set(['docker', 'podman', 'nerdctl', 'docker-compose']);
const DOCKER_GLOBAL = new Set(['-H', '--host', '-c', '--context', '--config', '-l', '--log-level', '--tlscacert', '--tlscert', '--tlskey']);
const COMPOSE_GLOBAL = new Set(['-f', '--file', '-p', '--project-name', '--project-directory', '--env-file', '--profile', '--ansi', '--progress', '--parallel']);
const EXEC_VALUE = new Set(['-e', '--env', '--env-file', '-u', '--user', '-w', '--workdir', '--detach-keys', '--index']);
const RUN_VALUE = new Set([...EXEC_VALUE, '-a', '--attach', '--add-host', '--annotation', '--blkio-weight', '--cap-add', '--cap-drop',
  '--cgroup-parent', '--cgroupns', '--cidfile', '-c', '--cpu-shares', '--cpu-period', '--cpu-quota', '--cpus', '--cpuset-cpus', '--cpuset-mems',
  '--device', '--device-cgroup-rule', '--dns', '--dns-option', '--dns-search', '--domainname', '--entrypoint', '--env-from-file', '--expose',
  '--gpus', '--group-add', '--health-cmd', '--health-interval', '--health-retries', '--health-start-period', '--health-start-interval',
  '--health-timeout', '-h', '--hostname', '--ip', '--ip6', '--ipc', '--isolation', '-l', '--label', '--label-file', '--link',
  '--log-driver', '--log-opt', '--mac-address', '-m', '--memory', '--memory-reservation', '--memory-swap', '--memory-swappiness',
  '--mount', '--name', '--network', '--net', '--network-alias', '--oom-score-adj', '--pid', '--pids-limit', '--platform', '-p', '--publish',
  '--pull', '--restart', '--runtime', '--security-opt', '--shm-size', '--stop-signal', '--stop-timeout', '--storage-opt', '--sysctl',
  '--tmpfs', '--ulimit', '--userns', '--uts', '-v', '--volume', '--volume-driver', '--volumes-from']);
function takeOptions(argv, valued) {
  const opts = [];
  let i = 0;
  while (i < argv.length && argv[i].startsWith('-') && argv[i] !== '--') {
    const a = argv[i];
    const name = a.startsWith('--') ? a.split('=')[0] : a.slice(0, 2);
    const inline = a.startsWith('--') ? a.includes('=') : a.length > 2 && valued.has(name);
    if (valued.has(name) && !inline) { opts.push([name, argv[i + 1] ?? '']); i += 2; continue; }
    opts.push([name, a.startsWith('--') ? a.slice(name.length + 1) : a.slice(2)]);
    i++;
  }
  if (argv[i] === '--') i++;
  return { opts, rest: argv.slice(i) };
}
function containerCommand(argv) {
  let rest = argv.slice(1);
  let compose = base(argv[0]) === 'docker-compose';
  if (!compose) {
    rest = takeOptions(rest, DOCKER_GLOBAL).rest;
    if (rest[0] === 'container') rest = rest.slice(1);
    else if (rest[0] === 'compose') { compose = true; rest = rest.slice(1); }
  }
  if (compose) rest = takeOptions(rest, COMPOSE_GLOBAL).rest;
  const verb = rest[0];
  if (verb !== 'exec' && verb !== 'run') return null;
  const { opts, rest: after } = takeOptions(rest.slice(1), verb === 'run' ? RUN_VALUE : EXEC_VALUE);
  const entrypoint = opts.find(([n]) => n === '--entrypoint')?.[1];
  const command = [...(entrypoint ? [entrypoint] : []), ...after.slice(1)];
  const env = opts.filter(([n, v]) => (n === '-e' || n === '--env') && /^[A-Za-z_]\w*=/.test(v)).map(([, v]) => v);
  // No command: the image's own; still returned for the service or image, so -e values and the variables set
  // in front of the command reach the rules.
  return command.length || after[0] ? { argv: command, env, target: after[0] ?? '' } : null;
}

// Returns the command a wrapper runs, plus any commands hidden in script strings. `wrappers` are the
// project's own wrapper scripts (commands.wrappers, e.g. a script that runs its arguments in a toolchain
// container): their arguments are the command that really runs.
const norm = (p) => String(p ?? '').replace(/^\.\//, '');
function unwrap(c, wrappers = []) {
  let argv = c.argv.slice();
  const assigns = c.assigns.slice();
  const hidden = [];
  for (let guard = 0; guard < 12 && argv.length; guard++) {
    if (KEYWORD_PREFIX.has(argv[0])) { argv = argv.slice(1); continue; }
    if (KEYWORD_ONLY.has(argv[0]) || ((argv[0] === 'for' || argv[0] === 'select') && argv[2] === 'in') || (argv[0] === 'case' && argv[2] === 'in')) { argv = []; break; }
    const a0 = base(argv[0]);
    if (SIMPLE_WRAPPERS.has(a0)) { argv = skipOptions(argv.slice(1)); continue; }
    if (wrappers.includes(norm(argv[0]))) { argv = argv.slice(1); continue; }
    if (a0 === 'sudo') { argv = skipOptions(argv.slice(1), SUDO_VALUE); continue; }
    if (a0 === 'timeout') { argv = skipOptions(argv.slice(1), new Set(['-s', '--signal', '-k', '--kill-after'])).slice(1); continue; }
    if (a0 === 'nice' || a0 === 'ionice') { argv = skipOptions(argv.slice(1), new Set(['-n', '-c'])); continue; }
    if (a0 === 'stdbuf') { argv = skipOptions(argv.slice(1)); continue; }
    if (a0 === 'watch') { argv = skipOptions(argv.slice(1), new Set(['-n', '--interval'])); continue; }
    if (a0 === 'xargs') { argv = skipOptions(argv.slice(1), new Set(['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a'])); continue; }
    if (a0 === 'env') {
      let i = 1;
      while (i < argv.length) {
        const a = argv[i];
        if (['-u', '--unset', '-C', '--chdir'].includes(a)) { i += 2; continue; }
        if (a === '-S' || a === '--split-string') { hidden.push(...parseShell(argv[i + 1] ?? '')); i += 2; continue; }
        if (a.startsWith('-')) { i++; continue; }
        if (/^[A-Za-z_]\w*=/.test(a)) { assigns.push(a); i++; continue; }
        break;
      }
      if (i >= argv.length) return [{ ...c, argv: ['env'], assigns, envDump: true }, ...hidden];
      argv = argv.slice(i);
      continue;
    }
    if (SHELLS.has(a0)) {
      const ci = argv.findIndex((a, k) => k > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (ci > 0 && argv[ci + 1] !== undefined) {
        hidden.push(...parseShell(argv[ci + 1]).map((x) => ({ ...x, nested: true })));
        break;
      }
      if (argv[1] && !/^[-<>]/.test(argv[1])) { argv = argv.slice(1); continue; } // "bash script.sh args"
      break;
    }
    if (ENGINES.has(a0)) {
      const inner = containerCommand(argv);
      // The variables set in front of the command reach the container through compose interpolation (${X}), so
      // the rules see them next to the -e values.
      if (inner) hidden.push({ ...c, argv: inner.argv, assigns: [...assigns, ...inner.env], redirects: [], stdin: [], nested: true, container: true, target: inner.target });
      break;
    }
    if (a0 === 'eval') { hidden.push(...parseShell(argv.slice(1).join(' ')).map((x) => ({ ...x, nested: true }))); break; }
    if ((a0 === 'python' || a0 === 'python3') && argv[1] === '-m' && ['pip', 'pip3'].includes(argv[2])) { argv = ['pip', ...argv.slice(3)]; continue; }
    break;
  }
  const result = [{ ...c, argv, assigns }];
  if (base(argv[0]) === 'find') {
    for (let i = 0; i < argv.length; i++) {
      if (!/^-(exec|execdir|ok|okdir)$/.test(argv[i])) continue;
      const end = argv.findIndex((a, k) => k > i && (a === ';' || a === '\\;' || a === '+'));
      result.push({ ...c, argv: argv.slice(i + 1, end < 0 ? undefined : end), redirects: [], stdin: [], nested: true });
    }
  }
  return result.concat(hidden);
}

export function expand(cmds, depth = 0, wrappers = []) {
  const out = [];
  for (const c of cmds) {
    const [first, ...rest] = unwrap(c, wrappers.map(norm));
    out.push(first);
    if (rest.length) out.push(...(depth < 4 ? expand(rest, depth + 1, wrappers) : rest));
  }
  return out;
}

// The folder a `cd` moves to: null when the hook cannot read it (a variable, a command substitution).
export function cdTarget(dir, arg, ctx) {
  if (arg === undefined || arg === '~') return ctx.home;
  if (/[$`]/.test(arg) || dir === null) return null;
  return path.resolve(dir, arg.startsWith('~/') ? path.join(ctx.home, arg.slice(2)) : arg);
}

export function checkBash(command, session) {
  let ctx = session;
  const cmds = expand(parseShell(command), 0, ctx.config.commands.wrappers);
  const findings = [];
  let dir = session.cwd;
  let here = session;
  cmds.forEach((c, i) => {
    const a0 = base(c.argv[0]);
    // A command after a cd runs in that folder's repository, with its rules (a system's member, decision 130).
    if (a0 === 'cd') { dir = cdTarget(dir, c.argv[1], session); here = dir ? contextAt(session, dir) : session; }
    const gitC = a0 === 'git' ? c.argv.indexOf('-C') : -1;
    ctx = gitC > 0 && c.argv[gitC + 1] && !/[$`]/.test(c.argv[gitC + 1]) ? contextAt(session, path.resolve(dir ?? session.cwd, c.argv[gitC + 1])) : here;
    findings.push(...checkSecrets(c, a0, ctx));
    findings.push(...checkKeys(c, a0, ctx));
    if (!a0) { findings.push(...checkOps(c, a0, ctx)); return; }
    // A done claim is checked in the folder the command runs in, after any `cd` before it.
    const where = (list) => list.map((f) => (f.decision === 'done' ? { ...f, cwd: dir } : f));
    if (a0 === 'git') findings.push(...checkGit(c.argv, ctx), ...checkMemberGit(c, a0, ctx, session));
    if (a0 === 'gh') findings.push(...where(checkGh(c.argv)));
    if (a0 === 'glab') findings.push(...where(checkGlab(c.argv)));
    findings.push(...where(checkTracker(c, a0, ctx)));
    findings.push(...checkForgeMerge(c, a0, ctx));
    findings.push(...checkForgeNew(c, a0, ctx));
    findings.push(...checkForgeLimits(c, a0));
    findings.push(...checkForgeLlm(c, a0));
    findings.push(...checkForgeLane(c, a0, ctx));
    findings.push(...checkOps(c, a0, ctx));
    findings.push(...checkOutput(cmds, i, ctx));
    findings.push(...checkDownloadAndRun(cmds, i, a0));
  });
  return findings;
}
