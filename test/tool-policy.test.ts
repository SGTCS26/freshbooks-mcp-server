import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServer } from '../src/mcp-server.js';
import { FreshBooksClient } from '../src/freshbooks/client.js';
import { resolveToolPolicy, isReadTool, ToolPolicyError } from '../src/tool-policy.js';
import { listToolNames, WRITE_TOOLS, READ_TOOLS } from './helpers.js';

const fake = () => new FreshBooksClient('fake-token-for-tests');

test('defined tool set is 24 read + 14 write (38) and classification matches', () => {
  const { defined } = buildMcpServer(fake, {});
  assert.deepEqual(defined, [...READ_TOOLS, ...WRITE_TOOLS].sort());
  assert.deepEqual(defined.filter((n) => !isReadTool(n)), WRITE_TOOLS);
});

test('default config (empty env): tools/list has zero write tools', async () => {
  const { server, policy } = buildMcpServer(fake, {});
  assert.equal(policy.readOnly, true);
  const names = await listToolNames(server);
  assert.deepEqual(names, READ_TOOLS);
  assert.deepEqual(names.filter((n) => WRITE_TOOLS.includes(n)), []);
});

test('MCP_READ_ONLY=true: zero write tools', async () => {
  const names = await listToolNames(buildMcpServer(fake, { MCP_READ_ONLY: 'true' }).server);
  assert.deepEqual(names, READ_TOOLS);
});

test('NODE_ENV=production forces read-only even with MCP_READ_ONLY=0 and writes allowlisted', async () => {
  const env = { NODE_ENV: 'production', MCP_READ_ONLY: '0', TOOL_ALLOWLIST: 'list_clients,delete_client,send_invoice,create_payment' };
  const built = buildMcpServer(fake, env);
  assert.equal(built.policy.readOnly, true);
  assert.deepEqual(await listToolNames(built.server), ['list_clients']);
});

test('allowlist (read-only on) enables only the named read tools', async () => {
  const names = await listToolNames(buildMcpServer(fake, { TOOL_ALLOWLIST: 'list_bills, get_bill' }).server);
  assert.deepEqual(names, ['get_bill', 'list_bills']);
});

test('allowlist + read-only on: a listed write tool is still not registered', async () => {
  const names = await listToolNames(buildMcpServer(fake, { TOOL_ALLOWLIST: 'list_clients,delete_client' }).server);
  assert.deepEqual(names, ['list_clients']);
});

test('read-only off: only explicitly allowlisted write tools appear', async () => {
  const env = { MCP_READ_ONLY: 'false', TOOL_ALLOWLIST: 'list_clients,create_time_entry' };
  const names = await listToolNames(buildMcpServer(fake, env).server);
  assert.deepEqual(names, ['create_time_entry', 'list_clients']);
});

test('read-only off with empty or unset allowlist is a hard error', () => {
  assert.throws(() => buildMcpServer(fake, { MCP_READ_ONLY: 'off' }), ToolPolicyError);
  assert.throws(() => buildMcpServer(fake, { MCP_READ_ONLY: 'off', TOOL_ALLOWLIST: ' , ' }), ToolPolicyError);
});

test('unknown allowlist name fails startup (no fail-open)', () => {
  assert.throws(() => buildMcpServer(fake, { TOOL_ALLOWLIST: 'list_clients,drop_everything' }), /unknown tools: drop_everything/);
});

test('MCP_READ_ONLY parsing: only explicit falsy values turn it off', () => {
  for (const v of ['1', 'true', 'yes', '', 'garbage']) {
    assert.equal(resolveToolPolicy({ MCP_READ_ONLY: v }).readOnly, true, v);
  }
  for (const v of ['0', 'false', 'OFF', 'no']) {
    assert.equal(resolveToolPolicy({ MCP_READ_ONLY: v, TOOL_ALLOWLIST: 'list_clients' }).readOnly, false, v);
  }
});
