#!/usr/bin/env -S npx tsx
// claude-code-acp entry point.
//
// An ACP agent that an ACP client launches as a subprocess and talks to over
// stdio (newline-delimited JSON-RPC). stdout is the protocol channel — all
// logging MUST go to stderr.
//
// Launch it from an ACP client (e.g. Zed `agent_servers`) as:
//   command: "npx", args: ["tsx", "/abs/path/to/claude-code-acp/src/index.ts"]
// or after a build, point at the compiled JS.

import * as acp from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { ClaudeCodeAgent } from './acp-agent.js';

// ACP framing over this process's stdio.
const toClient = Writable.toWeb(process.stdout);
const fromClient = Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>;
const stream = acp.ndJsonStream(toClient as any, fromClient);

new acp.AgentSideConnection((conn) => new ClaudeCodeAgent(conn), stream);

console.error('[claude-code-acp] ACP agent ready on stdio (Claude Code over PTY, subscription path)');
