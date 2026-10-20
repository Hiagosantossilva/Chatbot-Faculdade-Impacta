import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileStore, createRedisStore, type LimitStore } from '../lib/limitStore.js';
import { clientIdentity, createUsageGuard, UsageError, type ClientContext } from '../lib/usageGuard.js';
import { createLlmClient } from '../lib/llmClient.js';
import { handleChat } from '../lib/chat.js';

const secret = { RATE_LIMIT_SECRET: 'test-only-secret-with-32-characters' };
const context = (ip = '203.0.113.4', cookie = ''): ClientContext => ({ ip, headers: { cookie } });
const cookieOf = (session: Awaited<ReturnType<ReturnType<typeof createUsageGuard>['enter']>>) => session.headers['Set-Cookie']?.split(';')[0] || '';
async function fixture(t: TestContext, config: Record<string, string> = {}) {
  const folder = await mkdtemp(join(tmpdir(), 'impacta-limits-'));
  const filename = join(folder, 'usage.json');
  let time = Date.UTC(2026, 9, 20, 12);
  const env = { ...secret, ...config };
  const make = () => createUsageGuard(env, { store: createFileStore(filename), now: () => time });
  t.after(async () => { await rm(filename, { force: true }); await rmdir(folder); });
  return { guard: make(), make, filename, setTime: (value: number) => { time = value; }, advance: (ms: number) => { time += ms; } };
}

test('cookie é assinado, HttpOnly e estável; IP e identificador não ficam em texto puro', () => {
  const first = clientIdentity(context(), secret);
  assert.match(first.cookie!, /HttpOnly; SameSite=Lax/);
  const cookie = first.cookie!.split(';')[0];
  const second = clientIdentity(context('203.0.113.4', cookie), secret);
  assert.equal(first.browser, second.browser);
  assert.equal(second.cookie, undefined);
  assert.notEqual(clientIdentity(context('203.0.113.4', cookie + 'tampered'), secret).browser, first.browser);
  assert.equal(clientIdentity({ ...context(), headers: { 'x-forwarded-for': '8.8.8.8' } }, secret).ip, first.ip);
  const ipv6a = clientIdentity(context('2001:db8:abcd:12::1'), secret);
  const ipv6b = clientIdentity(context('2001:db8:abcd:12::ffff'), secret);
  assert.equal(ipv6a.ip, ipv6b.ip);
  const vercel = clientIdentity({ headers: { 'x-vercel-forwarded-for': '203.0.113.4' } }, { ...secret, VERCEL: '1' });
  assert.equal(vercel.ip, first.ip);
  assert.match(vercel.cookie!, /Secure/);
});

test('cooldown bloqueia antes de chamar o modelo; não é zerado ao trocar IP', async t => {
  const f = await fixture(t);
  let calls = 0;
  const reply = async () => { calls++; return 'Olá'; };
  const first = await handleChat('POST', { message: 'Oi' }, reply, { context: context(), guard: f.guard });
  const cookie = first.headers!['Set-Cookie'].split(';')[0];
  const denied = await handleChat('POST', { message: 'Outra' }, reply, { context: context('203.0.113.99', cookie), guard: f.guard });
  assert.equal(denied.status, 429);
  assert.equal(calls, 1);
  assert.equal(denied.headers!['Retry-After'], '10');
  f.advance(11000);
  assert.equal((await handleChat('POST', { message: 'Agora' }, reply, { context: context('203.0.113.99', cookie), guard: f.guard })).status, 200);
});

test('limite por IP permanece após apagar cookies e abrir outro navegador', async t => {
  const f = await fixture(t, { CHAT_IP_DAILY: '2' });
  for (let i = 0; i < 2; i++) { const session = await f.guard.enter(context()); await session.release(); }
  await assert.rejects(f.guard.enter(context()), (error: unknown) => error instanceof UsageError && /hoje/.test(error.message));
  const other = await f.guard.enter(context('203.0.113.5'));
  await other.release();
  assert.doesNotMatch(await readFile(f.filename, 'utf8'), /203\.0\.113|impacta_browser/);
});

test('limite diário do navegador é independente do IP e renova no próximo dia', async t => {
  const f = await fixture(t, { CHAT_BROWSER_DAILY: '2' });
  const first = await f.guard.enter(context());
  const cookie = cookieOf(first);
  await first.release(); f.advance(11000);
  const second = await f.guard.enter(context('203.0.113.5', cookie));
  await second.release(); f.advance(11000);
  await assert.rejects(f.guard.enter(context('203.0.113.6', cookie)), /hoje/);
  f.advance(86400000);
  const renewed = await f.guard.enter(context('203.0.113.6', cookie)); await renewed.release();
});

test('requisições paralelas e duas instâncias do limitador no mesmo processo respeitam o teto persistido', async t => {
  const f = await fixture(t, { CHAT_GLOBAL_DAILY: '2' });
  const other = f.make();
  const results = await Promise.allSettled(Array.from({ length: 10 }, (_, index) =>
    (index % 2 ? f.guard : other).enter(context('203.0.113.' + (index + 10)))));
  const accepted = results.filter(result => result.status === 'fulfilled');
  assert.equal(accepted.length, 2);
  for (const result of accepted) if (result.status === 'fulfilled') await result.value.release();
  await assert.rejects(f.make().enter(context('203.0.113.99')), /hoje/);
});

