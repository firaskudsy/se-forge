#!/usr/bin/env node
// A model server's key (forge llm, decision 140), found without putting it in any command's arguments. Claude Code's
// apiKeyHelper runs `node llm-key.mjs <name>` and sends what it prints to the server; forge llm and forge doctor
// load it in their own process. Agents never run it ([llm:key]). First hit wins:
//   1. macOS Keychain:   security find-generic-password -s se-forge-llm-<name> -a "$USER" -w
//   2. Linux keyring:    secret-tool lookup service se-forge-llm-<name>
//   3. a file:           ${XDG_CONFIG_HOME:-$HOME/.config}/se-forge/llm-<name>-key, readable by its owner only
//                        (the permission check is skipped on Windows, where modes mean nothing)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const keyService = (name) => `se-forge-llm-${name}`;
export const keyFile = (name, env = process.env) => path.join(env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config'), 'se-forge', `llm-${name}-key`);

// { key, source } or { error } (where it looked); the source names the place, never the key.
export function findKey(name, env = process.env) {
  const service = keyService(name);
  const lookup = (cmd, args) => { const r = spawnSync(cmd, args, { encoding: 'utf8', env }); return r.status === 0 ? r.stdout.trim() : ''; };
  let key = lookup('security', ['find-generic-password', '-s', service, '-a', env.USER || os.userInfo().username, '-w']);
  if (key) return { key, source: `macOS Keychain (${service})` };
  key = lookup('secret-tool', ['lookup', 'service', service]);
  if (key) return { key, source: `Secret Service (secret-tool, service ${service})` };
  const file = keyFile(name, env);
  if (fs.existsSync(file)) {
    if (process.platform !== 'win32' && (fs.statSync(file).mode & 0o044)) return { error: `${file} is readable by others; refusing it. Run: chmod 600 "${file}"` };
    key = fs.readFileSync(file, 'utf8').split(/\r?\n/)[0].trim();
    if (key) return { key, source: `file ${file}` };
  }
  return { error: `no key for the model server ${name}. Looked in: the macOS Keychain (service ${service}); the Linux keyring (secret-tool, service ${service}); the file ${file} (chmod 600). See GUIDE.md, H.` };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(new URL(import.meta.url).pathname)) {
  const name = process.argv[2] || '';
  const r = NAME.test(name) ? findKey(name) : { error: 'usage: llm-key.mjs <server name>' };
  if (r.error) { process.stderr.write(`forge llm: ${r.error}\n`); process.exit(1); }
  process.stdout.write(r.key);
}
