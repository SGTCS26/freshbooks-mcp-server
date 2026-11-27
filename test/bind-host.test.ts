import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import express from 'express';

// config.ts reads credentials at import time: set fakes before importing it.
process.env.FRESHBOOKS_CLIENT_ID = 'fake-fb-client-id-for-tests';
process.env.FRESHBOOKS_CLIENT_SECRET = 'fake-secret-for-tests';
const { resolveBindHost } = await import('../src/config.js');

test('bind host defaults to 127.0.0.1 when HOST is unset or empty', () => {
  assert.equal(resolveBindHost({}), '127.0.0.1');
  assert.equal(resolveBindHost({ HOST: '' }), '127.0.0.1');
});

test('whitespace-only HOST falls back to 127.0.0.1; surrounding whitespace is trimmed', () => {
  assert.equal(resolveBindHost({ HOST: '   ' }), '127.0.0.1');
  assert.equal(resolveBindHost({ HOST: ' 127.0.0.1 \n' }), '127.0.0.1');
});

test('HOST override is honored', () => {
  assert.equal(resolveBindHost({ HOST: '0.0.0.0' }), '0.0.0.0');
  assert.equal(resolveBindHost({ HOST: '::1' }), '::1');
});

test('MCP_BIND_HOST is not a knob (only HOST is read)', () => {
  assert.equal(resolveBindHost({ MCP_BIND_HOST: '0.0.0.0' }), '127.0.0.1');
});

// ── Both listen paths receive the resolved host ─────────────────────────────
// startHttpServer() is run with listen()/createServer() stubbed, so no socket
// is opened. Fake credentials only (set above).

const realAppListen = express.application.listen;
const realCreateServer = https.createServer;
after(() => {
  express.application.listen = realAppListen;
  (https as unknown as { createServer: unknown }).createServer = realCreateServer;
  delete process.env.HOST;
});

async function captureListen(useHttps: boolean, host: string | undefined) {
  if (host === undefined) delete process.env.HOST;
  else process.env.HOST = host;
  const calls: { path: 'http' | 'https'; args: unknown[] }[] = [];
  express.application.listen = function (...args: unknown[]) {
    calls.push({ path: 'http', args });
    return undefined as never;
  } as typeof express.application.listen;
  (https as unknown as { createServer: unknown }).createServer = () => ({
    listen: (...args: unknown[]) => {
      calls.push({ path: 'https', args });
    },
  });
  const { config } = await import('../src/config.js');
  (config.server as { https: boolean }).https = useHttps;
  const { startHttpServer } = await import('../src/http-server.js');
  await startHttpServer();
  assert.equal(calls.length, 1);
  return { path: calls[0].path, port: calls[0].args[0], host: calls[0].args[1], cb: typeof calls[0].args[2] };
}

test('plain HTTP branch: app.listen(port, resolvedHost, cb)', async () => {
  assert.deepEqual(await captureListen(false, undefined), { path: 'http', port: 3000, host: '127.0.0.1', cb: 'function' });
  assert.deepEqual(await captureListen(false, '0.0.0.0'), { path: 'http', port: 3000, host: '0.0.0.0', cb: 'function' });
});

test('HTTPS branch: https.createServer(...).listen(port, resolvedHost, cb)', async () => {
  assert.deepEqual(await captureListen(true, undefined), { path: 'https', port: 3443, host: '127.0.0.1', cb: 'function' });
  assert.deepEqual(await captureListen(true, ' 0.0.0.0 '), { path: 'https', port: 3443, host: '0.0.0.0', cb: 'function' });
});
