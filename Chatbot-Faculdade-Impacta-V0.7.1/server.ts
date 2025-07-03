import axios from "axios";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";

dotenv.config();

const port = 3000;
const app = express();

app.use(express.json());
app.use(cors());

const MISTRAL_API_KEY = process.env.MISTRAL_API_KEY!;
const MISTRAL_URL = "https://api.mistral.ai/v1/chat/completions";

app.post("/chat", async (req, res) => {
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
        messages: [
          {
            role: "user",
            content: userMessage,
          },
        ],
      },
      {
        headers: {
          Authorization: `Bearer ${MISTRAL_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const content = resposta.data.choices[0].message.content;
    res.json({ reply: content });
  } catch (err) {
    console.error("Erro na chamada à API Mistral:", err.message);
    res.status(500).json({ error: "Erro ao obter resposta da Mistral." });
  }
});

app.listen(3000, () => {
  console.log("Servidor rodando em http://localhost:3000");
});
