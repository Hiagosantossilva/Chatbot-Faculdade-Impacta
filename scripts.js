let historico = [];
let enviando = false;
let ultimaFalha = null;
let bloqueadoAte = 0;
const chaveEspera = 'impacta_wait_until';
try { bloqueadoAte = Number(localStorage.getItem(chaveEspera)) || 0; } catch {}

const campo = document.getElementById('mensagem');
const botao = document.getElementById('enviar');
const conversa = document.getElementById('conversa');
const boasVindas = document.getElementById('boas-vindas');
const respostaEl = document.getElementById('resposta');
const novaConversa = document.getElementById('nova-conversa');
const limiteAviso = document.getElementById('limite-aviso');

function definirEspera(segundos) {
  if (!Number.isFinite(segundos) || segundos <= 0) return;
  bloqueadoAte = Math.max(bloqueadoAte, Date.now() + Math.min(segundos, 2678400) * 1000);
  try { localStorage.setItem(chaveEspera, String(bloqueadoAte)); } catch {}
  atualizarCampo();
}

function atualizarEspera() {
  const segundos = Math.max(0, Math.ceil((bloqueadoAte - Date.now()) / 1000));
  const tempo = segundos < 60 ? segundos + 's' : segundos < 3600 ? Math.ceil(segundos / 60) + ' min'
    : segundos < 86400 ? Math.ceil(segundos / 3600) + 'h' : Math.ceil(segundos / 86400) + ' dia(s)';
  limiteAviso.hidden = !segundos;
  limiteAviso.textContent = segundos ? 'Aguarde ' + tempo + ' para enviar outra mensagem.' : '';
  botao.disabled = enviando || segundos > 0 || !campo.value.trim();
  document.querySelectorAll('.retry-button').forEach(button => { button.disabled = enviando || segundos > 0; });
}

function atualizarCampo() {
  const alturaMaxima = parseFloat(getComputedStyle(campo).maxHeight);
  campo.style.height = 'auto';
  campo.style.height = Math.min(campo.scrollHeight, alturaMaxima) + 'px';
  atualizarEspera();
  const contador = document.getElementById('contador');
  contador.textContent = campo.value.length.toLocaleString('pt-BR') + ' / 1.200';
  contador.classList.toggle('is-close', campo.value.length >= 1100);
}

function rolarConversa() {
  conversa.scrollTop = conversa.scrollHeight;
}

function limitarHistorico() {
  while (historico.length > 8 || historico.reduce((total, item) => total + item.content.length, 0) > 4000) {
    historico.splice(0, 2);
  }
}

// Format a small subset of Markdown using DOM nodes, never untrusted HTML.
function formatarResposta(elemento, texto) {
  elemento.replaceChildren();
  for (const [indice, trecho] of texto.split(/```/).entries()) {
    if (indice % 2) {
      const bloco = document.createElement('pre');
      const codigo = document.createElement('code');
      codigo.textContent = trecho.replace(/^[a-zA-Z0-9#+.-]*\n/, '').replace(/\n$/, '');
      bloco.appendChild(codigo);
      elemento.appendChild(bloco);
      continue;
    }
    for (const parte of trecho.split(/(\*\*[^*\n]+\*\*|`[^`\n]+`)/g)) {
      if (parte.startsWith('**') && parte.endsWith('**')) {
        const negrito = document.createElement('strong');
        negrito.textContent = parte.slice(2, -2);
        elemento.appendChild(negrito);
      } else if (parte.startsWith('`') && parte.endsWith('`')) {
        const codigo = document.createElement('code');
        codigo.textContent = parte.slice(1, -1);
        elemento.appendChild(codigo);
      } else {
        elemento.appendChild(document.createTextNode(parte));
      }
    }
  }
}

function criarMensagem(papel, texto = '') {
  boasVindas.hidden = true;
  const linha = document.createElement('article');
  linha.className = 'message message--' + papel;
  linha.setAttribute('aria-label', papel === 'user' ? 'Mensagem de você' : 'Resposta do ChatBot Impacta');
  if (papel === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    const imagem = document.createElement('img');
    imagem.src = 'Design/Imagens/BotMenor.png';
    imagem.alt = '';
    avatar.appendChild(imagem);
    linha.appendChild(avatar);
  }
  const conjunto = document.createElement('div');
  conjunto.className = 'message-stack';
  const nome = document.createElement('span');
  nome.className = 'message-label';
  nome.textContent = papel === 'user' ? 'Você' : 'Impacta';
  const conteudo = document.createElement('div');
  conteudo.className = 'message-content';
  conteudo.textContent = texto;
  conjunto.append(nome, conteudo);
  linha.appendChild(conjunto);
  conversa.appendChild(linha);
  rolarConversa();
  return { linha, conteudo };
}

function mostrarCarregamento(mensagem) {
  mensagem.linha.classList.add('message--pending');
  const pontos = document.createElement('span');
  pontos.className = 'typing';
  pontos.setAttribute('aria-hidden', 'true');
  for (let i = 0; i < 3; i++) pontos.appendChild(document.createElement('span'));
  mensagem.conteudo.append(pontos, document.createTextNode('Pensando…'));
}

