import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

// Everything below uses obvious fakes. No network beyond 127.0.0.1 in-process.
const dir = mkdtempSync(join(tmpdir(), 'fbmcp-oauth-test-'));
const SESSIONS = join(dir, 'sessions.json');
process.env.SESSIONS_FILE = SESSIONS;
process.env.CLIENTS_FILE = join(dir, 'clients.json');
process.env.FRESHBOOKS_CLIENT_ID = 'fake-fb-client-id-for-tests';
process.env.FRESHBOOKS_CLIENT_SECRET = 'fake-secret-for-tests';
delete process.env.OAUTH_LEGACY_SESSIONS;

const REDIRECT = 'https://client.example.test/callback';
let base = '';
let server: Server;

before(async () => {
  const axios = (await import('axios')).default;
  // Stub the FreshBooks code exchange in /oauth/callback (no outbound call).
  (axios as unknown as { post: unknown }).post = async () => ({
    data: { access_token: 'fake-fb-access-for-tests', refresh_token: 'fake-fb-refresh-for-tests', expires_in: 43200 },
  });
  const { createHttpServer } = await import('../src/http-server.js');
  server = createHttpServer().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => {
  server?.close();
  rmSync(dir, { recursive: true, force: true });
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

async function register(method = 'client_secret_post', redirect_uris: unknown = [REDIRECT]) {
  const r = await fetch(`${base}/oauth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris, token_endpoint_auth_method: method, client_name: 'test' }),
  });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

function authorizeUrl(q: Record<string, string | undefined>) {
  const u = new URL(`${base}/oauth/authorize`);
  for (const [k, v] of Object.entries(q)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
}

/** Full authorize → (stubbed) FreshBooks callback → our code. */
async function getCode(clientId: string, challenge: string, redirect = REDIRECT) {
  const a = await fetch(
    authorizeUrl({ response_type: 'code', client_id: clientId, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: 'S256', state: 'client-state' }),
    { redirect: 'manual' }
  );
  assert.equal(a.status, 302);
  const fbState = new URL(a.headers.get('location')!).searchParams.get('state')!;
  const cb = await fetch(`${base}/oauth/callback?code=fake-fb-code&state=${encodeURIComponent(fbState)}`, { redirect: 'manual' });
  assert.equal(cb.status, 302);
  const loc = new URL(cb.headers.get('location')!);
  assert.equal(`${loc.origin}${loc.pathname}`, redirect);
  assert.equal(loc.searchParams.get('state'), 'client-state');
  return loc.searchParams.get('code')!;
}

async function token(params: Record<string, string | undefined>, headers: Record<string, string> = {}) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined) body.set(k, v);
  const r = await fetch(`${base}/oauth/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers }, body });
  return { status: r.status, body: (await r.json()) as Record<string, string> };
}

/** Auth gate probe: 401 = rejected by requireAuth; 400 = passed auth (no MCP session id). */
async function bearerStatus(t: string) {
  const r = await fetch(`${base}/sse`, { method: 'POST', headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  await r.arrayBuffer();
  return r.status;
}

const readSessions = () => JSON.parse(readFileSync(SESSIONS, 'utf8')) as Record<string, Record<string, unknown>>;
const writeSessions = (m: Record<string, unknown>) => writeFileSync(SESSIONS, JSON.stringify({ ...readSessions(), ...m }), { mode: 0o600 });

// ── discovery + registration ──────────────────────────────────────────────

test('discovery advertises S256 only', async () => {
  const r = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  assert.deepEqual(r.code_challenge_methods_supported, ['S256']);
});

test('register: pass with redirect_uris; secret stored only as a hash', async () => {
  const { status, body } = await register();
  assert.equal(status, 201);
  const stored = readFileSync(process.env.CLIENTS_FILE!, 'utf8');
  assert.ok(!stored.includes(body.client_secret));
});

test('register: fail without redirect_uris / with bad auth method', async () => {
  assert.equal((await register('client_secret_post', [])).status, 400);
  assert.equal((await register('client_secret_post', ['not a url'])).status, 400);
  assert.equal((await register('private_key_jwt')).status, 400);
});

// ── /oauth/authorize ──────────────────────────────────────────────────────

test('authorize: pass (registered client, exact redirect, S256) and FreshBooks sees an opaque state', async () => {
  const { body: c } = await register();
  const { challenge } = pkce();
  const r = await fetch(authorizeUrl({ client_id: c.client_id, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 's' }), { redirect: 'manual' });
  assert.equal(r.status, 302);
  const fb = new URL(r.headers.get('location')!);
  assert.equal(fb.origin, 'https://auth.freshbooks.com');
  assert.ok(!fb.searchParams.get('state')!.includes(REDIRECT));
});

test('authorize: fail on unknown client_id', async () => {
  const { challenge } = pkce();
  const r = await fetch(authorizeUrl({ client_id: 'not-registered', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
  assert.equal(r.status, 400);
});

test('authorize: fail when redirect_uri is not an exact match', async () => {
  const { body: c } = await register();
  const { challenge } = pkce();
  for (const bad of [`${REDIRECT}/`, `${REDIRECT}?x=1`, 'https://client.example.test/CALLBACK', 'https://evil.example.test/callback', undefined]) {
    const r = await fetch(authorizeUrl({ client_id: c.client_id, redirect_uri: bad, code_challenge: challenge, code_challenge_method: 'S256' }), { redirect: 'manual' });
    assert.equal(r.status, 400, String(bad));
  }
});

test('authorize: fail on PKCE missing, plain, or missing method', async () => {
  const { body: c } = await register();
  const { challenge } = pkce();
  for (const q of [
    { code_challenge: undefined, code_challenge_method: 'S256' },
    { code_challenge: challenge, code_challenge_method: 'plain' },
    { code_challenge: challenge, code_challenge_method: undefined },
    { code_challenge: 'short', code_challenge_method: 'S256' },
  ]) {
    const r = await fetch(authorizeUrl({ client_id: c.client_id, redirect_uri: REDIRECT, ...q }), { redirect: 'manual' });
    assert.equal(r.status, 400, JSON.stringify(q));
  }
});

test('callback: fail on a forged / unknown state', async () => {
  const forged = Buffer.from(JSON.stringify({ redirect_uri: 'https://evil.example.test/', state: 'x', client_id: 'y' })).toString('base64url');
  const r = await fetch(`${base}/oauth/callback?code=fake-fb-code&state=${forged}`, { redirect: 'manual' });
  assert.equal(r.status, 400);
});

// ── /oauth/token (authorization_code) ─────────────────────────────────────

test('token: pass with client_secret_post + redirect_uri + verifier', async () => {
  const { body: c } = await register();
  const { verifier, challenge } = pkce();
  const code = await getCode(c.client_id, challenge);
  const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(r.status, 200);
  assert.equal(await bearerStatus(r.body.access_token), 400);
});

test('token: pass with client_secret_basic', async () => {
  const { body: c } = await register('client_secret_basic');
  const { verifier, challenge } = pkce();
  const code = await getCode(c.client_id, challenge);
  const basic = Buffer.from(`${c.client_id}:${c.client_secret}`).toString('base64');
  const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier }, { authorization: `Basic ${basic}` });
  assert.equal(r.status, 200);
});

test('token: public client (auth method none) passes with PKCE only', async () => {
  const { body: c } = await register('none');
  const { verifier, challenge } = pkce();
  const code = await getCode(c.client_id, challenge);
  const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.client_id });
  assert.equal(r.status, 200);
});

test('token: fail on wrong / missing client_secret and unknown client', async () => {
  const { body: c } = await register();
  const { verifier, challenge } = pkce();
  for (const creds of [
    { client_id: c.client_id, client_secret: 'wrong-fake-secret' },
    { client_id: c.client_id, client_secret: undefined },
    { client_id: 'not-registered', client_secret: c.client_secret },
  ]) {
    const code = await getCode(c.client_id, challenge);
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, ...creds });
    assert.equal(r.status, 401, JSON.stringify(creds.client_secret === undefined ? 'missing' : creds.client_id));
    assert.equal(r.body.error, 'invalid_client');
  }
});