test('teto mensal sobrevive à troca de dia e renova no mês seguinte', async t => {
  const f = await fixture(t, { CHAT_GLOBAL_MONTHLY: '2' });
  for (let i = 0; i < 2; i++) {
    const session = await f.guard.enter(context()); await session.release(); f.advance(86400000);
  }
  await assert.rejects(f.guard.enter(context()), /mensal/);
  f.setTime(Date.UTC(2026, 10, 1, 12));
  const renewed = await f.guard.enter(context()); await renewed.release();
});

test('reserva de tokens é atômica, devolve consumo não utilizado e protege o orçamento mensal', async t => {
  const f = await fixture(t, { CHAT_TOKEN_DAILY: '1000', CHAT_TOKEN_MONTHLY: '1000' });
  const session = await f.guard.enter(context());
  const settle = await session.reserveTokens(700);
  await settle(200);
  await session.reserveTokens(700);
  await assert.rejects(session.reserveTokens(101), /hoje/);
  await session.release(); f.advance(86400000);
  const next = await f.guard.enter(context());
  await assert.rejects(next.reserveTokens(200), /mensal/);
  await next.release();
});

test('lease impede concorrência e liberação antiga não apaga uma nova sessão', async t => {
  const f = await fixture(t);
  const first = await f.guard.enter(context()); const cookie = cookieOf(first);
  f.advance(11000);
  await assert.rejects(f.guard.enter(context('203.0.113.4', cookie)), /Aguarde/);
  f.advance(65001);
  const second = await f.guard.enter(context('203.0.113.4', cookie));
  await first.release(); f.advance(11000);
  await assert.rejects(f.guard.enter(context('203.0.113.4', cookie)), /Aguarde/);
  await second.release();
});

test('falha do armazenamento e produção sem Redis bloqueiam sem gastar LLM', async () => {
  let calls = 0;
  const broken: LimitStore = { async run() { throw new Error('private Redis token'); } };
  const guard = createUsageGuard(secret, { store: broken });
  const result = await handleChat('POST', { message: 'Oi' }, async () => { calls++; return 'Oi'; }, { context: context(), guard });
  assert.equal(result.status, 503); assert.equal(calls, 0);
  assert.doesNotMatch(JSON.stringify(result), /private Redis token/);
  const production = createUsageGuard({ ...secret, VERCEL: '1', RATE_LIMIT_STORE: 'file' });
  await assert.rejects(production.enter({ headers: { 'x-vercel-forwarded-for': '203.0.113.4' } }), /temporariamente/);
});

test('Redis REST envia EVAL autenticado e trata erros sem liberar acesso', async () => {
  const store = createRedisStore('https://example.upstash.io', 'private-test-token', async (_url, init) => {
    assert.equal((init!.headers as Record<string, string>).Authorization, 'Bearer private-test-token');
    const command = JSON.parse(init!.body as string);
    assert.equal(command[0], 'EVAL'); assert.equal(command[2], 1);
    assert.equal(command[3], 'impacta:test');
    return Response.json({ result: [0, 1, 10] });
  });
  const op = { action: 'reserve' as const, now: 1000, counters: [{ key: 'impacta:test', amount: 1, limit: 2, ttl: 10000 }], leases: [] };
  assert.deepEqual(await store.run(op), { allowed: false, index: 0, retryAfter: 10 });
  const invalid = createRedisStore('https://example.upstash.io', 'private-test-token', async () => Response.json({ error: 'ERR' }));
  await assert.rejects(invalid.run(op));
});

test('bloqueio de orçamento interrompe fallback antes de gastar e respostas têm teto de geração', async () => {
  let calls = 0;
  const env = { GROQ_API_KEY: 'test-key', OPENROUTER_API_KEY: 'test-key' };
  const blocked = createLlmClient({ env, reserveTokens: async () => { throw new UsageError(429, 'Orçamento esgotado'); },
    fetchImpl: async () => { calls++; return Response.json({}); } });
  await assert.rejects(blocked([{ role: 'user', content: 'Oi' }]), /Orçamento/);
  assert.equal(calls, 0);
  const settlements: (number | undefined)[] = [];
  const reply = createLlmClient({ env, reserveTokens: async estimate => {
    assert.ok(estimate > 384); return async actual => { settlements.push(actual); };
  }, fetchImpl: async (_url, init) => {
    calls++;
    const body = JSON.parse(init!.body as string);
    assert.equal(body.max_tokens, 384); assert.match(body.messages[0].content, /80 palavras/);
    return Response.json({ choices: [{ message: { content: 'Resposta curta.' } }], usage: { total_tokens: 100 } });
  } });
  assert.equal(await reply([{ role: 'user', content: 'Oi' }]), 'Resposta curta.');
  assert.deepEqual(settlements, [100]);
  calls = 0;
  const failed = createLlmClient({ env, fetchImpl: async () => { calls++; return new Response('', { status: 503 }); } });
  await assert.rejects(failed([{ role: 'user', content: 'Oi' }])); assert.equal(calls, 4);
});

test('histórico grande é reduzido a pares recentes antes de enviar ao modelo', async () => {
  const history = Array.from({ length: 20 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'x'.repeat(900) }));
  const result = await handleChat('POST', { message: 'Continua', history: history.slice(0, 16) }, async messages => {
    assert.equal(messages.length, 5);
    assert.equal(messages.at(-1)!.content, 'Continua');
    assert.deepEqual(messages.slice(0, 4).map(message => message.role), ['user', 'assistant', 'user', 'assistant']);
    return 'Sim';
  });
  assert.equal(result.status, 200);
});
