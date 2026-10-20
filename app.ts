import 'dotenv/config';
import { getReply, LlmError } from './lib/llmClient.js';

try {
  console.log('Chat:', await getReply([{ role: 'user', content: 'Diga oi em português.' }]));
} catch (error) {
  console.error(error instanceof LlmError ? error.message : 'Não foi possível conversar agora.');
  process.exitCode = 1;
}
