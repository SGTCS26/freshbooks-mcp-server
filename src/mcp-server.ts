import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { FreshBooksClient } from './freshbooks/client.js';
import { registerUserTools } from './tools/users.js';
import { registerClientTools } from './tools/clients.js';
import { registerInvoiceTools } from './tools/invoices.js';
import { registerExpenseTools } from './tools/expenses.js';
import { registerPaymentTools } from './tools/payments.js';
import { registerProjectTools } from './tools/projects.js';
import { registerTimeEntryTools } from './tools/time-entries.js';
import { registerItemTools } from './tools/items.js';
import { registerServiceTools } from './tools/services.js';
import { registerBillTools } from './tools/bills.js';
import {
  assertAllowlistKnown,
  isToolAllowed,
  resolveToolPolicy,
  type ToolPolicy,
} from './tool-policy.js';

const MODULES = [
  registerUserTools,
  registerClientTools,
  registerInvoiceTools,
  registerExpenseTools,
  registerPaymentTools,
  registerProjectTools,
  registerTimeEntryTools,
  registerItemTools,
  registerServiceTools,
  registerBillTools,
];

export interface BuiltMcpServer {
  server: McpServer;
  /** Names actually registered (sorted). */
  registered: string[];
  /** Every name a module tried to register (sorted). */
  defined: string[];
  policy: ToolPolicy;
}

/**
 * Build the server, applying the tool policy before any tool reaches the
 * SDK. Tools that the policy rejects are never registered, so they do not
 * appear in tools/list and cannot be called.
 */
export function buildMcpServer(
  getClient: () => FreshBooksClient,
  env: NodeJS.ProcessEnv = process.env
): BuiltMcpServer {
  const policy = resolveToolPolicy(env);
  const server = new McpServer({
    name: 'freshbooks-mcp-server',
    version: '1.0.0',
  });

  const defined: string[] = [];
  const registered: string[] = [];
  const gated = new Proxy(server, {
    get(target, prop, receiver) {
      if (prop === 'tool' || prop === 'registerTool') {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const original = (target as any)[prop].bind(target);
        return (name: string, ...rest: unknown[]) => {
          defined.push(name);
          if (!isToolAllowed(name, policy)) return undefined;
          registered.push(name);
          return original(name, ...rest);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  for (const register of MODULES) register(gated, getClient);
  assertAllowlistKnown(policy, defined);

  return { server, registered: registered.sort(), defined: defined.sort(), policy };
}

/**
 * Create and configure a FreshBooks MCP server.
 *
 * @param getClient  Factory that returns a ready-to-use FreshBooksClient.
 *                   Called fresh for each tool invocation so that token
 *                   refresh can happen transparently.
 */
export function createMcpServer(getClient: () => FreshBooksClient): McpServer {
  return buildMcpServer(getClient).server;
}
