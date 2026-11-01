// Infrastructure, databases, deploys, cloud and remote access, containers, network,
// dependencies and deletions. Production and destructive actions are denied; actions
// with effects outside this machine or this repo ask first.
import fs from 'node:fs';
import path from 'node:path';
import { deny, ask } from '../decision.mjs';
import { parseFlags, has } from '../flags.mjs';
import { relTo, resolvePath, matchAny } from '../paths.mjs';
import { writeFindings } from './targets.mjs';
import { linkedPath } from '../context.mjs';

const PROD = /(^|[^a-z])(prod|production|prd|live)([^a-z]|$)/i;
const prodDeny = (what) => deny('deploy:production', `${what} targets production. Production changes run only in the pipeline after a human approves.`);
const positionals = (args, valueFlags = []) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { out.push(...args.slice(i + 1)); break; }
    if (a.startsWith('-')) { if (!a.includes('=') && valueFlags.includes(a)) i++; continue; }
    out.push(a);
  }
  return out;
};

// ---------- Terraform / OpenTofu / Terragrunt ----------
function terraform(argv, a0) {
  const words = positionals(argv.slice(1));
  let [sub, op] = words;
  if (a0 === 'terragrunt' && (sub === 'run-all' || sub === 'run')) [, sub, op] = words;
  if (sub === 'apply' || sub === 'destroy') {
    return [deny('infra:apply', `\`${a0} ${sub}\` changes real infrastructure. It runs only in the pipeline, after a human approves the plan.`)];
  }
  if (sub === 'force-unlock' || (sub === 'state' && !['list', 'show'].includes(op))) {
    return [deny('infra:state', `\`${a0} ${sub}${op ? ` ${op}` : ''}\` reads or rewrites Terraform state, which holds secrets.`)];
  }
  if (['import', 'taint', 'untaint', 'refresh', 'console', 'test', 'output', 'login', 'logout'].includes(sub) || (sub === 'workspace' && op === 'delete')) {
    return [ask('infra:ask', `\`${a0} ${sub}\` can change state, real resources or print sensitive outputs.`)];
  }
  return [];
}

