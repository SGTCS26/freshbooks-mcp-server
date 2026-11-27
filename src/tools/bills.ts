import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { FreshBooksClient } from '../freshbooks/client.js';

/**
 * Read-only FreshBooks Bills tools. Every call is an HTTP GET, and every call
 * is scoped to the business named by FRESHBOOKS_BUSINESS_ID (refused when
 * unset or when the token has no membership in that business).
 */
export function registerBillTools(server: McpServer, getClient: () => FreshBooksClient) {
  server.tool(
    'list_bills',
    'List FreshBooks bills (accounts payable) for the configured business. Read-only.',
    {
      page: z.number().int().positive().optional().describe('Page number (default: 1)'),
      per_page: z.number().int().positive().max(100).optional().describe('Results per page (default: 25)'),
      vendor_id: z.number().int().positive().optional().describe('Filter by bill vendor ID'),
    },
    async ({ page, per_page, vendor_id }) => {
      const result = await getClient().listBills({ page, per_page, vendor_id });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );

  server.tool(
    'get_bill',
    'Get one FreshBooks bill by ID for the configured business. Read-only.',
    {
      bill_id: z.number().int().positive().describe('The FreshBooks bill ID'),
    },
    async ({ bill_id }) => {
      const bill = await getClient().getBill(bill_id);
      return { content: [{ type: 'text', text: JSON.stringify(bill, null, 2) }] };
    }
  );

  server.tool(
    'list_bill_vendors',
    'List FreshBooks bill vendors for the configured business. Read-only.',
    {
      page: z.number().int().positive().optional().describe('Page number (default: 1)'),
      per_page: z.number().int().positive().max(100).optional().describe('Results per page (default: 25)'),
    },
    async ({ page, per_page }) => {
      const result = await getClient().listBillVendors({ page, per_page });
      return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
    }
  );
}
