import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { buildMcpServer } from '../src/mcp-server.js';
import { FreshBooksClient } from '../src/freshbooks/client.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

type Call = { method: string; url: string; params?: unknown };

/** Fake axios instance: records every verb; non-GET verbs throw. */
function fakeHttp(calls: Call[]) {
  const refuse = (method: string) => async (url: string) => {
    calls.push({ method, url });
    throw new Error(`unexpected ${method}`);
  };
  return {
    get: async (url: string, cfg?: { params?: unknown }) => {
      calls.push({ method: 'GET', url, params: cfg?.params });
      if (url === '/auth/api/v1/users/me') {
        return {
          data: {
            response: {
              business_memberships: [
                { business: { id: 111, account_id: 'OTHERACCT' } },
                { business: { id: 222222, account_id: 'TESTACCT' } },
              ],
            },
          },
        };
      }
      return { data: { response: { result: { bills: [], bill: { id: 7 } } } } };
    },
    post: refuse('POST'), put: refuse('PUT'), patch: refuse('PATCH'), delete: refuse('DELETE'), request: refuse('REQUEST'),
  };
}

function clientWith(calls: Call[]) {
  const c = new FreshBooksClient('fake-token-for-tests');
  (c as unknown as { http: unknown }).http = fakeHttp(calls);
  return c;
}

async function callTool(fb: FreshBooksClient, name: string, args: Record<string, unknown>) {
  const { server } = buildMcpServer(() => fb, {});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0.0.0' });
  await server.connect(b);
  await client.connect(a);
  const res = await client.callTool({ name, arguments: args });
  await client.close();
  return res;
}

beforeEach(() => {
  delete process.env.FRESHBOOKS_BUSINESS_ID;
});

test('bills tools only issue GET, scoped to the configured business account', async () => {
  process.env.FRESHBOOKS_BUSINESS_ID = '222222';
  const calls: Call[] = [];
  const fb = clientWith(calls);
  for (const [name, args] of [
    ['list_bills', { vendor_id: 5 }],
    ['get_bill', { bill_id: 7 }],
    ['list_bill_vendors', {}],
  ] as const) {
    const res = await callTool(fb, name, args);
    assert.notEqual(res.isError, true, name);
  }
  assert.ok(calls.length >= 4);
  assert.deepEqual([...new Set(calls.map((c) => c.method))], ['GET']);
  const dataUrls = calls.map((c) => c.url).filter((u) => u.startsWith('/accounting/'));
  assert.deepEqual(dataUrls, [
    '/accounting/account/TESTACCT/bills/bills',
    '/accounting/account/TESTACCT/bills/bills/7',
    '/accounting/account/TESTACCT/bill_vendors/bill_vendors',
  ]);
  assert.equal((calls.find((c) => c.url.endsWith('/bills/bills'))!.params as Record<string, string>)['search[vendorid]'], '5');
});

test('bills tools refuse when FRESHBOOKS_BUSINESS_ID is unset (no data call)', async () => {
  const calls: Call[] = [];
  const res = await callTool(clientWith(calls), 'list_bills', {});
  assert.equal(res.isError, true);
  assert.deepEqual(calls, []);
});

test('bills tools refuse when the login has no membership in the configured business', async () => {
  process.env.FRESHBOOKS_BUSINESS_ID = '999999';
  const calls: Call[] = [];
  const res = await callTool(clientWith(calls), 'list_bill_vendors', {});
  assert.equal(res.isError, true);
  assert.deepEqual(calls.map((c) => c.url), ['/auth/api/v1/users/me']);
});
