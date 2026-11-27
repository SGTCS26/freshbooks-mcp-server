import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

/** Real MCP tools/list over an in-memory transport (no network). */
export async function listToolNames(server: McpServer): Promise<string[]> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(serverSide);
  await client.connect(clientSide);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name).sort();
}

export const WRITE_TOOLS = [
  'create_client', 'create_expense', 'create_invoice', 'create_payment',
  'create_project', 'create_time_entry', 'delete_client', 'delete_time_entry',
  'send_invoice', 'update_client', 'update_expense', 'update_invoice',
  'update_project', 'update_time_entry',
].sort();

export const READ_TOOLS = [
  'get_bill', 'get_client', 'get_current_user', 'get_expense', 'get_invoice',
  'get_item', 'get_payment', 'get_project', 'get_service', 'get_service_rate',
  'get_team_member', 'get_time_entry', 'list_bill_vendors', 'list_bills',
  'list_clients', 'list_expenses', 'list_invoices', 'list_items', 'list_payments',
  'list_project_service_rates', 'list_projects', 'list_services',
  'list_team_members', 'list_time_entries',
].sort();
