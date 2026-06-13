// Minimal ACP CLIENT for verifying claude-code-acp end-to-end — no editor needed.
//
// It spawns claude-code-acp (the ACP agent), performs the real ACP handshake over
// stdio, sends a prompt, and prints every session/update as it streams in.
//
// Usage:
//   node test-client.mjs "your prompt here" [cwd]
//
// This exercises the exact protocol path Zed / JetBrains / neovim would use,
// while the backend runs interactive Claude Code on the subscription plan.

import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { Writable, Readable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Default: run TS source via tsx. Set CC_BUILT=1 to drive the compiled dist/.
const useBuilt = process.env.CC_BUILT === '1';
const agentEntry = join(__dirname, useBuilt ? 'dist' : 'src', useBuilt ? 'index.js' : 'index.ts');

const PROMPT = process.argv[2] || '用一句话介绍你自己，然后说“claude-code-acp works”。';
const CWD = process.argv[3] || process.cwd();

// Opt into the streaming-preview extension so the agent streams provisional
// reply chunks (typewriter) and then a final full-text replace. CC_PREVIEW on
// the agent side overrides; CC_NO_EXT=1 here simulates an unaware client.
const EXT = 'claude-code-acp/streaming-preview';
const optInExt = process.env.CC_NO_EXT !== '1';

const t0 = Date.now();
const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + 's';

class VerifyClient {
  // Auto-decide permissions so the run is non-interactive; log what was asked.
  // Set CC_TEST_DENY=1 to reject instead of allow (to verify the deny path).
  async requestPermission(params) {
    const deny = process.env.CC_TEST_DENY === '1';
    const want = deny ? 'reject' : 'allow';
    const opt =
      params.options.find((o) => o.kind?.startsWith(want)) ||
      params.options.find((o) => o.optionId === want) ||
      params.options[0];
    console.log(`${ts()} 🔐 permission: ${params.toolCall?.title} -> auto "${opt?.name}"`);
    return { outcome: { outcome: 'selected', optionId: opt.optionId } };
  }

  async sessionUpdate(params) {
    const u = params.update;
    const ext = params._meta?.[EXT]; // our streaming-preview extension marker
    switch (u.sessionUpdate) {
      case 'agent_message_chunk':
        if (u.content.type !== 'text') break;
        if (ext?.provisional) {
          // Streaming preview into the message channel — a capable client would
          // render this live and discard it when the replace arrives.
          process.stdout.write(`${ts()} ✏️·prov ${u.content.text.replace(/\n$/, '')}\n`);
        } else if (ext?.replaceProvisional) {
          process.stdout.write(`${ts()} ♻️·FINAL(replace provisional) ↓\n${u.content.text}\n`);
        } else {
          process.stdout.write(`${ts()} 💬 ${u.content.text}\n`);
        }
        break;
      case 'agent_thought_chunk':
        if (u.content.type === 'text')
          process.stdout.write(`${ts()} 🤔 ${u.content.text.slice(0, 80)}…\n`);
        break;
      case 'tool_call':
        console.log(`${ts()} 🔧 ${u.title} [${u.kind}] (${u.status})`);
        break;
      case 'tool_call_update':
        console.log(`${ts()} 🔧 ${u.toolCallId} -> ${u.status}`);
        break;
      case 'plan':
        console.log(`${ts()} 📋 plan (${u.entries.length} entries):`);
        for (const e of u.entries) console.log(`         [${e.status}/${e.priority}] ${e.content}`);
        break;
      default:
        break;
    }
  }

  async writeTextFile() {
    return {};
  }
  async readTextFile() {
    return { content: '' };
  }
}

async function main() {
  const cmd = useBuilt ? 'node' : process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const cmdArgs = useBuilt ? [agentEntry] : ['tsx', agentEntry];
  console.log(`${ts()} spawning claude-code-acp: ${cmd} ${cmdArgs.join(' ')}`);
  const agent = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'inherit'] });

  const input = Writable.toWeb(agent.stdin);
  const output = Readable.toWeb(agent.stdout);
  const stream = acp.ndJsonStream(input, output);
  const conn = new acp.ClientSideConnection(() => new VerifyClient(), stream);

  const init = await conn.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      ...(optInExt ? { _meta: { [EXT]: { provisionalReplace: true } } } : {}),
    },
  });
  const mode = init.agentCapabilities?._meta?.[EXT] ? 'ext-advertised' : 'plain';
  console.log(`${ts()} ✅ initialized (protocol v${init.protocolVersion}, ${mode}, optIn=${optInExt})`);

  console.log(`${ts()} … booting interactive claude (newSession)`);
  // CC_TEST_MCP=<server.mjs> forwards a stdio MCP server via newSession.mcpServers.
  const mcpServers = [];
  if (process.env.CC_TEST_MCP) {
    mcpServers.push({ name: 'testmcp', command: 'node', args: [process.env.CC_TEST_MCP], env: [] });
    console.log(`${ts()} 🔌 forwarding stdio MCP server: ${process.env.CC_TEST_MCP}`);
  }
  const session = await conn.newSession({ cwd: CWD, mcpServers });
  console.log(`${ts()} 📝 session ${session.sessionId} ready`);

  // CC_TEST_IMAGE=<path> attaches the image as an ACP image block, to verify
  // the agent materializes it to a temp file the TUI can read.
  const promptBlocks = [{ type: 'text', text: PROMPT }];
  if (process.env.CC_TEST_IMAGE) {
    const p = process.env.CC_TEST_IMAGE;
    const mime =
      extname(p) === '.jpg' || extname(p) === '.jpeg'
        ? 'image/jpeg'
        : extname(p) === '.gif'
          ? 'image/gif'
          : extname(p) === '.webp'
            ? 'image/webp'
            : 'image/png';
    promptBlocks.push({ type: 'image', data: readFileSync(p).toString('base64'), mimeType: mime });
    console.log(`${ts()} 🖼️  attached image ${p} (${mime})`);
  }
  console.log(`${ts()} 💬 USER: ${PROMPT}\n`);
  const res = await conn.prompt({ sessionId: session.sessionId, prompt: promptBlocks });
  console.log(`\n${ts()} ✅ turn complete: stopReason=${res.stopReason}`);

  agent.kill();
  process.exit(0);
}

main().catch((e) => {
  console.error('test-client error:', e);
  process.exit(1);
});
