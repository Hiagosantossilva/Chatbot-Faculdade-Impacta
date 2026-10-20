import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { createFileStore, createRedisStore, type Counter, type Lease, type LimitStore } from './limitStore.js';

type Environment = Record<string, string | undefined>;
export type ClientContext = { headers: Record<string, string | string[] | undefined>; ip?: string; secure?: boolean };
export type TokenReservation = (tokens: number) => Promise<(actualTokens?: number) => Promise<void>>;
export class UsageError extends Error {
  constructor(public readonly status: number, message: string, public readonly retryAfter = 60) { super(message); }
}
export function boundedInt(value: string | undefined, fallback: number, maximum: number) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? Math.min(number, maximum) : fallback;
}
const header = (context: ClientContext, name: string) => {
  const value = context.headers[name];
  return Array.isArray(value) ? value[0] || '' : value || '';
};

export function clientIdentity(context: ClientContext, env: Environment) {
  const secret = env.RATE_LIMIT_SECRET || env.GROQ_API_KEY || env.OPENROUTER_API_KEY;
  if (!secret) throw new UsageError(503, 'O chat precisa de um ajuste na configuração. Tente novamente mais tarde.');
  const digest = (text: string) => createHmac('sha256', secret).update(text).digest('hex');
  // Only trust this header when actually running behind Vercel; ignore forwarded headers locally.
  let ip = (env.VERCEL === '1' ? header(context, 'x-vercel-forwarded-for').split(',')[0]?.trim() : context.ip) || '';
  ip = ip.replace(/^::ffff:/, '');
  if (!isIP(ip)) throw new UsageError(503, 'Não foi possível validar seu acesso. Tente novamente em instantes.');
  // Group IPv6 addresses by /64 so rotating the interface address cannot reset quotas.
  if (isIP(ip) === 6) {
    const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
    const [left, right = ''] = normalized.split('::');
    const start = left ? left.split(':') : [];
    const end = right ? right.split(':') : [];
    const groups = normalized.includes('::') ? [...start, ...Array(8 - start.length - end.length).fill('0'), ...end] : start;
    ip = groups.slice(0, 4).map(group => group.padStart(4, '0')).join(':') + '::/64';
  }
  const cookie = header(context, 'cookie').split(';').map(item => item.trim()).find(item => item.startsWith('impacta_browser='))?.slice(16);
  const [givenId = '', signature = ''] = cookie?.split('.') || [];
  const expected = digest('cookie:' + givenId);
  const valid = /^[0-9a-f-]{36}$/.test(givenId) && /^[0-9a-f]{64}$/.test(signature) &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  const id = valid ? givenId : randomUUID();
  const secure = context.secure || env.VERCEL === '1' || env.NODE_ENV === 'production';
  return { browser: digest('browser:' + id), ip: digest('ip:' + ip),
    cookie: valid ? undefined : `impacta_browser=${id}.${digest('cookie:' + id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=7776000${secure ? '; Secure' : ''}` };
}