test('token: fail on redirect_uri mismatch or omission', async () => {
  const { body: c } = await register();
  const { verifier, challenge } = pkce();
  for (const redirect_uri of [`${REDIRECT}/`, undefined]) {
    const code = await getCode(c.client_id, challenge);
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri, code_verifier: verifier, client_id: c.client_id, client_secret: c.client_secret });
    assert.equal(r.status, 400);
  }
});

test('token: fail on missing or wrong code_verifier', async () => {
  const { body: c } = await register();
  const { challenge } = pkce();
  for (const code_verifier of [undefined, pkce().verifier]) {
    const code = await getCode(c.client_id, challenge);
    const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier, client_id: c.client_id, client_secret: c.client_secret });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'invalid_grant');
  }
});

test('token: fail when another client redeems the code, and codes are single-use', async () => {
  const { body: a } = await register();
  const { body: b } = await register();
  const { verifier, challenge } = pkce();
  const code = await getCode(a.client_id, challenge);
  const stolen = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: b.client_id, client_secret: b.client_secret });
  assert.equal(stolen.status, 400);
  const retry = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: a.client_id, client_secret: a.client_secret });
  assert.equal(retry.status, 400);
});

// ── Bearer checks (requireAuth) ───────────────────────────────────────────

async function issued() {
  const { body: c } = await register();
  const { verifier, challenge } = pkce();
  const code = await getCode(c.client_id, challenge);
  const r = await token({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.client_id, client_secret: c.client_secret });
  return { c, access: r.body.access_token, refresh: r.body.refresh_token };
}

