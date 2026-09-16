#!/usr/bin/env node
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { homedir } from 'node:os';
import { join } from 'node:path';

const CP = join(homedir(), 'CascadeProjects');
const FB = join(CP, 'freshbooks-mcp-server');
const TOKEN = join(CP, 'apps/silvergate/financial-intelligence/data/freshbooks_token.json');

const transport = new StdioClientTransport({
  command: '/opt/homebrew/bin/node',
  args: [join(FB, 'dist/index.js')],
  cwd: FB,
  env: {
    ...process.env,
    MODE: 'stdio',
    FRESHBOOKS_TOKEN_PATH: TOKEN,
    PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
  },
});

const client = new Client({ name: 'spine-fb-mcp-smoke', version: '1.0.0' });
await client.connect(transport);
const result = await client.callTool({ name: 'list_clients', arguments: { per_page: 5 } });
const text = (result.content || [])
  .filter((c) => c.type === 'text')
  .map((c) => c.text)
  .join('\n');
// Never print raw payloads with PII beyond counts — summarize
let n = null;
try {
  const j = JSON.parse(text);
  if (Array.isArray(j)) n = j.length;
  else if (j && typeof j === 'object') {
    if (Array.isArray(j.clients)) n = j.clients.length;
    else if (Array.isArray(j.data)) n = j.data.length;
    else if (typeof j.total === 'number') n = j.total;
    else if (typeof j.count === 'number') n = j.count;
  }
} catch {
  // text may be markdown/summary
  const m = text.match(/(\d+)\s+client/i) || text.match(/"id"\s*:/g);
  if (m && m[0] && /^\d+/.test(m[0])) n = parseInt(m[0], 10);
  else if (Array.isArray(m)) n = m.length;
}
const preview = text.slice(0, 180).replace(/\s+/g, ' ');
console.log(JSON.stringify({
  ok: !result.isError,
  isError: !!result.isError,
  page_or_count: n,
  text_len: text.length,
  preview_sanitized: preview.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]'),
}));
await client.close();
process.exit(result.isError ? 1 : 0);
