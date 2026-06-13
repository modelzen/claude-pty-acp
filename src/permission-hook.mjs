// PermissionRequest hook bridge.
//
// Claude Code runs this as the PermissionRequest hook command (registered via
// --settings when claude-code-acp spawns the session). It receives the permission
// request JSON on stdin, forwards it to claude-code-acp over a unix socket, waits for
// the ACP client's decision, and prints the hook decision back to Claude Code.
//
// Contract (verified empirically on Claude Code 2.1.170):
//   stdin  : { session_id, tool_name, tool_input, cwd, permission_mode, ... }
//   stdout : { hookSpecificOutput: { hookEventName: "PermissionRequest",
//                                    decision: { behavior: "allow"|"deny" } } }
//
// On any error (socket unreachable / timeout) we DENY — never hang, never
// silently allow.
import net from 'node:net';
import { readFileSync } from 'node:fs';

const SOCK = process.env.CC_PERMISSION_SOCK;

function emit(behavior, updatedInput) {
  const decision = { behavior };
  if (updatedInput) decision.updatedInput = updatedInput;
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision },
    }),
  );
  process.exit(0);
}

let raw = '';
try {
  raw = readFileSync(0, 'utf8');
} catch {
  emit('deny');
}

if (!SOCK) emit('deny'); // not run under claude-code-acp

const sock = net.createConnection(SOCK);
let buf = '';
let settled = false;

const done = (behavior, updatedInput) => {
  if (settled) return;
  settled = true;
  try {
    sock.destroy();
  } catch {
    /* ignore */
  }
  emit(behavior, updatedInput);
};

// Match claude-code-acp's PermissionRequest hook timeout headroom.
const timer = setTimeout(() => done('deny'), 590_000);

sock.on('connect', () => sock.write(raw.trim() + '\n'));
sock.on('data', (d) => {
  buf += d.toString();
  const nl = buf.indexOf('\n');
  if (nl < 0) return;
  clearTimeout(timer);
  try {
    const resp = JSON.parse(buf.slice(0, nl));
    done(resp.behavior === 'allow' ? 'allow' : 'deny', resp.updatedInput);
  } catch {
    done('deny');
  }
});
sock.on('error', () => {
  clearTimeout(timer);
  done('deny');
});