// ---------- Databases ----------
const DB_CLIENTS = new Set(['psql', 'mysql', 'mariadb', 'sqlcmd', 'sqlite3', 'mongosh', 'mongo', 'clickhouse-client', 'pgcli', 'mycli', 'litecli', 'usql', 'cockroach']);
const SQL_DENY = /\b(drop\s+(table|database|schema)\b|truncate\s+(table\s+)?["'`[\w])/i;
const SQL_ASK = /\b(drop\s+(column|index|view|user|role)\b|alter\s+table\s+\S+\s+drop\b|delete\s+from\s+[\w."`[\]]+\s*(;|$))/im;
const MONGO_DENY = /\.(dropDatabase|drop)\s*\(|\.deleteMany\s*\(\s*\{\s*\}\s*\)/;
const DB_URL = /\b(?:postgres(?:ql)?|mysql|mariadb|mssql|sqlserver|mongodb(?:\+srv)?|rediss?|jdbc:\w+(?::\w+)?):\/\/(?:[^@/\s]*@)?([^:/\s?,;'"]+)/gi;
const ADO_HOST = /\b(?:host|server|data source|addr|address)\s*=\s*(?:tcp:)?([^;,\s'"]+)/gi;

function sqlSources(c, a0) {
  const f = parseFlags(c.argv.slice(1), { shortValue: 'cefQqiFdhUpPSs', longValue: ['--command', '--execute', '--eval', '--file', '--query', '--host', '--dbname', '--username', '--port'] });
  const texts = [...c.stdin];
  for (const k of ['c', 'e', 'Q', 'q']) if (typeof f.short.get(k) === 'string') texts.push(f.short.get(k));
  for (const k of ['--command', '--execute', '--eval', '--query']) if (typeof f.long.get(k) === 'string') texts.push(f.long.get(k));
  const file = f.short.get('f') || f.short.get('i') || f.long.get('--file');
  if (typeof file === 'string' && a0 !== 'mongosh') {
    try { if (fs.statSync(file).size < 1e6) texts.push(fs.readFileSync(file, 'utf8')); } catch { /* not readable here */ }
  }
  if (a0 === 'mongosh' || a0 === 'mongo') texts.push(...f.positional.filter((p) => p.endsWith('.js')).map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }));
  return texts.join('\n');
}

function dbHosts(c, a0) {
  const hosts = [];
  const words = [...c.argv.slice(1), ...c.assigns];
  for (const w of words) {
    for (const m of w.matchAll(DB_URL)) hosts.push(m[1]);
    for (const m of w.matchAll(ADO_HOST)) hosts.push(m[1]);
  }
  if (DB_CLIENTS.has(a0) || ['pg_dump', 'pg_restore', 'mysqldump', 'redis-cli', 'mongodump', 'mongorestore'].includes(a0)) {
    const hostShort = a0 === 'sqlcmd' ? 'S' : 'h';
    const f = parseFlags(c.argv.slice(1), { shortValue: `${hostShort}cefQqidUpP`, longValue: ['--host', '--server'] });
    for (const v of [f.short.get(hostShort), f.long.get('--host'), f.long.get('--server')]) if (typeof v === 'string') hosts.push(v.replace(/^tcp:/, '').split(/[,:]/)[0]);
  }
  return hosts;
}

function databases(c, a0, ctx) {
  const out = [];
  const args = c.argv.slice(1);
  const sub = positionals(args);
  if (['dropdb', 'dropuser'].includes(a0) || (a0 === 'mysqladmin' && sub.includes('drop'))) out.push(deny('db:drop', 'Dropping databases is not allowed.'));
  if (a0 === 'dotnet' && sub[0] === 'ef' && sub[1] === 'database' && sub[2] === 'drop') out.push(deny('db:drop', '`dotnet ef database drop` deletes the database.'));
  const isPrisma = a0 === 'prisma' || (['npx', 'pnpm', 'bunx', 'yarn'].includes(a0) && sub.includes('prisma'));
  if (isPrisma && sub.includes('migrate') && sub.includes('reset')) out.push(deny('db:drop', '`prisma migrate reset` drops the database.'));
  if (isPrisma && sub.includes('db') && (args.includes('--force-reset') || args.includes('--accept-data-loss'))) out.push(deny('db:drop', 'This prisma command can drop data.'));
  if (isPrisma && sub.includes('migrate') && sub.includes('deploy')) out.push(ask('db:remote', '`prisma migrate deploy` is meant for shared or production databases.'));

  if (DB_CLIENTS.has(a0)) {
    const sql = sqlSources(c, a0);
    if (SQL_DENY.test(sql) || MONGO_DENY.test(sql)) out.push(deny('db:drop', 'Dropping or truncating tables, schemas or databases is not allowed. Write a reviewed migration instead.'));
    else if (SQL_ASK.test(sql)) out.push(ask('db:destructive', 'This SQL deletes columns, indexes or rows without a WHERE clause.'));
  }
  const local = new Set(ctx.config.databases.localHosts.map((h) => h.toLowerCase()));
  const remote = dbHosts(c, a0).filter((h) => h && !h.startsWith('$') && !local.has(h.toLowerCase()) && !/\.localhost$/.test(h));
  if (remote.length) {
    out.push(PROD.test(remote.join(' ')) ? prodDeny(`This database command (${remote[0]})`) : ask('db:remote', `This command reaches a database that is not local (${remote[0]}).`));
  }
  return out;
}

// ---------- Cloud CLIs ----------
const READ_VERB = /^(describe|list|get|head|batch-get|lookup|filter|search|scan|query|validate|estimate|simulate|test|show|check|exists|wait|info|read|ls|version|help)([-_]|$)/;
const cloudWrite = (tool, words) => ask('remote:cloud', `\`${tool} ${words.join(' ')}\` changes cloud resources.`);

function aws(argv) {
  const f = parseFlags(argv.slice(1), { longValue: ['--profile', '--region', '--output', '--query', '--endpoint-url', '--cli-input-json', '--secret-id', '--name', '--names'] });
  const [service, op] = f.positional;
  if (PROD.test(String(f.long.get('--profile') ?? ''))) return [prodDeny('This AWS profile')];
  if ((service === 'secretsmanager' && op === 'get-secret-value') || (service === 'ssm' && /^get-parameters?(-by-path)?$/.test(op ?? '') && f.long.has('--with-decryption'))
    || (service === 'sts' && /^(get-session-token|assume-role)/.test(op ?? '')) || (service === 'ecr' && op === 'get-login-password')
    || (service === 'iam' && op === 'create-access-key') || (service === 'configure' && ['get', 'export-credentials'].includes(op))) {
    return [deny('secrets:cloud', `\`aws ${service} ${op}\` prints credentials.`)];
  }
  if (service === 's3') {
    if (op === 'ls' || op === 'presign') return [];
    const dest = f.positional[f.positional.length - 1] ?? '';
    if (['rm', 'rb', 'mb'].includes(op) || dest.startsWith('s3://')) return [cloudWrite('aws', [service, op])];
    return [];
  }
  if (!op || READ_VERB.test(op)) return [];
  return [cloudWrite('aws', [service, op])];
}

function az(argv) {
  const f = parseFlags(argv.slice(1), { shortValue: 'gnso', longValue: ['--subscription', '--resource-group', '--name', '--output', '--query'] });
  const words = f.positional;
  const sub = String(f.short.get('s') ?? f.long.get('--subscription') ?? '');
  if (PROD.test(sub)) return [prodDeny('This Azure subscription')];
  const key = words.join(' ');
  if (/^account get-access-token|^keyvault secret (show|download)|keys list|credential reset|connection-string show/.test(key)) return [deny('secrets:cloud', `\`az ${key}\` prints credentials.`)];
  const verb = words[words.length - 1] ?? '';
  if (!verb || READ_VERB.test(verb) || words[0] === 'login' || words[0] === 'account') return [];
  return [cloudWrite('az', words)];
}

function gcloud(argv) {
  const f = parseFlags(argv.slice(1), { longValue: ['--project', '--region', '--zone', '--format', '--filter', '--account'] });
  const words = f.positional;
  if (PROD.test(String(f.long.get('--project') ?? ''))) return [prodDeny('This Google Cloud project')];
  const key = words.join(' ');
  if (/print-(access|identity)-token|secrets versions access/.test(key)) return [deny('secrets:cloud', `\`gcloud ${key}\` prints credentials.`)];
  const verb = words[words.length - 1] ?? '';
  if (!verb || READ_VERB.test(verb) || (words[0] === 'config' && verb !== 'set') || words[0] === 'auth') return [];
  return [cloudWrite('gcloud', words)];
}

// ---------- Kubernetes ----------
const K8S_READ = new Set(['get', 'describe', 'logs', 'top', 'explain', 'api-resources', 'api-versions', 'version', 'cluster-info', 'diff', 'auth', 'events', 'wait', 'completion']);
function kubectl(argv) {
  const f = parseFlags(argv.slice(1), { shortValue: 'nlofcLp', longValue: ['--namespace', '--context', '--cluster', '--kubeconfig', '--selector', '--output', '--filename', '--container', '--user'] });
  const target = [f.short.get('n'), f.long.get('--namespace'), f.long.get('--context'), f.long.get('--cluster')].filter((v) => typeof v === 'string').join(' ');
  const [verb, sub] = f.positional;
  if (verb === 'config') {
    if (sub === 'view' && (f.long.has('--raw') || f.long.has('--flatten'))) return [deny('secrets:cloud', '`kubectl config view --raw` prints cluster credentials.')];
    return ['view', 'get-contexts', 'current-context', 'get-clusters', 'get-users'].includes(sub) ? [] : [ask('remote:k8s', `\`kubectl config ${sub}\` changes which cluster commands run against.`)];
  }
  if (!verb || K8S_READ.has(verb)) return [];
  if (PROD.test(target)) return [prodDeny(`\`kubectl ${verb}\``)];
  return [ask('remote:k8s', `\`kubectl ${verb}\` changes or enters a running cluster.`)];
}

function helm(argv) {
  const f = parseFlags(argv.slice(1), { shortValue: 'nfo', longValue: ['--namespace', '--kube-context', '--values', '--set', '--version', '--output'] });
  const [verb, release] = f.positional;
  if (!['install', 'upgrade', 'uninstall', 'delete', 'rollback', 'test'].includes(verb)) return [];
  const target = [f.short.get('n'), f.long.get('--namespace'), f.long.get('--kube-context'), release].filter((v) => typeof v === 'string').join(' ');
  return PROD.test(target) ? [prodDeny(`\`helm ${verb}\``)] : [ask('remote:k8s', `\`helm ${verb}\` changes a running cluster.`)];
}

// ---------- Deploy tools and script runners ----------
const DEPLOY_VERBS = {
  vercel: [undefined, 'deploy', 'redeploy', 'promote', 'rollback'], netlify: ['deploy'], fly: ['deploy', 'launch', 'scale', 'secrets'],
  flyctl: ['deploy', 'launch', 'scale', 'secrets'], firebase: ['deploy'], eb: ['deploy', 'terminate', 'scale'], serverless: ['deploy', 'remove'],
  sls: ['deploy', 'remove'], cdk: ['deploy', 'destroy'], pulumi: ['up', 'destroy', 'update'], wrangler: ['deploy', 'publish', 'secret'],
  railway: ['up', 'deploy'], kamal: ['deploy', 'setup', 'rollback'], heroku: ['releases:rollback', 'config:set', 'pg:reset'],
};
function deployTool(argv, a0) {
  const args = argv.slice(1);
  const words = positionals(args);
  if (args.some((a) => PROD.test(a) || a === '--prod')) return [prodDeny(`\`${a0}\``)];
  if (a0 === 'vercel' && words[0] === 'env' && words[1] === 'pull') return [deny('secrets:cloud', '`vercel env pull` downloads secrets.')];
  if (DEPLOY_VERBS[a0].includes(words[0])) return [ask('deploy', `\`${a0} ${words[0] ?? ''}\` deploys or changes a hosted environment.`)];
  return [];
}

const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun', 'make', 'just', 'task']);
function scriptRunner(argv, a0) {
  const words = positionals(argv.slice(1), ['-C', '--prefix', '--filter', '-w', '--workspace', '-f', '--file']);
  const script = ['make', 'just', 'task'].includes(a0) ? words[0] : (words[0] === 'run' || words[0] === 'run-script' ? words[1] : (a0 === 'yarn' || a0 === 'pnpm' || a0 === 'bun' ? words[0] : null));
  if (script && /deploy|release|publish|rollout/i.test(script)) {
    return PROD.test(script) ? [prodDeny(`The \`${script}\` script`)] : [ask('deploy', `The \`${script}\` script deploys or releases.`)];
  }
  return [];
}

// ---------- Remote access, containers, network ----------
function ssh(argv, a0) {
  const valued = ['-i', '-p', '-P', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-E', '-b', '-c', '-e', '-m', '-O', '-Q', '-S', '-W', '-w'];
  const words = positionals(argv.slice(1), valued);
  if (a0 === 'ssh') {
    if (argv.includes('-T') && /^(git@)?(github\.com|gitlab\.com)$/.test(words[0] ?? '')) return [];
    return words.length ? [ask('remote:ssh', `\`ssh ${words[0]}\` runs commands on another machine.`)] : [];
  }
  if (a0 === 'sftp') return [ask('remote:ssh', '`sftp` can change files on another machine.')];
  const isRemote = (w) => /^[^/\s]*:/.test(w) && !w.includes('://') && !/^[A-Za-z]:\\/.test(w);
  const dest = words[words.length - 1] ?? '';
  if (words.length > 1 && isRemote(dest)) return [ask('remote:copy', `\`${a0}\` copies files to another machine (${dest.split(':')[0]}).`)];
  if (a0 === 'rsync' && argv.some((a) => a.startsWith('--delete'))) return [ask('repo:delete', '`rsync --delete` deletes files at the destination.')];
  return [];
}

const LOCAL_DOCKER_CONTEXTS = new Set(['default', 'desktop-linux', 'colima', 'orbstack', 'rancher-desktop']);
function docker(c, a0) {
  const args = c.argv.slice(1);
  const f = parseFlags(args, { shortValue: 'Hcfp', longValue: ['--host', '--context', '--file', '--project-name', '--env-file', '--profile', '--log-level', '--config'] });
  const host = f.short.get('H') ?? f.long.get('--host') ?? c.assigns.find((a) => a.startsWith('DOCKER_HOST='))?.slice(12);
  const context = f.long.get('--context') ?? (args[0] === 'context' && args[1] === 'use' ? args[2] : undefined);
  const out = [];
  if ((typeof host === 'string' && !/^unix:|localhost|127\.0\.0\.1/.test(host)) || (typeof context === 'string' && !LOCAL_DOCKER_CONTEXTS.has(context))) {
    out.push(ask('remote:docker', 'This docker command runs against a remote engine.'));
  }
  const words = a0 === 'docker-compose' ? ['compose', ...f.positional] : f.positional;
  const [cmd, sub] = words;
  if (cmd === 'push' || (cmd === 'image' && sub === 'push')) out.push(ask('remote:docker', '`docker push` publishes an image.'));
  if (cmd === 'login') out.push(ask('remote:docker', '`docker login` stores registry credentials.'));
  if (cmd === 'compose' && sub === 'config' && !args.some((a) => /^--(services|volumes|images|profiles|hash|networks)$/.test(a))) {
    out.push(deny('secrets:compose-config', '`docker compose config` prints the configuration with secrets filled in. Use `--services` to list names.'));
  }
  if (cmd === 'compose' && sub === 'down' && args.some((a) => a === '-v' || a === '--volumes')) out.push(ask('data:volumes', '`docker compose down -v` deletes the volumes (local database data).'));
  if ((cmd === 'volume' && ['rm', 'prune'].includes(sub)) || (cmd === 'system' && sub === 'prune' && args.some((a) => a === '--volumes' || /^-\w*a/.test(a)))) {
    out.push(ask('data:volumes', 'This deletes docker volumes or images (local data).'));
  }
  return out;
}

const URL_HOST = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]*@)?(\[[^\]]+\]|[^:/\s?#]+)/i;
// The Figma plugin's tools hand back each picture as a link under www.figma.com/api/mcp/asset/. Downloading one reads
// the project's own design, so it needs no prompt when the project names a Figma file (decision 149); a command that
// sends data still asks.
const FIGMA_ASSET = /^https:\/\/www\.figma\.com\/api\/mcp\/asset\/[\w.-]+$/i;
const SENDS = /^(-[a-zA-Z]*[dFTX]|--(data|form|upload|json|request|post|body|method))/;
const figmaReads = (argv, ctx) => Boolean(ctx.project.figma?.fileKey) && !argv.slice(1).some((a) => SENDS.test(a));
// `curl -o /tmp/a.png <picture link>`: a download of the Figma plugin's pictures and nothing else, allowed without a
// prompt (allow.mjs).
export function figmaDownload(argv, ctx) {
  const urls = argv.slice(1).filter((a) => URL_HOST.test(a));
  return ['curl', 'wget'].includes(argv[0]) && figmaReads(argv, ctx) && urls.length > 0 && urls.every((a) => FIGMA_ASSET.test(a));
}
function network(argv, a0, ctx) {
  if (['nc', 'ncat', 'netcat', 'telnet', 'socat'].includes(a0)) return [ask('net:outside', `\`${a0}\` opens raw network connections.`)];
  const allow = ctx.config.network.allowHosts.map((h) => h.toLowerCase());
  const figma = figmaReads(argv, ctx);
  const hosts = argv.slice(1).filter((a) => !(figma && FIGMA_ASSET.test(a)))
    .map((a) => URL_HOST.exec(a)?.[1]?.replace(/^\[|\]$/g, '').toLowerCase()).filter(Boolean);
  const outside = hosts.filter((h) => !allow.includes(h) && !allow.some((a) => a.startsWith('*.') && h.endsWith(a.slice(1))) && !h.endsWith('.localhost'));
  return outside.length ? [ask('net:outside', `\`${a0}\` contacts ${outside[0]}, which is not on the project's network allowlist.`)] : [];
}

// ---------- Dependencies ----------
const depAsk = (what) => ask('deps:change', `${what} changes the project's dependencies (stack decision).`);

// A package argument without its version or extras: lodash@4 -> lodash, @scope/x@1 -> @scope/x,
// httpx[http2]>=0.28 -> httpx.
export function packageName(spec) {
  const s = String(spec);
  if (s.startsWith('@')) return s.slice(0, s.indexOf('@', 1) > 0 ? s.indexOf('@', 1) : undefined).toLowerCase();
  return s.split(/[@=<>~!;\[\s]/)[0].toLowerCase();
}

// Adding only packages the register approved (policy.deps.approved) does not ask.
export function approvedAdd(names, ctx) {
  const ok = new Set((ctx?.config?.deps?.approved || []).map((n) => packageName(n)));
  return names.length > 0 && names.every((n) => ok.has(packageName(n)));
}

// An install of only packages the register approved (policy.deps.approved), as `npm install better-auth pg-boss` or
// `pnpm add x`: allowed without a prompt (decision 149).
const ADDS = { npm: ['install', 'i', 'add', 'in'], pnpm: ['add'], yarn: ['add'], bun: ['add'], pip: ['install'], pip3: ['install'], uv: ['add'], poetry: ['add'], pipenv: ['install'] };
const VALUE_FLAGS = ['--prefix', '-C', '--filter', '-w', '--workspace', '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '-t', '--target'];
export function approvedInstall(argv, ctx) {
  const [a0, ...args] = argv;
  if (!ADDS[a0] || args.includes('-g') || args.includes('--global')) return false;
  const [cmd, ...rest] = positionals(args, VALUE_FLAGS);
  return ADDS[a0].includes(cmd) && approvedAdd(rest.filter((w) => !w.startsWith('.') && !w.startsWith('/')), ctx);
}

function dependencies(argv, a0, ctx) {
  const args = argv.slice(1);
  const words = positionals(args, ['--prefix', '-C', '--filter', '-w', '--workspace', '-r', '--requirement', '-c', '--constraint', '-e', '--editable', '-i', '--index-url', '-t', '--target']);
  const [cmd, ...rest] = words;
  const pkgArgs = rest.filter((w) => !w.startsWith('.') && !w.startsWith('/'));
  switch (a0) {
    case 'npm':
      if (['install', 'i', 'add', 'in', 'isntall'].includes(cmd) && !args.includes('-g') && !args.includes('--global') && approvedAdd(pkgArgs, ctx)) return [];
      if (['install', 'i', 'add', 'in', 'isntall'].includes(cmd) && (pkgArgs.length || args.includes('-g') || args.includes('--global'))) return [depAsk(`\`npm ${cmd} ${pkgArgs.join(' ')}\``)];
      if (['uninstall', 'remove', 'rm', 'r', 'un', 'unlink', 'update', 'upgrade', 'up'].includes(cmd)) return [depAsk(`\`npm ${cmd}\``)];
      if (cmd === 'publish') return [ask('deps:publish', '`npm publish` releases a package.')];
      return [];
    case 'pnpm': case 'yarn': case 'bun':
      if (cmd === 'add' && approvedAdd(pkgArgs, ctx)) return [];
      if (['add', 'remove', 'rm', 'uninstall', 'update', 'up', 'upgrade', 'upgrade-interactive'].includes(cmd)) return [depAsk(`\`${a0} ${cmd}\``)];
      if (['install', 'i'].includes(cmd) && pkgArgs.length) return [depAsk(`\`${a0} ${cmd} ${pkgArgs.join(' ')}\``)];
      if (cmd === 'publish' || (cmd === 'npm' && rest[0] === 'publish')) return [ask('deps:publish', 'Publishing releases a package.')];
      return [];
    case 'pip': case 'pip3':
      if (cmd === 'install' && approvedAdd(pkgArgs, ctx)) return [];
      if (cmd === 'install' && pkgArgs.length) return [depAsk(`\`${a0} install ${pkgArgs.join(' ')}\``)];
      if (cmd === 'uninstall') return [depAsk(`\`${a0} uninstall\``)];
      return [];
    case 'uv':
      if (cmd === 'add' && approvedAdd(pkgArgs, ctx)) return [];
      if (['add', 'remove'].includes(cmd) || (cmd === 'pip' && ['install', 'uninstall'].includes(rest[0]) && rest.length > 1) || (cmd === 'lock' && args.some((a) => a.startsWith('--upgrade')))) return [depAsk(`\`uv ${cmd}\``)];
      return [];
    case 'poetry': case 'pipenv':
      if ((cmd === 'add' || (a0 === 'pipenv' && cmd === 'install')) && approvedAdd(pkgArgs, ctx)) return [];
      if (['add', 'remove', 'update', 'uninstall'].includes(cmd) || (a0 === 'pipenv' && cmd === 'install' && pkgArgs.length)) return [depAsk(`\`${a0} ${cmd}\``)];
      return [];
    case 'dotnet':
      if (cmd === 'add' && rest.includes('package') && approvedAdd([rest[rest.indexOf('package') + 1]].filter(Boolean), ctx)) return [];
      if ((['add', 'remove'].includes(cmd) && rest.includes('package')) || (cmd === 'tool' && ['install', 'update', 'uninstall'].includes(rest[0]))) return [depAsk(`\`dotnet ${cmd} … package\``)];
      if (cmd === 'nuget' && rest[0] === 'push') return [ask('deps:publish', '`dotnet nuget push` releases a package.')];
      return [];
    case 'go':
      return cmd === 'get' || (cmd === 'install' && rest.some((r) => r.includes('@'))) ? [depAsk(`\`go ${cmd}\``)] : [];
    case 'cargo':
      if (['add', 'remove', 'install', 'update'].includes(cmd)) return [depAsk(`\`cargo ${cmd}\``)];
      return cmd === 'publish' ? [ask('deps:publish', '`cargo publish` releases a package.')] : [];
    case 'brew': case 'apt': case 'apt-get': case 'yum': case 'dnf': case 'gem': case 'composer':
      return ['install', 'uninstall', 'remove', 'upgrade', 'reinstall', 'require', 'push'].includes(cmd) ? [depAsk(`\`${a0} ${cmd}\``)] : [];
    case 'twine':
      return cmd === 'upload' ? [ask('deps:publish', '`twine upload` releases a package.')] : [];
    default:
      return [];
  }
}

// ---------- Deletions and other writers ----------
function removal(argv, a0, ctx) {
  const args = argv.slice(1);
  const f = parseFlags(args);
  const out = [];
  const targets = f.positional;
  const recursive = a0 === 'find' ? false : has(f, 'rR', ['--recursive']);
  for (const t of targets) {
    if (/^(\/|~|\$HOME|\$\{HOME\}|\*|\/\*)$/.test(t)) { out.push(deny('fs:delete-root', `\`${a0} ${t}\` would delete far too much.`)); continue; }
    const abs = linkedPath(resolvePath(t, ctx.cwd, ctx.home), ctx);
    const relRoot = relTo(abs, ctx.root);
    out.push(...writeFindings(abs, ctx, 'Deleting'));
    if (!recursive) continue;
    if (relRoot === null) {
      if (!abs.startsWith(path.join(ctx.mainRoot, '.claude', 'worktrees')) && !abs.startsWith('/tmp/') && !abs.startsWith(ctx.env.TMPDIR || '/nonexistent')) {
        out.push(deny('fs:delete-outside', `\`${a0} -r ${t}\` deletes outside the repository.`));
      }
    } else if (relRoot === '' || relRoot === '.') {
      out.push(deny('fs:delete-root', 'Deleting the whole repository is not allowed.'));
    } else if (!matchAny(ctx.config.paths.cleanable, relRoot)) {
      out.push(ask('repo:delete', `\`${a0} -r ${t}\` deletes a folder inside the repo.`));
    }
  }
  return out;
}

function writerTargets(argv, a0) {
  const args = argv.slice(1);
  switch (a0) {
    case 'tee': return positionals(args);
    case 'cp': case 'install': case 'ln': {
      const f = parseFlags(args, { shortValue: 'tSm', longValue: ['--target-directory', '--suffix', '--mode'] });
      const t = f.short.get('t') ?? f.long.get('--target-directory');
      return typeof t === 'string' ? [t] : f.positional.slice(-1);
    }
    case 'mv': {
      const f = parseFlags(args, { shortValue: 'tS', longValue: ['--target-directory', '--suffix'] });
      return f.positional;
    }
    case 'sed': {
      if (!args.some((a) => /^-[a-zA-Z]*i/.test(a) || a.startsWith('--in-place'))) return [];
      const f = parseFlags(args, { shortValue: 'ef', longValue: ['--expression', '--file'] });
      const script = f.short.has('e') || f.long.has('--expression') || f.short.has('f') ? 0 : 1;
      return f.positional.slice(script);
    }
    case 'perl': return args.some((a) => /^-[a-zA-Z]*i/.test(a)) ? positionals(args, ['-e', '-E']).filter((a) => !/\s/.test(a)) : [];
    case 'dd': return args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3));
    case 'truncate': case 'touch': case 'shred': return positionals(args, ['-s', '--size', '-r', '--reference', '-d', '--date', '-t', '-n', '--iterations']);
    default: return [];
  }
}

// Load tests run only against the local stack (decision 77): k6 on the host, or in a container whose
// image or compose service is k6. A target URL (-e/--env NAME=url, or the container's -e) must be local:
// the allowed and local database hosts, or a one-word name (a compose service such as "api"). k6 cloud
// and --out cloud send the test to Grafana Cloud.
const K6_TARGET = /(^|\/)k6(:|$)|(^|\/)grafana\/k6/;
function loadTest(c, a0, ctx) {
  const inContainer = Boolean(c.container) && K6_TARGET.test(c.target ?? '');
  if (a0 !== 'k6' && !inContainer) return [];
  const args = a0 === 'k6' ? c.argv.slice(1) : c.argv;
  const out = [];
  if (args[0] === 'cloud' || args.some((a, i) => (/^(-o|--out)$/.test(a) && /^cloud\b/.test(args[i + 1] ?? '')) || /^--out=cloud\b/.test(a))) {
    out.push(deny('perf:remote', '`k6 cloud` sends the test to Grafana Cloud. Load tests run locally, against the Compose stack (decision 77).'));
  }
  const local = new Set([...ctx.config.network.allowHosts, ...ctx.config.databases.localHosts].map((h) => h.toLowerCase()));
  const values = [...(c.assigns || []), ...args.flatMap((a, i) => (/^(-e|--env)$/.test(a) ? [args[i + 1] ?? ''] : /^--env=/.test(a) ? [a.slice(6)] : []))];
  for (const v of values) {
    const host = URL_HOST.exec(v.replace(/^[A-Za-z_]\w*=/, ''))?.[1]?.replace(/^\[|\]$/g, '').toLowerCase();
    if (host && !local.has(host) && host.includes('.')) {
      out.push(deny('perf:remote', `Load tests run only against the local stack (decision 77); ${host} is not local. Use the compose service (http://api:8080) or localhost.`));
    }
  }
  return out;
}

export function checkOps(c, a0, ctx) {
  const argv = c.argv;
  const out = [];
  out.push(...loadTest(c, a0, ctx));
  if (['terraform', 'tofu', 'terragrunt'].includes(a0)) out.push(...terraform(argv, a0));
  out.push(...databases(c, a0, ctx));
  if (a0 === 'aws') out.push(...aws(argv));
  if (a0 === 'az') out.push(...az(argv));
  if (a0 === 'gcloud') out.push(...gcloud(argv));
  if (a0 === 'gsutil' && ['cp', 'mv', 'rsync', 'rm'].includes(argv[1])) out.push(cloudWrite('gsutil', [argv[1]]));
  if (a0 === 'kubectl' || a0 === 'oc') out.push(...kubectl(argv));
  if (a0 === 'helm') out.push(...helm(argv));
  if (a0 in DEPLOY_VERBS) out.push(...deployTool(argv, a0));
  if (a0 === 'ansible-playbook' || a0 === 'cap') out.push(argv.some((a) => PROD.test(a)) ? prodDeny(`\`${a0}\``) : ask('deploy', `\`${a0}\` changes remote servers.`));
  if (SCRIPT_RUNNERS.has(a0)) out.push(...scriptRunner(argv, a0));
  if (['ssh', 'scp', 'rsync', 'sftp'].includes(a0)) out.push(...ssh(argv, a0));
  if (['docker', 'docker-compose', 'podman', 'nerdctl'].includes(a0)) out.push(...docker(c, a0));
  if (['curl', 'wget', 'http', 'https', 'xh', 'curlie', 'nc', 'ncat', 'netcat', 'telnet', 'socat'].includes(a0)) out.push(...network(argv, a0, ctx));
  out.push(...dependencies(argv, a0, ctx));
  if (a0 === 'rm' || a0 === 'unlink') out.push(...removal(argv, a0, ctx));
  if (a0 === 'find' && argv.includes('-delete')) out.push(ask('repo:delete', '`find … -delete` deletes files.'));
  for (const t of writerTargets(argv, a0)) out.push(...writeFindings(resolvePath(t, ctx.cwd, ctx.home), ctx, 'Writing'));
  for (const r of c.redirects) {
    if (['>', '>>', '>|', '<>'].includes(r.op) && r.target && !/^\/dev\/(null|stdout|stderr|tty|fd\/\d+)$/.test(r.target)) {
      out.push(...writeFindings(resolvePath(r.target, ctx.cwd, ctx.home), ctx, 'Writing'));
    }
  }
  return out;
}
