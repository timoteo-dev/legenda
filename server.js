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
const HEARTBEAT_INTERVAL_MS = Number(process.env.HEARTBEAT_INTERVAL_MS || 15000);
const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS || 10000);
const DEBUG_LATENCY = process.env.DEBUG_LATENCY === '1';

if (!GEMINI_API_KEY || GEMINI_API_KEY === 'coloque_sua_chave_aqui') {
  console.error('\nERRO: defina GEMINI_API_KEY no .env (https://aistudio.google.com/apikey)\n');
  process.exit(1);
}

const GEMINI_MODEL = 'models/gemini-3.5-transcribe-live';
const GEMINI_WS_URL =
  process.env.GEMINI_WS_URL_OVERRIDE ||
  ('wss://generativelanguage.googleapis.com/ws/' +
  'google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent' +
  `?key=${GEMINI_API_KEY}`);

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

// Desativa Nagle's algorithm (TCP_NODELAY) em conexoes HTTP e upgrades
server.on('connection', (socket) => socket.setNoDelay(true));
server.on('upgrade', (req, socket) => socket.setNoDelay(true));

// WebSocket Server unico para /capture e /captions (sem compressao permessage-deflate)
const wss = new WebSocket.Server({ server, perMessageDeflate: false });

function broadcastCaption(payload, tsInfo) {
  if (DEBUG_LATENCY && tsInfo) payload._ts = tsInfo;
  const data = JSON.stringify(payload);
  wss.clients.forEach((c) => {
    if (c.isCaption && c.readyState === WebSocket.OPEN) c.send(data);
  });
}

// Ponte com o Gemini Live API
const bridge = {
  ws: null,
  handoffWs: null,
  ready: false,
  sessionHandle: null,
  reconnecting: false,
  outgoingQueue: [],
  lastTranscriptAt: Date.now(),
  lastActiveSpeechAt: Date.now(),
  lastChunkCapturedAt: 0,
  lastChunkSentAt: 0,
  lastPingAt: 0,
  lastPongAt: Date.now(),
  pingPending: false,
  goAwayTimer: null,
  shouldReconnect: true,
};

function connectGemini(isHandoff = false) {
  const resumindo = bridge.sessionHandle ? ' (retomando sessao anterior)' : '';
  console.log(`[Gemini] Conectando${isHandoff ? ' (hot handoff)' : ''}...${resumindo}`);

  // perMessageDeflate desligado para eliminar overhead de compressao zlib em streaming continuo
  const ws = new WebSocket(GEMINI_WS_URL, { perMessageDeflate: false });

  if (isHandoff) {
    bridge.handoffWs = ws;
  } else {
    bridge.ws = ws;
  }

  ws.on('open', () => {
    if (ws._socket) ws._socket.setNoDelay(true);
    console.log(`[Gemini] Conexao aberta${isHandoff ? ' (handoff)' : ''}, enviando setup...`);
    const setup = {
      model: GEMINI_MODEL,
      generationConfig: { responseModalities: ['TEXT'] },
      inputAudioTranscription: { languageCodes: [LANGUAGE_CODE] },
    };
    if (bridge.sessionHandle) setup.sessionResumption = { handle: bridge.sessionHandle };

    ws.send(JSON.stringify({ setup }));
    if (!isHandoff) {
      bridge.reconnecting = false;
      bridge.lastTranscriptAt = Date.now();
    }
  });

  ws.on('pong', () => {
    if (ws === bridge.ws) {
      bridge.lastPongAt = Date.now();
      bridge.pingPending = false;
    }
  });

  ws.on('message', (raw) => handleGeminiMessage(raw, ws));

  ws.on('close', (code, reasonBuf) => {
    const isHandoffConn = ws === bridge.handoffWs;
    console.warn(`[Gemini] Conexao ${isHandoffConn ? 'de handoff ' : ''}fechada (${code}). ${reasonBuf ? reasonBuf.toString() : ''}`);
    if (code === 1008) bridge.sessionHandle = null;

    if (isHandoffConn) {
      bridge.handoffWs = null;
      return;
    }

    if (ws === bridge.ws) {
      bridge.ready = false;
      bridge.pingPending = false;
      if (bridge.shouldReconnect) scheduleReconnect();
    }
  });

  ws.on('error', (err) => {
    const isHandoffConn = ws === bridge.handoffWs;
    console.error(`[Gemini] Erro${isHandoffConn ? ' (handoff)' : ''}:`, err.message);
  });
}

