import type { VercelRequest, VercelResponse } from '@vercel/node';
import { handleChat } from '../lib/chat.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const result = await handleChat(req.method, req.body, undefined, { context: {
    headers: req.headers, ip: req.socket?.remoteAddress,
  } });
  for (const [name, value] of Object.entries(result.headers || {})) res.setHeader(name, value);
  res.setHeader('Cache-Control', 'no-store');
  if (result.status === 405) res.setHeader('Allow', 'POST');
  return res.status(result.status).json(result.body);
}
