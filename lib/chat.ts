import { getReply, LlmError, type ChatMessage } from './llmClient.js';
import { usageGuard, UsageError, type ClientContext, type TokenReservation, type UsageGuard } from './usageGuard.js';

const MAX_MESSAGE = 4000;
const MAX_HISTORY = 20;
const MAX_HISTORY_CHARS = 16000;

export async function handleChat(method: string | undefined, body: unknown,
  reply: (messages: ChatMessage[], reserveTokens?: TokenReservation) => Promise<string> = getReply,
  access?: { context: ClientContext; guard?: UsageGuard },
): Promise<{ status: number; body: { reply: string } | { error: string; retryAfter?: number }; headers?: Record<string, string> }> {
  if (method !== 'POST') return { status: 405, body: { error: 'Método não permitido.' } };
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: 'Mensagem é obrigatória.' } };
  }
  const { message, history = [] } = body as Record<string, unknown>;
  if (typeof message !== 'string' || !message.trim()) {
    return { status: 400, body: { error: 'Mensagem é obrigatória.' } };
  }
  if (message.length > 1200) {
    return { status: 400, body: { error: 'Sua mensagem deve ter até 1.200 caracteres. Divida perguntas muito longas.' } };
  }
  if (!Array.isArray(history) || history.length > MAX_HISTORY || history.length % 2 !== 0 ||
    history.some((item, index) => !item || item.role !== (index % 2 === 0 ? 'user' : 'assistant') ||
      typeof item.content !== 'string' || !item.content.trim() || item.content.length > MAX_MESSAGE) ||
    history.reduce((total, item) => total + item.content.length, 0) > MAX_HISTORY_CHARS) {
    return { status: 400, body: { error: 'O histórico da conversa é inválido ou muito longo. Inicie uma nova conversa.' } };
  }
  let session: Awaited<ReturnType<UsageGuard['enter']>> | undefined;
  try {
    if (access) session = await (access.guard || usageGuard).enter(access.context);
    // Keep complete recent pairs. The original persona is unchanged; the LLM
    // client adds only the response-length instruction requested for this version.
    const messages: ChatMessage[] = history.slice(-8).map(({ role, content }) => ({ role, content }));
    while (messages.reduce((total, item) => total + item.content.length, 0) > 4000) messages.splice(0, 2);
    messages.push({ role: 'user', content: message.trim() });
    const body = { reply: await reply(messages, session?.reserveTokens) };
    return { status: 200, body, ...(session ? { headers: session.headers } : {}) };
  } catch (error) {
    if (error instanceof UsageError) return { status: error.status, body: { error: error.message, retryAfter: error.retryAfter },
      headers: { ...session?.headers, 'Retry-After': String(error.retryAfter) } };
    return error instanceof LlmError
      ? { status: error.status, body: { error: error.message }, ...(session ? { headers: session.headers } : {}) }
      : { status: 503, body: { error: 'Não foi possível conversar agora. Tente novamente em instantes.' }, ...(session ? { headers: session.headers } : {}) };
  } finally {
    // Failed releases expire automatically. Do not mask an already completed reply.
    await session?.release().catch(() => {});
  }
}
