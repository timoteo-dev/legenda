// Teste completo de integracao: baixa latencia, hot handoff, silencio longo, heartbeat e watchdog
const http = require('http');
const WebSocket = require('ws');
const { spawn } = require('child_process');
const assert = require('assert');

async function main() {
  console.log('=== TESTE DE RESILIÊNCIA: SILÊNCIO LONGO, HEARTBEAT, WATCHDOG E HOT HANDOFF ===\n');

  let geminiSetupCount = 0;
  let activeGeminiSockets = [];
  let receivedAudioChunks = 0;
  let dropPongs = false;
  let suppressTranscripts = false;
  let lastSetupResumption = undefined;

  const mockGeminiServer = http.createServer();
  const mockGeminiWss = new WebSocket.Server({ server: mockGeminiServer, perMessageDeflate: false });

  mockGeminiWss.on('connection', (ws) => {
    const connIndex = activeGeminiSockets.length + 1;
    activeGeminiSockets.push(ws);
    console.log(`[Mock Gemini] Conexão #${connIndex} recebida`);

    // Intercepta ws.pong para simular socket zumbi quando dropPongs for ativado
    const origPong = ws.pong.bind(ws);
    ws.pong = (data, mask, cb) => {
      if (dropPongs) {
        console.log(`[Mock Gemini] Conexão #${connIndex}: PONG suprimido (simulando zumbi)`);
        return;
      }
      return origPong(data, mask, cb);
    };

    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.setup) {
        geminiSetupCount++;
        lastSetupResumption = msg.setup.sessionResumption || null;
        console.log(`[Mock Gemini] Setup #${geminiSetupCount} recebido na conexão #${connIndex}. Resumption:`, JSON.stringify(lastSetupResumption));
        ws.send(JSON.stringify({ setupComplete: true }));
        ws.send(JSON.stringify({
          sessionResumptionUpdate: { resumable: true, newHandle: `handle_sessao_${connIndex}` }
        }));
      } else if (msg.realtimeInput?.audio) {
        receivedAudioChunks++;
        if (!suppressTranscripts) {
          ws.send(JSON.stringify({
            serverContent: {
              interimInputTranscription: { text: `palavra_${receivedAudioChunks}` }
            }
          }));
        }
      }
    });

    ws.on('close', () => {
      console.log(`[Mock Gemini] Conexão #${connIndex} fechada`);
    });
  });

  await new Promise((res) => mockGeminiServer.listen(0, res));
  const geminiPort = mockGeminiServer.address().port;
  console.log(`[Mock Gemini] Ouvindo na porta ${geminiPort}`);

  // Iniciar server.js com timers acelerados para teste automatizado
  const serverPort = 3998;
  const env = {
    ...process.env,
    PORT: String(serverPort),
    GEMINI_API_KEY: 'chave_de_teste',
    GEMINI_WS_URL_OVERRIDE: `ws://127.0.0.1:${geminiPort}`,
    DEBUG_LATENCY: '1',
    WATCHDOG_TIMEOUT_MS: '2000',
    HEARTBEAT_INTERVAL_MS: '1500',
    HEARTBEAT_TIMEOUT_MS: '1000',
  };

  const serverProc = spawn(process.execPath, ['server.js'], {
    env,
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  serverProc.stdout.on('data', (d) => process.stdout.write(`[server.js] ${d}`));
  serverProc.stderr.on('data', (d) => process.stderr.write(`[server.js ERR] ${d}`));

  await new Promise((res) => setTimeout(res, 1200));

  // Conectar Telão (/captions) e Captura (/capture)
  console.log('\n[Teste] Conectando Telão e Captura...');
  const telaoWs = new WebSocket(`ws://127.0.0.1:${serverPort}/captions`);
  let telaoMessages = [];
  telaoWs.on('message', (d) => telaoMessages.push(JSON.parse(d.toString())));
  await new Promise((res) => telaoWs.on('open', res));

  const capturaWs = new WebSocket(`ws://127.0.0.1:${serverPort}/capture`);
  capturaWs.binaryType = 'arraybuffer';
  await new Promise((res) => capturaWs.on('open', res));
  console.log('[Teste] Conexões estabelecidas com sucesso.');

  // ==========================================
  // CENÁRIO 1: Envio inicial de áudio normal
  // ==========================================
  console.log('\n--- CENÁRIO 1: Envio de áudio normal (chunks de 20ms) ---');
  for (let i = 0; i < 3; i++) {
    const pcm = Buffer.alloc(640);
    pcm.writeInt16LE(1500, 0);
    const packet = Buffer.alloc(8 + pcm.length);
    packet.writeDoubleLE(Date.now(), 0);
    pcm.copy(packet, 8);
    capturaWs.send(packet);
    await new Promise((res) => setTimeout(res, 25));
  }
  await new Promise((res) => setTimeout(res, 300));
  assert(telaoMessages.some((m) => m.type === 'interim'), 'Telão deve receber texto');
  console.log('✔ Cenário 1 aprovado: áudio capturado e transcrito com sucesso.');

  // ==========================================
  // CENÁRIO 2: Silêncio prolongado saudável
  // ==========================================
  console.log('\n--- CENÁRIO 2: Silêncio longo (o pregador parou de falar) ---');
  console.log('[Teste] Simulando silêncio total por 3,5 segundos (múltiplos ciclos de heartbeat)...');
  const setupCountBeforeSilence = geminiSetupCount;

  // Envia apenas ruído de fundo (< 500) ou nenhum áudio por 3,5s
  for (let i = 0; i < 7; i++) {
    const pcmQuiet = Buffer.alloc(640);
    pcmQuiet.writeInt16LE(50, 0); // amplitude baixa = sem fala ativa
    const packet = Buffer.alloc(8 + pcmQuiet.length);
    packet.writeDoubleLE(Date.now(), 0);
    pcmQuiet.copy(packet, 8);
    capturaWs.send(packet);
    await new Promise((res) => setTimeout(res, 500));
  }

  assert.strictEqual(geminiSetupCount, setupCountBeforeSilence, 'Em silêncio com ping/pong saudável NÃO pode haver reconexão!');
  console.log('✔ Cenário 2 aprovado: silêncio mantido estável sem falsas reconexões.');

  // ==========================================
  // CENÁRIO 3: Conexão zumbi no silêncio (Heartbeat detecta)
  // ==========================================
  console.log('\n--- CENÁRIO 3: Conexão zumbi (Gemini para de responder PONG) ---');
  dropPongs = true; // Simula socket zumbi
  console.log('[Teste] Bloqueando respostas de PONG. Aguardando Heartbeat terminar a conexão...');

  // Aguarda heartbeat detectar timeout e reconectar reativamente
  await new Promise((res, rej) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (geminiSetupCount > setupCountBeforeSilence) {
        clearInterval(interval);
        dropPongs = false;
        res();
      } else if (Date.now() - start > 5000) {
        clearInterval(interval);
        rej(new Error('Heartbeat não reconectou no tempo limite'));
      }
    }, 50);
  });

  assert(geminiSetupCount > setupCountBeforeSilence, 'Heartbeat deve ter reconectado!');
  assert.strictEqual(lastSetupResumption, null, 'Sessão zumbi suspeita DEVE ser zerada (Resumption: null)!');
  console.log('✔ Cenário 3 aprovado: Heartbeat matou conexão zumbi e iniciou sessão limpa do zero.');

  // Fala volta após a recuperação do Heartbeat
  console.log('[Teste] O pastor volta a falar após a recuperação do Heartbeat...');
  telaoMessages = [];
  for (let i = 0; i < 3; i++) {
    const pcm = Buffer.alloc(640);
    pcm.writeInt16LE(1500, 0);
    const packet = Buffer.alloc(8 + pcm.length);
    packet.writeDoubleLE(Date.now(), 0);
    pcm.copy(packet, 8);
    capturaWs.send(packet);
    await new Promise((res) => setTimeout(res, 25));
  }
  await new Promise((res) => setTimeout(res, 400));
  assert(telaoMessages.some((m) => m.type === 'interim'), 'Legenda deve voltar a funcionar após reconexão pelo Heartbeat');
  console.log('✔ Legenda voltou a funcionar imediatamente!');

  // ==========================================
  // CENÁRIO 4: Watchdog de fala ativa sem transcrição
  // ==========================================
  console.log('\n--- CENÁRIO 4: Watchdog (fala ativa mas Gemini trava transcrição) ---');
  suppressTranscripts = true; // Simula Gemini parando de mandar texto
  console.log('[Teste] Enviando fala contínua enquanto transcrições estão travadas...');

  const setupCountBeforeWatchdog = geminiSetupCount;
  const watchdogStart = Date.now();
  while (Date.now() - watchdogStart < 3800) {
    const pcm = Buffer.alloc(640);
    pcm.writeInt16LE(2000, 0); // fala ativa
    const packet = Buffer.alloc(8 + pcm.length);
    packet.writeDoubleLE(Date.now(), 0);
    pcm.copy(packet, 8);
    capturaWs.send(packet);
    await new Promise((res) => setTimeout(res, 50));
  }

  assert(geminiSetupCount > setupCountBeforeWatchdog, 'Watchdog deve ter disparado reconexão!');
  assert.strictEqual(lastSetupResumption, null, 'Sessão travada no Watchdog DEVE ser zerada (Resumption: null)!');
  suppressTranscripts = false;
  console.log('✔ Cenário 4 aprovado: Watchdog detectou fala sem transcrição, zerou a sessão e reconectou.');

  // Normaliza o fluxo enviando fala com transcrição sucedida antes do goAway
  const pcmNormal = Buffer.alloc(640);
  pcmNormal.writeInt16LE(1500, 0);
  const packetNormal = Buffer.alloc(8 + pcmNormal.length);
  packetNormal.writeDoubleLE(Date.now(), 0);
  pcmNormal.copy(packetNormal, 8);
  capturaWs.send(packetNormal);
  await new Promise((res) => setTimeout(res, 400));

  // ==========================================
  // CENÁRIO 5: Rotação Proativa (goAway)
  // ==========================================
  console.log('\n--- CENÁRIO 5: Rotação Proativa (goAway com Retomada de Sessão) ---');
  let handoffResumptionCaptured = null;
  const currentSetupCount = geminiSetupCount;

  // Intercepta setup da conexão de handoff
  const currentActiveWs = activeGeminiSockets[activeGeminiSockets.length - 1];
  currentActiveWs.send(JSON.stringify({ goAway: { timeLeft: '30s' } }));

  // Aguarda setup da rotação proativa
  await new Promise((res, rej) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (geminiSetupCount > currentSetupCount) {
        clearInterval(interval);
        handoffResumptionCaptured = lastSetupResumption;
        res();
      } else if (Date.now() - start > 4000) {
        clearInterval(interval);
        rej(new Error('Handoff não executou setup no tempo limite'));
      }
    }, 50);
  });

  assert(handoffResumptionCaptured !== null && typeof handoffResumptionCaptured.handle === 'string',
    'Rotação proativa por goAway DEVE preservar a sessão (Resumption NÃO pode ser null)!');
  console.log('✔ Cenário 5 aprovado: Rotação proativa preservou a sessão perfeitamente.');

  console.log('\n============================================================');
  console.log('🎉 TODOS OS CENÁRIOS FORAM VALIDADOS COM 100% DE SUCESSO! 🎉');
  console.log('============================================================');

  telaoWs.close();
  capturaWs.close();
  serverProc.kill('SIGINT');
  mockGeminiServer.close();
  process.exit(0);
}

main().catch((err) => {
  console.error('\n❌ Falha no teste:', err);
  process.exit(1);
});
