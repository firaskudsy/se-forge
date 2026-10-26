// A self-hosted model server in place of Claude's (forge llm, decision 140): which one a checkout runs on, and the
// servers this machine knows. forge llm use <name> records the choice in .forge/state/llm.json; forge sync writes
// its address, model names and key helper into .claude/settings.local.json.
import fs from 'node:fs';
import path from 'node:path';

// The machine's settings, as forge's userConfigFile finds them: { llm: { <name>: { url, models } } }.
export const userConfigPath = (env, home) => env.FORGE_USER_CONFIG || path.join(home, '.config', 'se-forge', 'config.json');

// The server this checkout runs on, or null (Claude).
export function llmInUse(stateDir) {
  try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'llm.json'), 'utf8')).server || null; } catch { return null; }
}

// The names of the servers this machine knows (none when its settings cannot be read).
export function llmNames(env, home) {
  try { return Object.keys(JSON.parse(fs.readFileSync(userConfigPath(env, home), 'utf8')).llm || {}); } catch { return []; }
}