function handleGeminiMessage(raw, ws) {
  let response;
  try {
    response = JSON.parse(raw.toString());
  } catch (e) {
    return console.error('[Gemini] Erro de parse JSON:', e.message);
  }

  if (response.setupComplete) {
    console.log(`[Gemini] Setup concluido${ws === bridge.handoffWs ? ' (hot handoff pronto)' : ''}.`);
    bridge.lastTranscriptAt = Date.now();
    bridge.lastActiveSpeechAt = 0;

    if (ws === bridge.handoffWs) {
      // Hot handoff: nova conexao pronta com sessao retomada. Alterna bridge.ws e encerra antiga sem silencio.
      const oldWs = bridge.ws;
      bridge.ws = ws;
      bridge.handoffWs = null;
      bridge.ready = true;
      flushQueue();
      if (oldWs) {
        try { oldWs.close(); } catch {}
      }
      return;
    }

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
    }, 1000);
  }

  if (response.sessionResumptionUpdate?.resumable && response.sessionResumptionUpdate.newHandle) {
    bridge.sessionHandle = response.sessionResumptionUpdate.newHandle;
  }

  // So processa transcricoes se vierem da conexao ativa
  if (ws !== bridge.ws && ws !== bridge.handoffWs) return;

  const now = Date.now();
  const content = response.serverContent;
  if (content?.interimInputTranscription?.text) {
    bridge.lastTranscriptAt = now;
    const text = content.interimInputTranscription.text;
    const tsInfo = {
      t_worklet: bridge.lastChunkCapturedAt,
      t_gemini_send: bridge.lastChunkSentAt,
      t_gemini_recv: now,
      total_ms: bridge.lastChunkCapturedAt ? (now - bridge.lastChunkCapturedAt) : null,
    };
    if (DEBUG_LATENCY) {
      const e2e = tsInfo.total_ms != null ? `${tsInfo.total_ms}ms` : 'N/A';
      console.log(`[Latência] Interim: e2e ~${e2e} (Gemini ~${now - bridge.lastChunkSentAt}ms) | "${text.slice(0, 30)}..."`);
    }
    broadcastCaption({ type: 'interim', text }, tsInfo);
  }
  if (content?.inputTranscription?.text) {
    bridge.lastTranscriptAt = now;
    const text = content.inputTranscription.text;
    const tsInfo = {
      t_worklet: bridge.lastChunkCapturedAt,
      t_gemini_send: bridge.lastChunkSentAt,
      t_gemini_recv: now,
      total_ms: bridge.lastChunkCapturedAt ? (now - bridge.lastChunkCapturedAt) : null,
    };
    if (DEBUG_LATENCY) {
      const e2e = tsInfo.total_ms != null ? `${tsInfo.total_ms}ms` : 'N/A';
      console.log(`[Latência] Final:   e2e ~${e2e} (Gemini ~${now - bridge.lastChunkSentAt}ms) | "${text}"`);
    }
    broadcastCaption({ type: 'final', text }, tsInfo);
  }
}

function rotateSession() {
  if (bridge.handoffWs) return; // Handoff ja em progresso
  console.log('[Gemini] Rotacao proativa (goAway), retomando sessao anterior');
  connectGemini(true);
}

function scheduleReconnect() {
  if (bridge.reconnecting) return;
  bridge.reconnecting = true;
  broadcastCaption({ type: 'status', state: 'sincronizando' });
  setTimeout(() => connectGemini(false), 500);
}

function isSpeechActive(buf) {
  for (let i = 0; i < buf.length - 1; i += 2) {
    if (Math.abs(buf.readInt16LE(i)) > 500) return true;
  }
  return false;
}

function sendAudioChunk(pcmBuffer, capturedAt) {
  if (isSpeechActive(pcmBuffer)) bridge.lastActiveSpeechAt = Date.now();

  const now = Date.now();
  bridge.lastChunkSentAt = now;
  if (capturedAt) bridge.lastChunkCapturedAt = capturedAt;

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

// Heartbeat real e independente da fala (detecta conexao zumbi mesmo durante silencio longo)
setInterval(() => {
  if (!bridge.ready || bridge.ws?.readyState !== WebSocket.OPEN) return;
  const now = Date.now();

  if (bridge.pingPending && (now - bridge.lastPingAt > HEARTBEAT_TIMEOUT_MS)) {
    console.warn('[Heartbeat] Sem pong, conexao morta, reiniciando sessao do zero');
    bridge.sessionHandle = null; // Zera sessao suspeita
    bridge.pingPending = false;
    if (bridge.handoffWs) {
      try { bridge.handoffWs.terminate(); } catch {}
      bridge.handoffWs = null;
    }
    try { bridge.ws.terminate(); } catch {}
    return;
  }

  if (!bridge.pingPending && (now - bridge.lastPingAt >= HEARTBEAT_INTERVAL_MS)) {
    bridge.pingPending = true;
    bridge.lastPingAt = now;
    try { bridge.ws.ping(); } catch {}
  }
}, 1000);

// Watchdog contra travamento silencioso (fala ativa sem transcricao)
setInterval(() => {
  const now = Date.now();
  if (now - bridge.lastActiveSpeechAt < WATCHDOG_TIMEOUT_MS && now - bridge.lastTranscriptAt > WATCHDOG_TIMEOUT_MS) {
    console.warn('[Watchdog] Fala sem transcricao, reiniciando sessao do zero');
    bridge.lastTranscriptAt = now;
    bridge.sessionHandle = null; // Zera sessao suspeita
    if (bridge.handoffWs) {
      try { bridge.handoffWs.terminate(); } catch {}
      bridge.handoffWs = null;
    }
    try { bridge.ws.terminate(); } catch {}
  }
}, 1000);

// Roteamento WebSocket
wss.on('connection', (ws, req) => {
  if (ws._socket) ws._socket.setNoDelay(true);

  if (req.url?.startsWith('/capture')) {
    console.log('[Captura] Cliente conectado.');
    ws.on('message', (data) => {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
      let capturedAt = 0;
      let pcm = buf;
      if (buf.length > 8) {
        const maybeTs = buf.readDoubleLE(0);
        if (maybeTs > 1700000000000 && maybeTs < 2050000000000) {
          capturedAt = maybeTs;
          pcm = buf.subarray(8);
        }
      }
      sendAudioChunk(pcm, capturedAt);
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

connectGemini(false);

server.listen(PORT, () => {
  console.log(`\nServidor rodando em http://localhost:${PORT}`);
  console.log(`- Captura: http://localhost:${PORT}/captura.html`);
  console.log(`- Telao:   http://localhost:${PORT}/telao.html\n`);
});

process.on('SIGINT', () => {
  console.log('\nEncerrando servidor...');
  bridge.shouldReconnect = false;
  if (bridge.handoffWs) { try { bridge.handoffWs.close(); } catch {} }
  try { bridge.ws.close(); } catch {}
  process.exit(0);
});
