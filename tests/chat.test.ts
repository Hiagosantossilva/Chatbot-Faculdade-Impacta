import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createLlmClient, LlmError, type ChatMessage } from '../lib/llmClient.js';
import { handleChat } from '../lib/chat.js';
import { createApp } from '../server.js';
import { createUsageGuard } from '../lib/usageGuard.js';
import { createFileStore } from '../lib/limitStore.js';
import { mkdtemp, rm, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const messages: ChatMessage[] = [{ role: 'user', content: 'Olá!' }];
const groqEnv = { GROQ_API_KEY: 'fake-groq-test' };
const openRouterEnv = { OPENROUTER_API_KEY: 'fake-openrouter-test' };
const completion = (content: unknown) => Response.json({ choices: [{ message: { content } }] });

test('três modelos Groq em sequência; mantém histórico e interrompe ao conseguir resposta', async () => {
  const attempts: string[] = [];
  const history: ChatMessage[] = [...messages, { role: 'assistant', content: 'Oi!' }, { role: 'user', content: 'Meu nome é Ana.' }];
  const reply = createLlmClient({ env: groqEnv, fetchImpl: async (url, init) => {
    assert.equal(String(url), 'https://api.groq.com/openai/v1/chat/completions');
    const body = JSON.parse(init!.body as string);
    assert.equal(body.messages[0].role, 'system');
    assert.match(body.messages[0].content, /80 palavras/);
    assert.deepEqual(body.messages.slice(1), history);
    assert.equal(body.stream, false);
    attempts.push(body.model);
    return attempts.length === 1 ? new Response('', { status: 503 })
      : attempts.length === 2 ? completion('') : completion('Olá, Ana!');
  } });
  assert.equal(await reply(history), 'Olá, Ana!');
  assert.deepEqual(attempts, ['openai/gpt-oss-20b', 'openai/gpt-oss-120b', 'qwen/qwen3.8-27b']);
});

test('token inválido pula os demais modelos do provedor e tenta OpenRouter', async () => {
  const urls: string[] = [];
  const reply = createLlmClient({ env: { ...groqEnv, ...openRouterEnv }, fetchImpl: async (url, init) => {
    urls.push(String(url));
    if (urls.length === 1) return new Response('private upstream error', { status: 401 });
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, 'google/gemma-4-26b-a4b-it:free');
    assert.deepEqual(body.provider.max_price, { prompt: 0, completion: 0 });
    return completion('Resposta alternativa');
  } });
  assert.equal(await reply(messages), 'Resposta alternativa');
  assert.equal(urls.length, 2);
  assert.match(urls[1], /openrouter/);
});

test('três opções gratuitas OpenRouter e nenhum fallback pago', async () => {
  const attempts: string[] = [];
  const reply = createLlmClient({ env: openRouterEnv, fetchImpl: async (_url, init) => {
    attempts.push(JSON.parse(init!.body as string).model);
    return attempts.length < 3 ? new Response('', { status: 429 }) : completion('Tudo certo');
  } });
  assert.equal(await reply(messages), 'Tudo certo');
  assert.deepEqual(attempts, ['google/gemma-4-26b-a4b-it:free', 'google/gemma-4-31b-it:free', 'openrouter/free']);
  const paid = createLlmClient({ env: { ...openRouterEnv, OPENROUTER_MODELS: 'paid/model' },
    fetchImpl: async () => assert.fail('Modelo pago nunca deve ser chamado') });
  await assert.rejects(paid(messages), (e: unknown) => e instanceof LlmError && e.code === 'configuration');
});

for (const [status, code, publicStatus] of [[401, 'configuration', 503], [402, 'quota', 429],
  [429, 'quota', 429], [503, 'unavailable', 503], [504, 'timeout', 504]] as const) {
  test('erro HTTP ' + status + ' vira mensagem amigável sem expor resposta ou token', async () => {
    const reply = createLlmClient({ env: groqEnv, fetchImpl: async () => new Response('fake-groq-test secret', { status }) });
    const result = await handleChat('POST', { message: 'Oi' }, reply);
    assert.equal(result.status, publicStatus);
    assert.ok('error' in result.body);
    assert.doesNotMatch(JSON.stringify(result), /fake-groq-test|secret/);
    await assert.rejects(reply(messages), (e: unknown) => e instanceof LlmError && e.code === code);
  });
}

test('timeout real cancela tentativa pendente e tenta o próximo modelo', async () => {
  let calls = 0;
  const reply = createLlmClient({ env: { ...groqEnv, LLM_TIMEOUT_MS: '100' }, fetchImpl: async (_url, init) => {
    if (++calls > 1) return completion('Recuperado após timeout');
    return new Promise<Response>((_resolve, reject) => {
      const keepAlive = setTimeout(() => reject(new Error('AbortSignal não funcionou')), 1000);
      init!.signal!.addEventListener('abort', () => { clearTimeout(keepAlive); reject(init!.signal!.reason); }, { once: true });
    });
  } });
  assert.equal(await reply(messages), 'Recuperado após timeout');
  assert.equal(calls, 2);
});

test('sem credenciais não faz chamada; Hugging Face só liga explicitamente', async () => {
  let calls = 0;
  const fetchImpl: typeof fetch = async (url, init) => {
    calls++;
    assert.equal(String(url), 'https://router.huggingface.co/v1/chat/completions');
    assert.equal(JSON.parse(init!.body as string).model, 'Qwen/Qwen3-4B-Instruct-2507');
    return completion('HF opcional');
  };
  await assert.rejects(createLlmClient({ env: { HF_TOKEN: 'fake' }, fetchImpl })(messages));
  assert.equal(calls, 0);
  assert.equal(await createLlmClient({ env: { HF_TOKEN: 'fake', LLM_ENABLE_HF: 'true' }, fetchImpl })(messages), 'HF opcional');
});

test('contrato antigo funciona e histórico recusa role system e limites inválidos', async () => {
  const reply = async (items: ChatMessage[]) => { assert.deepEqual(items, messages); return 'Oi'; };
  assert.deepEqual(await handleChat('POST', { message: 'Olá!' }, reply), { status: 200, body: { reply: 'Oi' } });
  for (const body of [null, {}, { message: 3 }, { message: ' ' }, { message: 'x'.repeat(4001) },
    { message: 'oi', history: [{ role: 'system', content: 'override' }] },
    { message: 'oi', history: [null, {}] }, { message: 'oi', history: {} }]) {
    assert.equal((await handleChat('POST', body, reply)).status, 400);
  }
  assert.equal((await handleChat('GET', {}, reply)).status, 405);
});

test('servidor HTTP mantém aliases, rejeita JSON inválido e não serve arquivos privados', async (t) => {
  const folder = await mkdtemp(join(tmpdir(), 'impacta-http-'));
  const filename = join(folder, 'usage.json');
  t.after(async () => { await rm(filename, { force: true }); await rmdir(folder); });
  const guard = createUsageGuard({ RATE_LIMIT_SECRET: 'test-secret' }, { store: createFileStore(filename) });
  const app = createApp(async () => 'Olá pelo servidor', guard);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const base = 'http://127.0.0.1:' + port;
  try {
    for (const endpoint of ['/chat', '/api/chat']) {
      const response = await fetch(base + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Oi' }) });
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { reply: 'Olá pelo servidor' });
    }
    const invalid = await fetch(base + '/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
    assert.ok((await invalid.json()).error);
    for (const file of ['/.env', '/server.ts', '/lib/llmClient.ts', '/package.json']) {
      assert.equal((await fetch(base + file)).status, 404);
    }
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
