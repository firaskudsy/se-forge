// A desktop alert with a sound (decision 155), for forge dashboard --watch when something needs you: macOS's
// Notification Center and its Glass sound; on Linux, notify-send where a desktop runs (a server over ssh has none: the
// watch's bell in your terminal and the page's popup tell you there). The text goes to osascript as arguments, never
// as script. FORGE_ALERT_FILE (tests) gets each alert as a line instead.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';

const quiet = (cmd, args) => { const p = spawn(cmd, args, { stdio: 'ignore', detached: true }); p.on('error', () => {}); p.unref(); };
let notifySend;

export function desktopAlert(title, body, env = process.env) {
  if (env.FORGE_ALERT_FILE) { fs.appendFileSync(env.FORGE_ALERT_FILE, `${JSON.stringify({ title, body })}\n`); return 'file'; }
  if (process.platform === 'darwin') {
    quiet('osascript', ['-e', 'on run argv', '-e', 'display notification (item 2 of argv) with title (item 1 of argv)', '-e', 'end run', title, body]);
    quiet('afplay', ['/System/Library/Sounds/Glass.aiff']);
    return 'macos';
  }
  notifySend ??= spawnSync('sh', ['-c', 'command -v notify-send'], { stdio: 'ignore' }).status === 0;
  if (notifySend && (env.DISPLAY || env.WAYLAND_DISPLAY)) { quiet('notify-send', ['-u', 'critical', title, body]); return 'notify-send'; }
  return null;
}