const FUTURE = () => Date.now() + 6 * 3600 * 1000;

test('bearer: refresh token is rejected as Bearer (new and legacy format)', async () => {
  const { refresh } = await issued();
  assert.equal(await bearerStatus(refresh), 401);
  writeSessions({
    'legacy-session-fake': { access_token: 'fake-fb-access-legacy', refresh_token: 'fake-fb-refresh-legacy', expires_at: FUTURE() },
    'legacy-refresh-fake': { access_token: 'legacy-session-fake', refresh_token: 'fake-fb-refresh-legacy', expires_at: FUTURE() },
  });
  assert.equal(await bearerStatus('legacy-refresh-fake'), 401);
});

test('bearer: expired session is rejected; live one passes', async () => {
  const { access } = await issued();
  assert.equal(await bearerStatus(access), 400);
  const s = readSessions();
  writeSessions({ [access]: { ...s[access], session_expires_at: Date.now() - 1000 } });
  assert.equal(await bearerStatus(access), 401);
});

test('bearer: legacy session (no TTL fields) still passes by default and is not rewritten', async () => {
  const entry = { access_token: 'fake-fb-access-legacy2', refresh_token: 'fake-fb-refresh-legacy2', expires_at: FUTURE() };
  writeSessions({ 'legacy-session-2': entry });
  assert.equal(await bearerStatus('legacy-session-2'), 400);
  assert.deepEqual(readSessions()['legacy-session-2'], entry);
});

test('bearer: OAUTH_LEGACY_SESSIONS=deny rejects legacy sessions', async () => {
  writeSessions({ 'legacy-session-3': { access_token: 'fake-fb-access-legacy3', refresh_token: 'fake-fb-refresh-legacy3', expires_at: FUTURE() } });
  process.env.OAUTH_LEGACY_SESSIONS = 'deny';
  try {
    assert.equal(await bearerStatus('legacy-session-3'), 401);
  } finally {
    delete process.env.OAUTH_LEGACY_SESSIONS;
  }
});

// ── /oauth/token (refresh_token) ──────────────────────────────────────────

test('refresh: pass with the bound client; fail without / with another client', async () => {
  const { c, refresh } = await issued();
  const { body: other } = await register();
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refresh })).status, 401);
  assert.equal((await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: other.client_id, client_secret: other.client_secret })).status, 400);
  const ok = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(ok.status, 200);
  assert.equal(await bearerStatus(ok.body.access_token), 400);
});

test('refresh: expired refresh token rejected', async () => {
  const { c, refresh } = await issued();
  const s = readSessions();
  writeSessions({ [refresh]: { ...s[refresh], session_expires_at: Date.now() - 1000 } });
  const r = await token({ grant_type: 'refresh_token', refresh_token: refresh, client_id: c.client_id, client_secret: c.client_secret });
  assert.equal(r.status, 400);
});

test('refresh: legacy refresh token still rotates by default; denied under OAUTH_LEGACY_SESSIONS=deny', async () => {
  writeSessions({
    'legacy-session-4': { access_token: 'fake-fb-access-legacy4', refresh_token: 'fake-fb-refresh-legacy4', expires_at: FUTURE() },
    'legacy-refresh-4': { access_token: 'legacy-session-4', refresh_token: 'fake-fb-refresh-legacy4', expires_at: FUTURE() },
    'legacy-session-5': { access_token: 'fake-fb-access-legacy5', refresh_token: 'fake-fb-refresh-legacy5', expires_at: FUTURE() },
    'legacy-refresh-5': { access_token: 'legacy-session-5', refresh_token: 'fake-fb-refresh-legacy5', expires_at: FUTURE() },
  });
  const ok = await token({ grant_type: 'refresh_token', refresh_token: 'legacy-refresh-4' });
  assert.equal(ok.status, 200);
  const rotated = readSessions()[ok.body.access_token];
  assert.equal(rotated.kind, 'access');
  assert.equal(typeof rotated.session_expires_at, 'number');
  process.env.OAUTH_LEGACY_SESSIONS = 'deny';
  try {
    assert.equal((await token({ grant_type: 'refresh_token', refresh_token: 'legacy-refresh-5' })).status, 400);
  } finally {
    delete process.env.OAUTH_LEGACY_SESSIONS;
  }
});
