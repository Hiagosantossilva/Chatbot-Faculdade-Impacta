// /api/chat.ts
import { VercelRequest, VercelResponse } from '@vercel/node';
import axios from 'axios';

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY!;
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const userMessage = req.body.message;

  if (!userMessage) {
    return res.status(400).json({ error: "Mensagem é obrigatória." });
  }

  try {
    const resposta = await axios.post(
      MISTRAL_URL,
      {
        model: "mistral-large-latest",
        max_tokens: 80,
        messages: [{ role: "user", content: userMessage }],
      },
      {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const content = resposta.data.choices[0].message.content;
    res.status(200).json({ reply: content });
  } catch (err: any) {
    console.error("Erro na chamada à API Mistral:", err.message);
    res.status(500).json({ error: "Erro ao obter resposta da Mistral." });
  }
}
