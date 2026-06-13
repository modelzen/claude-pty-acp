// Verify ACP loadSession + claude --resume: a session survives a full
// claude-code-acp restart, with history replayed and memory intact.
//
//   Phase A: claude-code-acp #1 -> newSession -> establish a codeword -> kill #1
//   Phase B: claude-code-acp #2 -> loadSession(sameId) -> replay history -> ask recall
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
const entry = join(__dirname, 'src', 'index.ts');
const CWD = process.argv[2] || '/tmp/cc-resume';
const CODEWORD = 'BANANA42';

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';

class C {
  constructor(tag) { this.tag = tag; }
  async requestPermission(p) {
    const o = p.options.find((x) => x.kind?.startsWith('allow')) || p.options[0];
    return { outcome: { outcome: 'selected', optionId: o.optionId } };
  }
  async sessionUpdate(p) {
    const u = p.update;
    if (u.sessionUpdate === 'agent_message_chunk' && u.content.type === 'text')
      console.log(`${ts()} [${this.tag}] 💬 ${u.content.text}`);
    else if (u.sessionUpdate === 'user_message_chunk' && u.content.type === 'text')
      console.log(`${ts()} [${this.tag}] 👤(history) ${u.content.text.slice(0, 60)}`);
    else if (u.sessionUpdate === 'tool_call')
      console.log(`${ts()} [${this.tag}] 🔧(history) ${u.title} (${u.status})`);
  }
  async writeTextFile() { return {}; }
  async readTextFile() { return { content: '' }; }
}

function connect(tag) {
  const proc = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsx', entry], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const stream = acp.ndJsonStream(Writable.toWeb(proc.stdin), Readable.toWeb(proc.stdout));
  const conn = new acp.ClientSideConnection(() => new C(tag), stream);
  return { proc, conn };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ---- Phase A ----
  console.log(`${ts()} === Phase A: 建立会话并记住暗号 ===`);
  const a = connect('A');
  await a.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: {} } });
  const s = await a.conn.newSession({ cwd: CWD, mcpServers: [] });
  const sid = s.sessionId;
  console.log(`${ts()} sessionId=${sid}`);
  await a.conn.prompt({
    sessionId: sid,
    prompt: [{ type: 'text', text: `请记住暗号是 ${CODEWORD}。只回复：好的` }],
  });
  console.log(`${ts()} 杀掉 claude-code-acp #1`);
  a.proc.kill('SIGTERM');
  await sleep(2500); // 等子 claude 退出，释放会话

  // ---- Phase B ----
  console.log(`\n${ts()} === Phase B: 新进程 loadSession 恢复同一会话 ===`);
  const b = connect('B');
  const init = await b.conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: { fs: {} } });
  console.log(`${ts()} loadSession capability = ${init.agentCapabilities?.loadSession}`);
  await b.conn.loadSession({ sessionId: sid, cwd: CWD, mcpServers: [] });
  console.log(`${ts()} 历史回放完毕，提问让它回忆暗号（B 的回复若含 ${CODEWORD} = 记忆恢复成功）`);
  const res = await b.conn.prompt({
    sessionId: sid,
    prompt: [{ type: 'text', text: '我刚才告诉你的暗号是什么？只回复暗号本身。' }],
  });
  await sleep(300);
  b.proc.kill('SIGTERM');

  console.log(`\n${ts()} === 结果 ===`);
  console.log(`stopReason=${res.stopReason}`);
  // 判定：从 B 阶段的回复里找暗号（用文件落盘更稳，这里用日志已足够人工判读）
  process.exit(0);
}

main().catch((e) => { console.error('test-resume error:', e); process.exit(1); });