async function enviar(textoForcado, tentativaAnterior) {
  const mensagem = (typeof textoForcado === 'string' ? textoForcado : campo.value).trim();
  if (enviando || Date.now() < bloqueadoAte || !mensagem) return;
  if (mensagem.length > 1200) {
    respostaEl.textContent = 'Sua mensagem deve ter até 1.200 caracteres.';
    return;
  }
  if (!tentativaAnterior && ultimaFalha?.mensagem === mensagem) tentativaAnterior = ultimaFalha.resposta;
  ultimaFalha = null;
  enviando = true;
  definirEspera(10);
  novaConversa.disabled = true;
  conversa.setAttribute('aria-busy', 'true');
  document.querySelectorAll('.retry-button').forEach(button => { button.disabled = true; });
  if (typeof textoForcado !== 'string' || campo.value.trim() === mensagem) campo.value = '';
  atualizarCampo();
  // A retry replaces the failed response and keeps the original user bubble.
  if (tentativaAnterior) tentativaAnterior.linha.remove();
  if (!tentativaAnterior) criarMensagem('user', mensagem);
  const resposta = criarMensagem('assistant');
  mostrarCarregamento(resposta);
  respostaEl.textContent = 'Preparando sua resposta.';
  rolarConversa();
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: AbortSignal.timeout(55000),
      body: JSON.stringify({ message: mensagem, history: historico }),
    });
    let data;
    try { data = await res.json(); }
    catch { throw new Error('O servidor está indisponível. Tente novamente em instantes.'); }
    if (!res.ok) {
      if (res.status === 429 || (res.status === 503 && data.retryAfter)) {
        definirEspera(Number(data.retryAfter || res.headers.get('Retry-After')) || 60);
      }
      throw new Error(typeof data.error === 'string' ? data.error : 'Não foi possível conversar agora. Tente novamente.');
    }
    if (typeof data.reply !== 'string' || !data.reply.trim()) {
      throw new Error('Não foi possível obter uma resposta. Tente novamente.');
    }
    resposta.linha.classList.remove('message--pending');
    formatarResposta(resposta.conteudo, data.reply);
    historico.push({ role: 'user', content: mensagem }, { role: 'assistant', content: data.reply });
    if (data.reply.length > 4000) historico = [];
    limitarHistorico();
    // Older failed turns cannot be retried out of order after a successful reply.
    document.querySelectorAll('.retry-button').forEach(button => button.remove());
    respostaEl.textContent = 'Resposta recebida.';
  } catch (error) {
    const aviso = error.name === 'TimeoutError' || error.name === 'AbortError'
      ? 'A resposta demorou demais. Tente novamente em instantes.'
      : error instanceof TypeError ? 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.'
      : error.message;
    resposta.linha.classList.remove('message--pending');
    resposta.linha.classList.add('message--error');
    resposta.conteudo.textContent = aviso;
    const repetir = document.createElement('button');
    repetir.type = 'button';
    repetir.className = 'retry-button';
    repetir.textContent = 'Tentar novamente';
    repetir.addEventListener('click', () => enviar(mensagem, resposta));
    resposta.conteudo.appendChild(repetir);
    ultimaFalha = { mensagem, resposta };
    if (!campo.value) campo.value = mensagem;
    respostaEl.textContent = aviso;
  } finally {
    enviando = false;
    novaConversa.disabled = false;
    conversa.setAttribute('aria-busy', 'false');
    document.querySelectorAll('.retry-button').forEach(button => { button.disabled = false; });
    atualizarCampo();
    rolarConversa();
  }
}

document.getElementById('form-mensagem').addEventListener('submit', event => {
  event.preventDefault();
  enviar();
});
campo.addEventListener('input', atualizarCampo);
window.addEventListener('resize', atualizarCampo);
campo.addEventListener('keydown', event => {
  // Mobile keyboards keep Enter for multiline text; the send button remains visible.
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !matchMedia('(pointer: coarse)').matches) {
    event.preventDefault();
    enviar();
  }
});
document.querySelectorAll('[data-suggestion]').forEach(button => {
  button.addEventListener('click', () => {
    campo.value = button.dataset.suggestion;
    atualizarCampo();
    campo.focus({ preventScroll: true });
  });
});
novaConversa.addEventListener('click', () => {
  if (enviando) return;
  historico = [];
  ultimaFalha = null;
  conversa.querySelectorAll('.message').forEach(message => message.remove());
  boasVindas.hidden = false;
  campo.value = '';
  respostaEl.textContent = 'Nova conversa iniciada.';
  atualizarCampo();
  campo.focus({ preventScroll: true });
  conversa.scrollTop = 0;
});
atualizarCampo();
setInterval(atualizarEspera, 1000);
window.addEventListener('storage', event => {
  if (event.key === chaveEspera) {
    bloqueadoAte = Number(event.newValue) || 0;
    atualizarEspera();
  }
});
