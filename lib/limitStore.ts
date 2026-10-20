import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

export type Counter = { key: string; limit: number; amount: number; ttl: number };
export type Lease = { key: string; limit: number; ttl: number; id: string };
export type Operation = { action: 'reserve' | 'refund' | 'release'; counters: Counter[]; leases: Lease[]; now: number };
export type StoreResult = { allowed: boolean; index: number; retryAfter: number };
export type LimitStore = { run(operation: Operation): Promise<StoreResult> };

// All checks and changes happen in a single atomic operation, across server instances.
export const LIMIT_SCRIPT = `
local op = cjson.decode(ARGV[1])
local count = #op.counters
if op.action == 'release' then
  for i, lease in ipairs(op.leases) do redis.call('ZREM', KEYS[count+i], lease.id) end
  return {1, 0, 0}
end
if op.action == 'refund' then
  for i, rule in ipairs(op.counters) do
    local current = tonumber(redis.call('GET', KEYS[i]) or '0')
    if current > 0 then redis.call('DECRBY', KEYS[i], math.min(current, rule.amount)) end
  end
  return {1, 0, 0}
end
for i, rule in ipairs(op.counters) do
  local current = tonumber(redis.call('GET', KEYS[i]) or '0')
  if current + rule.amount > rule.limit then
    return {0, i, math.max(1, math.ceil(redis.call('PTTL', KEYS[i])/1000))}
  end
end
for i, lease in ipairs(op.leases) do
  local key = KEYS[count+i]
  redis.call('ZREMRANGEBYSCORE', key, '-inf', op.now)
  if redis.call('ZCARD', key) >= lease.limit then
    local first = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
    return {0, count+i, math.max(1, math.ceil((tonumber(first[2])-op.now)/1000))}
  end
end
for i, rule in ipairs(op.counters) do
  redis.call('INCRBY', KEYS[i], rule.amount)
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], rule.ttl) end
end
for i, lease in ipairs(op.leases) do
  redis.call('ZADD', KEYS[count+i], op.now+lease.ttl, lease.id)
  redis.call('PEXPIRE', KEYS[count+i], lease.ttl)
end
return {1, 0, 0}
`;

export function createRedisStore(url: string, token: string, fetchImpl: typeof fetch = fetch): LimitStore {
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password) throw new Error('Invalid Redis URL');
  return { async run(operation) {
    const keys = [...operation.counters, ...operation.leases].map(item => item.key);
    const response = await fetchImpl(endpoint, {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(['EVAL', LIMIT_SCRIPT, keys.length, ...keys, JSON.stringify(operation)]),
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) throw new Error('Usage store unavailable');
    const body = await response.json() as { result?: number[]; error?: string };
    if (body.error || !Array.isArray(body.result) || body.result.length !== 3 ||
      body.result.some(value => !Number.isFinite(value)) || ![0, 1].includes(body.result[0])) {
      throw new Error('Invalid usage store response');
    }
    return { allowed: body.result[0] === 1, index: body.result[1] - 1, retryAfter: body.result[2] };
  } };
}

type State = { counters: Record<string, { value: number; expires: number }>; leases: Record<string, Record<string, number>> };
const queues = new Map<string, Promise<unknown>>();

// Persistent local mode, serialized across store objects in ONE Node process.
// Serverless/multiple processes must use the Redis implementation above.
export function createFileStore(filename: string): LimitStore {
  const file = resolve(filename);
  return { run(operation) {
    const execute = async (): Promise<StoreResult> => {
      let state: State = { counters: {}, leases: {} };
      try { state = JSON.parse(await readFile(file, 'utf8')) as State; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (!state.counters || !state.leases) throw new Error('Invalid usage file');
      for (const [key, value] of Object.entries(state.counters)) {
        if (value.expires <= operation.now) delete state.counters[key];
      }
      for (const [key, leases] of Object.entries(state.leases)) {
        for (const [id, expires] of Object.entries(leases)) if (expires <= operation.now) delete leases[id];
        if (!Object.keys(leases).length) delete state.leases[key];
      }
      if (operation.action === 'reserve') {
        for (const [index, rule] of operation.counters.entries()) {
          const current = state.counters[rule.key];
          if ((current?.value || 0) + rule.amount > rule.limit) {
            return { allowed: false, index, retryAfter: Math.max(1, Math.ceil(((current?.expires || operation.now + rule.ttl) - operation.now) / 1000)) };
          }
        }
        for (const [index, lease] of operation.leases.entries()) {
          const existing = Object.values(state.leases[lease.key] || {});
          if (existing.length >= lease.limit) return { allowed: false, index: operation.counters.length + index,
            retryAfter: Math.max(1, Math.ceil((Math.min(...existing) - operation.now) / 1000)) };
        }
        for (const rule of operation.counters) {
          const current = state.counters[rule.key] ||= { value: 0, expires: operation.now + rule.ttl };
          current.value += rule.amount;
        }
        for (const lease of operation.leases) (state.leases[lease.key] ||= {})[lease.id] = operation.now + lease.ttl;
      } else if (operation.action === 'refund') {
        for (const rule of operation.counters) {
          const current = state.counters[rule.key];
          if (current) current.value = Math.max(0, current.value - rule.amount);
        }
      } else {
        for (const lease of operation.leases) if (state.leases[lease.key]) delete state.leases[lease.key][lease.id];
      }
      await mkdir(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
      await rename(temporary, file);
      return { allowed: true, index: -1, retryAfter: 0 };
    };
    const pending = (queues.get(file) || Promise.resolve()).catch(() => {}).then(execute);
    queues.set(file, pending);
    return pending;
  } };
}
