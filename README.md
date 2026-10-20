# ChatBot Impacta 1.0

Chatbot conversacional em português desenvolvido por Hiago Santos Silva. A versão 1.0 está consolidada na raiz do repositório.

- Interface responsiva com mensagens separadas, envio por teclado e nova conversa.
- Histórico curto, respostas objetivas e fallback automático entre modelos.
- Limites por navegador, IP e aplicativo, com orçamento de tokens.
- Backend Node.js/Express e função de servidor compatível com a Vercel.

## Executar localmente

Requer Node.js 22 ou superior. Na raiz do projeto:

```powershell
npm ci
# Apenas na primeira configuração; preserve um .env que já exista.
Copy-Item .env.example .env
npm run dev
```

Antes de iniciar, preencha `GROQ_API_KEY` no `.env`. Acesse [localhost:3000](http://localhost:3000); `PORT` permite alterar a porta. O HTML precisa ser servido junto com o backend.

Para executar a versão compilada:

```powershell
npm run build
npm start
```

## Configuração do modelo

As chaves são lidas somente pelo servidor. Não as coloque no frontend ou no Git.

| Variável | Uso |
| --- | --- |
| `GROQ_API_KEY` | Chave criada em [GroqCloud](https://console.groq.com/keys). Basta para habilitar três modelos. |
| `GROQ_MODEL` | Principal: `openai/gpt-oss-20b`. |
| `GROQ_FALLBACK_MODELS` | Reservas: `openai/gpt-oss-120b,qwen/qwen3.8-27b`. |
| `OPENROUTER_API_KEY` | Opcional, criada em [OpenRouter](https://openrouter.ai/keys), para reserva em outro provedor. |
| `OPENROUTER_MODELS` | `google/gemma-4-26b-a4b-it:free,google/gemma-4-31b-it:free,openrouter/free`. Apenas modelos gratuitos são aceitos. |
| `LLM_MAX_OUTPUT_TOKENS` | Teto de geração: 384 tokens, incluindo raciocínio quando aplicável. |
| `LLM_MAX_ATTEMPTS` | Até quatro tentativas por mensagem. |

A instrução de estilo pede português claro, 2 a 4 frases e até 80 palavras. O alvo de palavras orienta o modelo; o teto de tokens limita a geração. Cada tentativa tem timeout padrão de 8 segundos, com 35 segundos para a sequência inteira. Falhas técnicas e respostas vazias acionam a próxima opção. A qualidade factual de uma resposta não vazia não é avaliada automaticamente.

O GPT-OSS 20B foi escolhido pelo porte e velocidade. O Qwen usado como reserva está em preview; modelos e cotas podem mudar. Consulte os [modelos e limites do Groq](https://console.groq.com/docs/rate-limits) e o [catálogo do OpenRouter](https://openrouter.ai/api/v1/models). Use as contas no plano gratuito para manter o uso dentro das respectivas cotas.

**Hugging Face opcional:** a [documentação de preços](https://huggingface.co/docs/inference-providers/pricing) informa que contas gratuitas não recebem créditos de inferência. A integração permanece desligada por padrão. Para ativá-la com créditos, crie um token [fine-grained](https://huggingface.co/settings/tokens) com permissão **Make calls to Inference Providers**, configure `HF_TOKEN`, `HF_MODEL` (padrão `Qwen/Qwen3-4B-Instruct-2507`) e `LLM_ENABLE_HF=true`. O endpoint utilizado é `https://router.huggingface.co/v1/chat/completions`, ao final da sequência.

## Proteção de uso

| Controle | Padrão |
| --- | --- |
| Navegador | 20 mensagens/dia, 12/hora, 3/minuto e intervalo mínimo de 10 segundos |
| IP | 30 mensagens/dia e 6/minuto; IPv6 agrupado por /64 |
| Aplicativo | 40 mensagens/dia, 1.500/mês e 6/minuto |
| Simultaneidade | 1 requisição por navegador, 2 por IP e 3 no aplicativo |
| Tokens | 50.000/dia e 1.600.000/mês, somando modelos e fallbacks |
| Entrada e histórico | Perguntas de até 1.200 caracteres; até quatro pares e 4.000 caracteres de histórico |

As cotas diárias e mensais renovam em UTC. Cada tentativa reserva um orçamento conservador antes de chamar o provedor; a diferença é devolvida quando o consumo real é informado. Falhas sem consumo conhecido mantêm a reserva. Mensagens aceitas contam mesmo se a resposta falhar. Os avisos no chat respeitam `Retry-After` e a pausa é compartilhada entre abas.

O navegador recebe um cookie aleatório assinado e `HttpOnly`, com validade de 90 dias. IPs e identificadores ficam armazenados como HMAC; os contadores não guardam mensagens. Limpar cookies pode renovar o identificador do navegador, mas não zera a cota por IP/global. Identificar uma máquina física sem autenticação não é garantido; VPNs podem contornar limites individuais. Usuários da mesma rede compartilham a cota de IP.

O padrão comporta aproximadamente 1.200 mensagens em 30 dias ou 3.600 em 90 dias, dependendo do consumo e dos outros limites. As cotas dos provedores são renováveis; não há garantia de disponibilidade contínua por três meses. Ajuste os valores no `.env` local ou no painel do host, seguindo `.env.example`.

**Local ou único processo Node:** os contadores persistem em `.data/usage.json` e sobrevivem ao reinício. Para usar esse modo em produção, o host precisa de disco persistente e `RATE_LIMIT_STORE=file`. Não compartilhe esse arquivo entre múltiplos processos.

**Vercel ou múltiplas instâncias:** crie um Redis permanente no [Upstash gratuito](https://upstash.com/pricing/redis) e configure `UPSTASH_REDIS_REST_URL` e `UPSTASH_REDIS_REST_TOKEN`. Não use um banco temporário de 72 horas. Gere um segredo estável para `RATE_LIMIT_SECRET`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

As instâncias compartilham contadores por operações Lua atômicas. Sem Redis em produção serverless, ou se o armazenamento falhar, o chat bloqueia chamadas ao modelo com mensagem amigável, em vez de funcionar sem proteção.

## Deploy na Vercel

1. Importe o repositório e use a **raiz do repositório** como Root Directory (`.`), com Framework Preset **Other** e Node.js 22 ou superior.
2. Em **Settings → Environment Variables**, cadastre `GROQ_API_KEY`, `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN` e `RATE_LIMIT_SECRET`.
3. Cadastre `OPENROUTER_API_KEY` se quiser reserva em outro provedor. Os modelos e limites têm os padrões de `.env.example`.
4. Faça o deploy. O `vercel.json` define o build, publica somente `public/` e mantém `/api/chat` como função de servidor com duração máxima de 60 segundos.

Não configure `PORT` na Vercel. Alterações nas variáveis exigem novo deploy. Em outro host Node, execute `npm ci`, `npm run build` e `npm start`, com as variáveis configuradas no painel.

## Desenvolvimento e validação

```powershell
npm run check
npm test
npm run build
npm run chat:smoke
```

`chat:smoke` usa a chave local e faz uma chamada real. Os demais testes usam respostas e armazenamento isolados.

Os 24 testes cobrem fallback, histórico, erros, timeout, controle de orçamento, concorrência, renovação das cotas e proteção dos arquivos privados. Também foram validadas conversas reais, respostas curtas nos três modelos Groq, bloqueio HTTP 429 no navegador e operações atômicas em Redis real. O deploy remoto depende da configuração do host.

O contrato é `{ message, history? }` → `{ reply }`; erros usam `{ error, retryAfter? }`. `/chat` permanece como alias local de `/api/chat`. Não há streaming.

## Arquivos locais

`.env`, `.data/`, `.cache/`, `node_modules/`, `dist/`, `public/` e `.vercel/` ficam fora do Git. O build copia apenas HTML, JavaScript, CSS e imagens para a pasta pública.

As versões antigas foram removidas da árvore atual. O histórico Git foi preservado: remover um arquivo não apaga segredos de commits anteriores; qualquer chave antiga que tenha sido versionada deve ser revogada.
