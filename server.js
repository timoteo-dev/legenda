// Servidor de legendas ao vivo - ponte entre o navegador e o Gemini 3.5 Transcribe Live.
try { process.loadEnvFile(); } catch {}

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LANGUAGE_CODE = process.env.LANGUAGE_CODE || 'pt-BR';
const WATCHDOG_TIMEOUT_MS = Number(process.env.WATCHDOG_TIMEOUT_MS || 20000);

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'coloque_sua_chave_aqui') {
  console.error('\nERRO: defina GEMINI_API_KEY no .env (https://aistudio.google.com/apikey)\n');
  process.exit(1);
}

const GEMINI_MODEL = 'models/gemini-3.5-transcribe-live';
const GEMINI_WS_URL =
  'wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' +
  `?key=${GEMINI_API_KEY}`;

// Servidor HTTP estatico (substitui Express)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript', '.css': 'text/css' };
const PUBLIC_DIR = path.join(__dirname, 'public');

const server = http.createServer((req, res) => {
  const filePath = path.join(PUBLIC_DIR, req.url === '/' ? 'telao.html' : req.url);
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(data);
  });
});

// WebSocket Server unico para /capture e /captions
const wss = new WebSocket.Server({ server });

function broadcastCaption(payload) {
  const data = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.isCaption && c.readyState === WebSocket.OPEN) c.send(data);
  });
}

// Ponte com o Gemini Live API
const bridge = {
  ws: null,
  ready: false,
  sessionHandle: null,
  reconnecting: false,
  outgoingQueue: [],
  lastTranscriptAt: Date.now(),
  lastActiveSpeechAt: Date.now(),
  goAwayTimer: null,
  shouldReconnect: true,
};

function connectGemini() {
  const resumindo = bridge.sessionHandle ? ' (retomando sessao anterior)' : '';
  console.log(`[Gemini] Conectando...${resumindo}`);

  bridge.ws = new WebSocket(GEMINI_WS_URL);

  bridge.ws.on('open', () => {
    console.log('[Gemini] Conexao aberta, enviando setup...');
    const setup = {
      model: GEMINI_MODEL,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: [LANGUAGE_CODE] },
    };
    if (bridge.sessionHandle) setup.sessionResumption = { handle: bridge.sessionHandle };

    bridge.ws.send(JSON.stringify({ setup }));
    bridge.reconnecting = false;
    bridge.lastTranscriptAt = Date.now();
  });

  bridge.ws.on('message', handleGeminiMessage);

  bridge.ws.on('close', (code, reasonBuf) => {
    console.warn(`[Gemini] Conexao fechada (${code}). ${reasonBuf ? reasonBuf.toString() : ''}`);
    bridge.ready = false;
    if (code === 1008) bridge.sessionHandle = null;
    if (bridge.shouldReconnect) scheduleReconnect();
  });

  bridge.ws.on('error', (err) => console.error('[Gemini] Erro:', err.message));
}

function handleGeminiMessage(raw) {
  let response;
  try {
    response = JSON.parse(raw.toString());
  } catch (e) {
    return console.error('[Gemini] Erro de parse JSON:', e.message);
  }

  if (response.setupComplete) {
    console.log('[Gemini] Setup concluido.');
    bridge.ready = true;
    flushQueue();
    broadcastCaption({ type: 'status', state: 'ao_vivo' });
    return;
  }

  if (response.goAway && !bridge.goAwayTimer) {
    console.log('[Gemini] GoAway recebido. Tempo restante:', response.goAway.timeLeft);
    bridge.goAwayTimer = setTimeout(() => {
      bridge.goAwayTimer = null;
      rotateSession();
    }, 2000);
  }

  if (response.sessionResumptionUpdate?.resumable && response.sessionResumptionUpdate.newHandle) {
    bridge.sessionHandle = response.sessionResumptionUpdate.newHandle;
  }

  const content = response.serverContent;
  if (content?.interimInputTranscription?.text) {
    bridge.lastTranscriptAt = Date.now();
    broadcastCaption({ type: 'interim', text: content.interimInputTranscription.text });
  }
  if (content?.inputTranscription?.text) {
    bridge.lastTranscriptAt = Date.now();
    broadcastCaption({ type: 'final', text: content.inputTranscription.text });
  }
}

function rotateSession() {
  console.log('[Gemini] Rotacionando sessao proativamente...');
  broadcastCaption({ type: 'status', state: 'sincronizando' });
  try { bridge.ws.close(); } catch {}
}

function scheduleReconnect() {
  if (bridge.reconnecting) return;
  bridge.reconnecting = true;
  broadcastCaption({ type: 'status', state: 'sincronizando' });
  setTimeout(connectGemini, 500);
}

function isSpeechActive(buf) {
  for (let i = 0; i < buf.length - 1; i += 2) {
    if (Math.abs(buf.readInt16LE(i)) > 500) return true;
  }
  return false;
}

function sendAudioChunk(pcmBuffer) {
  if (isSpeechActive(pcmBuffer)) bridge.lastActiveSpeechAt = Date.now();

  const message = JSON.stringify({
    realtimeInput: {
      audio: {
        data: pcmBuffer.toString('base64'),
        mimeType: 'audio/pcm;rate=16000',
      },
    },
  });

  if (bridge.ready && bridge.ws?.readyState === WebSocket.OPEN) {
    bridge.ws.send(message);
  } else {
    bridge.outgoingQueue.push(message);
    if (bridge.outgoingQueue.length > 50) bridge.outgoingQueue.shift();
  }
}

function flushQueue() {
  while (bridge.outgoingQueue.length && bridge.ready && bridge.ws?.readyState === WebSocket.OPEN) {
    bridge.ws.send(bridge.outgoingQueue.shift());
  }
}

// Watchdog contra travamento silencioso
setInterval(() => {
  const now = Date.now();
  if (now - bridge.lastActiveSpeechAt < WATCHDOG_TIMEOUT_MS && now - bridge.lastTranscriptAt > WATCHDOG_TIMEOUT_MS) {
    console.warn('[Watchdog] Fala ativa sem transcricao. Forcando reconexao...');
    bridge.lastTranscriptAt = now;
    try { bridge.ws.close(); } catch {}
  }
}, 3000);

// Roteamento WebSocket
wss.on('connection', (ws, req) => {
  if (req.url?.startsWith('/capture')) {
    console.log('[Captura] Cliente conectado.');
    ws.on('message', (data) => {
      sendAudioChunk(Buffer.isBuffer(data) ? data : Buffer.from(data));
    });
    ws.on('close', () => console.log('[Captura] Cliente desconectado.'));
  } else if (req.url?.startsWith('/captions')) {
    ws.isCaption = true;
    console.log('[Legendas] Espectador conectado.');
    ws.send(JSON.stringify({ type: 'status', state: 'ao_vivo' }));
  } else {
    ws.close();
  }
});

connectGemini();

server.listen(PORT, () => {
  console.log(`\nServidor rodando em http://localhost:${PORT}`);
  console.log(`- Captura: http://localhost:${PORT}/captura.html`);
  console.log(`- Telao:   http://localhost:${PORT}/telao.html\n`);
});

process.on('SIGINT', () => {
  console.log('\nEncerrando servidor...');
  bridge.shouldReconnect = false;
  try { bridge.ws.close(); } catch {}
  process.exit(0);
});
