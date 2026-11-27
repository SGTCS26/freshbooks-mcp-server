#!/usr/bin/env node

// loadEnv must run before any module that reads process.env at import time.
// All other imports are dynamic so they happen after the env is populated.
import { loadEnv } from './load-env.js';
loadEnv();

const { config } = await import('./config.js');

// --print-tools: print the tool names this env would register, then exit.
// No network, no FreshBooks call, no token needed.
if (process.argv.includes('--print-tools')) {
  const { buildMcpServer } = await import('./mcp-server.js');
  const { FreshBooksClient } = await import('./freshbooks/client.js');
  const built = buildMcpServer(() => new FreshBooksClient(''));
  console.log(JSON.stringify({ read_only: built.policy.readOnly, tools: built.registered }));
  process.exit(0);
}

if (config.server.mode === 'http') {
  const { startHttpServer } = await import('./http-server.js');
  await startHttpServer();
} else {
  const { startStdioServer } = await import('./stdio-server.js');
  await startStdioServer();
}