export function createUsageGuard(env: Environment = process.env, options: { store?: LimitStore; now?: () => number } = {}) {
  const now = options.now || Date.now;
  let store = options.store;
  function storage() {
    if (store) return store;
    if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
      store = createRedisStore(env.UPSTASH_REDIS_REST_URL, env.UPSTASH_REDIS_REST_TOKEN);
    } else if (env.VERCEL !== '1' && (env.NODE_ENV !== 'production' || env.RATE_LIMIT_STORE === 'file')) {
      store = createFileStore(env.RATE_LIMIT_FILE || '.data/usage.json');
    } else throw new Error('Shared usage store is required');
    return store;
  }
  const limit = (name: string, fallback: number, max = 1000000) => boundedInt(env[name], fallback, max);
  function rule(name: string, value: number, period: 'minute' | 'hour' | 'day' | 'month' | 'cooldown', amount = 1): Counter {
    const time = now();
    const date = new Date(time);
    const duration = period === 'minute' ? 60000 : period === 'hour' ? 3600000 : period === 'day' ? 86400000 : 0;
    const start = period === 'month' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
      : period === 'cooldown' ? 0 : Math.floor(time / duration) * duration;
    const end = period === 'month' ? Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1)
      : period === 'cooldown' ? time + 10000 : start + duration;
    return { key: `impacta:v1:${name}:${period}:${start}`, limit: value, amount, ttl: Math.max(1, end - time) };
  }
  async function reserve(counters: Counter[], leases: Lease[] = []) {
    const result = await storage().run({ action: 'reserve', counters, leases, now: now() });
    if (!result.allowed) {
      const denied = [...counters, ...leases][result.index];
      const key = denied?.key || '';
      const global = key.includes(':global:');
      const message = global
        ? key.includes(':month:') ? 'O limite mensal de demonstração foi atingido. Volte no próximo mês.'
        : key.includes(':day:') ? 'A cota de demonstração de hoje foi utilizada. Volte amanhã.'
        : 'O chat está recebendo muitos pedidos. Aguarde um instante e tente novamente.'
        : key.includes(':day:') ? 'Você atingiu o limite de mensagens de hoje. Volte amanhã.'
        : key.includes(':hour:') ? 'Você atingiu o limite de mensagens desta hora. Faça uma pausa e tente mais tarde.'
        : 'Aguarde alguns segundos antes de enviar outra mensagem.';
      throw new UsageError(429, message, result.retryAfter);
    }
  }
  return { async enter(context: ClientContext) {
    const identity = clientIdentity(context, env);
    if (header(context, 'sec-fetch-site') === 'cross-site') throw new UsageError(403, 'Abra o chat no site para enviar sua mensagem.');
    const id = randomUUID();
    const leases: Lease[] = [
      { key: `impacta:v1:browser:${identity.browser}:active`, limit: 1, ttl: 65000, id },
      { key: `impacta:v1:ip:${identity.ip}:active`, limit: 2, ttl: 65000, id },
      { key: 'impacta:v1:global:active', limit: 3, ttl: 65000, id },
    ];
    try {
      await reserve([
        rule('global:requests', limit('CHAT_GLOBAL_DAILY', 40), 'day'),
        rule('global:requests', limit('CHAT_GLOBAL_MONTHLY', 1500), 'month'),
        rule('global:requests', 6, 'minute'),
        rule(`browser:${identity.browser}`, limit('CHAT_BROWSER_DAILY', 20), 'day'),
        rule(`browser:${identity.browser}`, 12, 'hour'),
        rule(`browser:${identity.browser}`, 3, 'minute'),
        rule(`browser:${identity.browser}`, 1, 'cooldown'),
        rule(`ip:${identity.ip}`, limit('CHAT_IP_DAILY', 30), 'day'),
        rule(`ip:${identity.ip}`, 6, 'minute'),
      ], leases);
    } catch (error) {
      if (error instanceof UsageError) throw error;
      throw new UsageError(503, 'O controle de acesso está temporariamente indisponível. Tente novamente em instantes.');
    }
    const reserveTokens: TokenReservation = async tokens => {
      const counters = [rule('global:tokens', limit('CHAT_TOKEN_DAILY', 50000, 10000000), 'day', tokens),
        rule('global:tokens', limit('CHAT_TOKEN_MONTHLY', 1600000, 100000000), 'month', tokens)];
      try { await reserve(counters); }
      catch (error) {
        if (error instanceof UsageError) throw error;
        throw new UsageError(503, 'O controle de acesso está temporariamente indisponível. Tente novamente em instantes.');
      }
      return async actual => {
        // Unknown usage retains the full reservation, including failed attempts.
        if (!Number.isSafeInteger(actual) || actual! < 0 || actual! >= tokens) return;
        await storage().run({ action: 'refund', counters: counters.map(item => ({ ...item, amount: tokens - actual! })), leases: [], now: now() });
      };
    };
    const headers: Record<string, string> = identity.cookie ? { 'Set-Cookie': identity.cookie } : {};
    return { headers, reserveTokens,
      release: () => storage().run({ action: 'release', counters: [], leases, now: now() }) };
  } };
}

export type UsageGuard = ReturnType<typeof createUsageGuard>;
export const usageGuard = createUsageGuard();
