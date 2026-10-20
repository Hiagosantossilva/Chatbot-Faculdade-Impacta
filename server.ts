import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleChat } from './lib/chat.js';
import type { ChatMessage } from './lib/llmClient.js';
import type { TokenReservation, UsageGuard } from './lib/usageGuard.js';

export function createApp(reply?: (messages: ChatMessage[], reserveTokens?: TokenReservation) => Promise<string>, guard?: UsageGuard) {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '64kb' }));
  app.all(['/api/chat', '/chat'], async (req, res) => {
    const result = await handleChat(req.method, req.body, reply, { guard, context: {
      headers: req.headers, ip: req.socket.remoteAddress, secure: req.secure,
    } });
    for (const [name, value] of Object.entries(result.headers || {})) res.setHeader(name, value);
    res.setHeader('Cache-Control', 'no-store');
    if (result.status === 405) res.setHeader('Allow', 'POST');
    res.status(result.status).json(result.body);
  });
  // Only the explicit public build is served, never the source folder or .env.
  app.use(express.static(path.resolve('public')));
  app.use((error: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = error.status === 413 ? 413 : 400;
    res.status(status).json({ error: status === 413
      ? 'A conversa ficou muito longa. Envie uma mensagem menor.'
      : 'Não foi possível ler a mensagem. Tente novamente.' });
  });
  return app;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log('Chatbot em http://localhost:' + port));
}
