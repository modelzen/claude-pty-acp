// Probe: verify the PermissionRequest hook contract on the local claude build.
// Spawns interactive claude with --permission-mode default + an inline --settings
// PermissionRequest hook, asks it to run a Bash command (which needs approval),
// and checks: (a) what JSON the hook receives, (b) whether returning an "allow"
// decision lets the tool run WITHOUT a TUI prompt (i.e. our schema is correct).
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const pty = require('node-pty');

const CLAUDE = process.env.CC_CLAUDE_BIN || join(homedir(), '.local/bin/claude');
const SID = randomUUID();
mkdirSync('/tmp/cc-perm-probe', { recursive: true });
const CWD = realpathSync('/tmp/cc-perm-probe'); // canonicalize: /tmp -> /private/tmp (trust-key must match)
const HOOK_IN = '/tmp/perm-hook-in.json';
const HOOK = '/tmp/perm-hook.mjs';

// Hook bridge: log stdin, emit an allow decision (testing the documented schema).
writeFileSync(
  HOOK,
  `import { readFileSync, appendFileSync } from 'node:fs';
const raw = readFileSync(0, 'utf8');
appendFileSync(${JSON.stringify(HOOK_IN)}, raw + "\\n");
process.stdout.write(JSON.stringify({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } }
}));
process.exit(0);
`,
);
writeFileSync(HOOK_IN, '');

// Pre-seed trust so no dialog.
try {
  const p = join(homedir(), '.claude.json');
  const c = JSON.parse(readFileSync(p, 'utf8'));
  c.projects = c.projects || {};
  c.projects[CWD] = { ...(c.projects[CWD] || {}), hasTrustDialogAccepted: true };
  writeFileSync(p, JSON.stringify(c, null, 2));
} catch (e) {
  console.log('trust pre-seed failed:', e.message);
}

const settings = JSON.stringify({
  hooks: {
    PermissionRequest: [
      { matcher: '*', hooks: [{ type: 'command', command: `node ${HOOK}`, timeout: 60 }] },
    ],
  },
});

const t0 = Date.now();
const now = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';
console.log(`[probe] session=${SID}`);

const term = pty.spawn(
  CLAUDE,
  ['--session-id', SID, '--permission-mode', 'default', '--settings', settings],
  { name: 'xterm-256color', cols: 120, rows: 40, cwd: CWD,
    env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', FORCE_COLOR: '1' } },
);

let lastData = Date.now(), alt = false, injected = false, trusted = false;
term.onData((d) => {
  lastData = Date.now();
  if (d.includes('\x1b[?1049h')) alt = true;
  if (/\x1b\[(0)?c/.test(d)) term.write('\x1b[?1;2c');
  if (/\x1b\[6n/.test(d)) term.write('\x1b[1;1R');
  // Backup: auto-confirm trust dialog if it shows.
  const plain = d.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').toLowerCase();
  if (!trusted && (plain.includes('trust this folder') || plain.includes('folder you trust'))) {
    trusted = true; setTimeout(() => term.write('\r'), 100);
  }
});
term.onExit((e) => { console.log(`${now()} claude exited code=${e.exitCode}`); finish(); });

const PROMPT = 'Use the Write tool to create a file named hooktest.txt containing exactly: HELLO_FROM_HOOK';
const tick = setInterval(() => {
  if (!injected && alt && Date.now() - lastData > 1200) {
    injected = true;
    console.log(`${now()} injecting prompt (needs Bash permission)`);
    term.write('\x1b[200~' + PROMPT + '\x1b[201~');
    setTimeout(() => term.write('\r'), 150);
    tailTranscript();
  }
}, 250);

function findTranscript() {
  const base = join(homedir(), '.claude', 'projects');
  for (const d of readdirSync(base)) {
    const f = join(base, d, `${SID}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}
let started = false;
function tailTranscript() {
  if (started) return; started = true;
  let off = 0, path = null;
  const poll = setInterval(() => {
    if (!path) { path = findTranscript(); return; }
    let buf; try { buf = readFileSync(path, 'utf8'); } catch { return; }
    if (buf.length <= off) return;
    const chunk = buf.slice(off); off = buf.length;
    for (const line of chunk.split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.type === 'assistant') {
        for (const b of (o.message?.content || [])) {
          if (b.type === 'tool_use') console.log(`${now()} TOOL_USE ${b.name} ${JSON.stringify(b.input)}`);
          if (b.type === 'text') console.log(`${now()} TEXT ${JSON.stringify(b.text)} stop=${o.message.stop_reason}`);
        }
        if (o.message?.stop_reason === 'end_turn') { console.log(`${now()} end_turn`); setTimeout(() => { clearInterval(poll); term.kill(); }, 200); }
      } else if (o.type === 'user') {
        for (const b of (o.message?.content || [])) {
          if (b?.type === 'tool_result') {
            const txt = typeof b.content === 'string' ? b.content : JSON.stringify(b.content);
            console.log(`${now()} TOOL_RESULT ${JSON.stringify(txt).slice(0,120)} err=${!!b.is_error}`);
          }
        }
      }
    }
  }, 200);
}

let done = false;
function finish() {
  if (done) return; done = true;
  clearInterval(tick);
  console.log('\n=== HOOK 收到的 stdin (PermissionRequest 输入实测) ===');
  try { console.log(readFileSync(HOOK_IN, 'utf8').trim() || '(空 — hook 未被触发!)'); } catch { console.log('(无)'); }
  process.exit(0);
}
setTimeout(() => { console.log(`${now()} TIMEOUT`); try { term.kill(); } catch {} finish(); }, 60000);
