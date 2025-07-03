import * as dotenv from 'dotenv';
dotenv.config();

import { Mistral } from '@mistralai/mistralai';

const apiKey = process.env.MISTRAL_API_KEY;

const client = new Mistral({ apiKey });

const chatResponse = await client.chat.complete({
  model: 'mistral-large-latest',
  messages: [{role: 'user', content: 'Diga oi'}],
});

console.log('Chat:', chatResponse.choices[0].message.content);