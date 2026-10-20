import { boundedInt, UsageError, type TokenReservation } from './usageGuard.js';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };
const RESPONSE_STYLE = 'Responda em português de forma clara, correta e direta. Prefira 2 a 4 frases e até 80 palavras. Use um exemplo curto quando ajudar. Em perguntas amplas, explique o essencial e ofereça aprofundar depois. Evite introduções e repetições. Não sacrifique a precisão para encurtar.';
type Environment = Record<string, string | undefined>;
type Candidate = { provider: string; url: string; token: string; model: string };
type Failure = 'auth' | 'quota' | 'timeout' | 'unavailable';

export class LlmError extends Error {
  constructor(public readonly status: number, public readonly code: string, message: string) {
    super(message);
    this.name = 'LlmError';
  }
}

function milliseconds(value: string | undefined, fallback: number, maximum: number) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 100 ? Math.min(parsed, maximum) : fallback;
}

function candidates(env: Environment): Candidate[] {
  const result: Candidate[] = [];
  if (env.GROQ_API_KEY?.trim()) {
    const models = [env.GROQ_MODEL?.trim() || 'openai/gpt-oss-20b',
      ...(env.GROQ_FALLBACK_MODELS ?? 'openai/gpt-oss-120b,qwen/qwen3.8-27b').split(',')]
      .map(model => model.trim()).filter(Boolean);
    for (const model of new Set(models)) {
      result.push({ provider: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions',
        token: env.GROQ_API_KEY.trim(), model });
    }
  }
  if (env.OPENROUTER_API_KEY?.trim()) {
    const models = (env.OPENROUTER_MODELS ||
      'google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,openrouter/free')
      .split(',').map(model => model.trim()).filter(Boolean);
    // Reject paid models instead of silently falling back to paid inference.
    if (!models.length || models.some(model => model !== 'openrouter/free' && !model.endsWith(':free'))) {
      throw new LlmError(503, 'configuration', 'O serviço de chat precisa de um ajuste na configuração. Tente novamente mais tarde.');
    }
    for (const model of new Set(models)) {
      result.push({ provider: 'openrouter', url: 'https://openrouter.ai/api/v1/chat/completions',
        token: env.OPENROUTER_API_KEY.trim(), model });
    }
  }
  // HF currently requires credits. Enable only by explicit server configuration.
  if (env.LLM_ENABLE_HF === 'true' && env.HF_TOKEN?.trim()) {
    result.push({ provider: 'huggingface', url: 'https://router.huggingface.co/v1/chat/completions',
      token: env.HF_TOKEN.trim(), model: env.HF_MODEL?.trim() || 'Qwen/Qwen3-4B-Instruct-2507' });
  }
  return result;
}

export function createLlmClient({ env = process.env, fetchImpl = fetch, reserveTokens }: {
  env?: Environment; fetchImpl?: typeof fetch; reserveTokens?: TokenReservation;
} = {}) {
  return async (messages: ChatMessage[]): Promise<string> => {
    const options = candidates(env);
    if (!options.length) {
      throw new LlmError(503, 'configuration', 'O serviço de chat ainda não foi configurado. Tente novamente mais tarde.');
    }
    const deadline = Date.now() + milliseconds(env.LLM_TOTAL_TIMEOUT_MS, 35000, 50000);
    const timeout = milliseconds(env.LLM_TIMEOUT_MS, 8000, 15000);
    const failures: Failure[] = [];
    const blockedProviders = new Set<string>();
    const maxTokens = Math.max(128, boundedInt(env.LLM_MAX_OUTPUT_TOKENS, 384, 768));
    const maxAttempts = boundedInt(env.LLM_MAX_ATTEMPTS, 4, 6);
    const providerMessages = [{ role: 'system', content: RESPONSE_STYLE }, ...messages];
    // A byte-based upper estimate avoids assuming an English tokenizer. Successful
    // calls refund the difference using the provider's total_tokens, including reasoning.
    const reservation = Buffer.byteLength(JSON.stringify(providerMessages), 'utf8') + 512 + maxTokens;
    let attempts = 0;

    for (const option of options) {
      if (blockedProviders.has(option.provider)) continue;
      if (attempts >= maxAttempts) break;
      const remaining = deadline - Date.now();
      if (remaining <= 0) { failures.push('timeout'); break; }
      // Outside the fetch catch: a local budget denial must stop ALL provider calls.
      const settle = reserveTokens ? await reserveTokens(reservation) : undefined;
      attempts++;
      try {
        const response = await fetchImpl(option.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${option.token}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(Math.min(timeout, remaining)),
          body: JSON.stringify({
            model: option.model, messages: providerMessages, stream: false, max_tokens: maxTokens,
            ...(option.provider === 'groq' && option.model.startsWith('openai/gpt-oss-')
              ? { reasoning_effort: 'low' } : {}),
            ...(option.provider === 'groq' && option.model === 'qwen/qwen3.8-27b'
              ? { reasoning_effort: 'none' } : {}),
            ...(option.provider === 'openrouter' ? { provider: { max_price: { prompt: 0, completion: 0 } } } : {}),
          }),
        });
        if (!response.ok) {
          const failure: Failure = response.status === 401 || response.status === 403 ? 'auth'
            : response.status === 402 || response.status === 429 ? 'quota'
            : response.status === 408 || response.status === 504 ? 'timeout' : 'unavailable';
          failures.push(failure);
          // Changing model cannot fix an invalid key or exhausted account credits.
          if (failure === 'auth' || response.status === 402) blockedProviders.add(option.provider);
          await response.body?.cancel();
          continue;
        }
        const data = await response.json() as {
          choices?: { message?: { content?: unknown }; finish_reason?: string }[];
          usage?: { total_tokens?: number };
        };
        // A failed refund keeps the conservative debit; do not generate a second reply.
        await settle?.(data.usage?.total_tokens).catch(() => {});
        const choice = data.choices?.[0];
        const content = choice?.message?.content;
        if (typeof content === 'string' && content.trim() && choice?.finish_reason !== 'content_filter') {
          return content.trim();
        }
        failures.push('unavailable');
      } catch (error) {
        if (error instanceof UsageError) throw error;
        failures.push(error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)
          ? 'timeout' : 'unavailable');
      }
    }

    // Never expose provider payloads, credentials or fetch error objects to clients/logs.
    if (failures.includes('quota')) {
      throw new LlmError(429, 'quota', 'O limite gratuito dos serviços disponíveis foi atingido. Tente novamente mais tarde.');
    }
    if (failures.includes('timeout')) {
      throw new LlmError(504, 'timeout', 'Os serviços de IA demoraram para responder. Tente novamente em instantes.');
    }
    if (failures.length && failures.every(failure => failure === 'auth')) {
      throw new LlmError(503, 'configuration', 'O serviço de chat precisa de um ajuste na configuração. Tente novamente mais tarde.');
    }
    throw new LlmError(503, 'unavailable', 'Os modelos de IA estão indisponíveis no momento. Tente novamente em instantes.');
  };
}

export const getReply = (messages: ChatMessage[], reserveTokens?: TokenReservation) => createLlmClient({ reserveTokens })(messages);
