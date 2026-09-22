# Legendas ao Vivo para Pregação

Sistema de legendagem automática ao vivo, usando o **Gemini 3.5 Transcribe Live**
do Google, pensado para rodar localmente na igreja durante o culto.

Testado até o limite deste projeto: o servidor conecta de verdade no endpoint
do Gemini (confirmado durante o desenvolvimento), serve as páginas e faz
reconexão automática. Você só precisa colocar sua chave de API de verdade.

## Como funciona, resumidamente

```
Microfone do pastor
      │
      ▼
Mesa Soundcraft Ui24R (canal do pastor roteado pra uma saída dedicada)
      │  cabo USB-B → USB-A
      ▼
Notebook ligado na mesa
      │
      ├── abre captura.html no navegador → captura o áudio da entrada USB
      │        e envia continuamente pro servidor local (PCM 16kHz)
      │
      ▼
Servidor Node.js local (server.js)
      │  mantém a conexão com o Gemini sempre viva, trocando de sessão
      │  sozinho antes do limite de ~10 minutos, e com um "watchdog" que
      │  reconecta se a transcrição parar de chegar silenciosamente
      ▼
Gemini 3.5 Transcribe Live (Google)
      │  devolve texto parcial (enquanto fala) e final (quando termina a frase)
      ▼
Servidor Node.js local
      │  distribui a legenda pra quem estiver ouvindo
      ▼
telao.html aberto em outra janela → espelhado no projetor via HDMI
```

## 1. Pré-requisitos

- **Node.js 18 ou mais recente** instalado no notebook que vai rodar o servidor
  (baixe em https://nodejs.org se não tiver).
- Uma **chave de API do Gemini**, gerada de graça em
  https://aistudio.google.com/apikey (é só entrar com uma conta Google).
- O notebook ligado na mesa **Soundcraft Ui24R via cabo USB** (USB-B na mesa,
  USB-A no notebook). No Windows, instale o driver oficial da Soundcraft/Harman
  primeiro (procure "Ui24R USB Audio Driver" no site harman.com); no Mac, ela
  costuma aparecer direto no Core Audio.

## 2. Instalação

Abra um terminal dentro da pasta do projeto e rode:

```bash
npm install
```

Depois, copie o arquivo de configuração de exemplo:

```bash
cp .env.example .env
```

Abra o arquivo `.env` num editor de texto e cole sua chave de API no lugar de
`coloque_sua_chave_aqui`:

```
GEMINI_API_KEY=sua_chave_real_aqui
```

## 3. Rodando

```bash
npm start
```

Se tudo estiver certo, você vai ver algo como:

```
Servidor rodando em http://localhost:3000
- Página de captura (rodar na máquina ligada na mesa): http://localhost:3000/captura.html
- Página do telão (mostrar no projetor):               http://localhost:3000/telao.html
```

Deixe esse terminal aberto durante todo o culto — é ele que mantém tudo
funcionando.

## 4. Configurando a mesa Ui24R

Pra evitar que a legenda pegue música, outros microfones ou ruído de fundo
junto com a voz do pastor:

1. No app/painel da Ui24R, identifique em qual canal o microfone do pastor
   está plugado (ex: canal 1).
2. Roteie **só esse canal** (via *direct out* ou uma aux dedicada) para um dos
   pares de canal da interface USB da mesa — a Ui24R funciona como uma
   interface de áudio USB de até 32 canais quando ligada por USB no
   computador.
3. Na página `captura.html`, no campo "Dispositivo de entrada de áudio",
   escolha a entrada correspondente a esse canal da mesa (não o microfone
   embutido do notebook).

## 5. No dia do culto

1. Na máquina ligada na mesa, abra `http://localhost:3000/captura.html`,
   escolha o dispositivo de entrada certo e clique em **Iniciar captura**.
   Deixe essa aba aberta e a máquina sem hibernar/suspender durante o culto.
2. Numa janela separada (pode ser na mesma máquina, espelhada por HDMI, ou em
   qualquer outro computador/tablet na mesma rede Wi-Fi), abra
   `http://localhost:3000/telao.html` e deixe em tela cheia (F11 na maioria
   dos navegadores). É essa janela que vai pro projetor.
3. Pronto — a legenda aparece sozinha conforme o pastor fala, mesmo depois de
   pausas longas.

Se quiser que alguém acompanhe pelo celular, dentro da mesma rede Wi-Fi da
igreja, é só abrir `http://IP_DO_NOTEBOOK:3000/telao.html` (descubra o IP do
notebook nas configurações de rede do sistema operacional).

## 6. O que o servidor já resolve sozinho

- **Sessão de 10 minutos do Gemini**: o servidor escuta o aviso `GoAway` que o
  Gemini manda antes de fechar a conexão, e troca de sessão sozinho usando
  "session resumption" — a legenda não trava nem reinicia visivelmente nesse
  momento.
- **Pausas longas do pastor**: o áudio continua sendo enviado o tempo todo
  (inclusive silêncio), então não existe nenhum "timeout de silêncio" que
  precise ser tratado à parte — quando ele volta a falar, a legenda aparece no
  próximo ciclo de rede, sem nenhuma reconexão manual.
- **Falha silenciosa**: existe um relato conhecido de sessões do
  `gemini-3.5-transcribe-live` que ficam conectadas mas param de devolver
  texto, sem nenhum aviso. O servidor tem um "watchdog": se detectar volume de
  fala no microfone mas nenhuma transcrição chegar por 20 segundos (ajustável
  no `.env`), ele força uma reconexão sozinho.
- **Quedas de rede comuns**: se a conexão cair por qualquer outro motivo, o
  servidor reconecta automaticamente.

## 7. Solução de problemas

- **"defina GEMINI_API_KEY" ao rodar `npm start`** → você esqueceu de criar o
  `.env` ou de colar a chave nele.
- **Legenda não aparece nunca** → confira se escolheu o dispositivo de áudio
  certo em `captura.html` (não o microfone do notebook) e se o medidor de
  volume na página se move quando alguém fala perto do microfone.
- **Legenda aparece errada/picotada** → confira se o nível de saída da mesa
  não está estourando (clipping); ajuste o fader do canal ou da aux dedicada.
- **Erro 403 ao conectar no Gemini** → a chave de API está errada, expirou, ou
  a conta não tem acesso ao modelo `gemini-3.5-transcribe-live` ainda.

## 8. Se um dia precisar de acesso de fora da igreja

Esse projeto foi pensado pra rodar **localmente**, de propósito: o áudio já
nasce na mesma máquina ligada na mesa, e assim a conexão que carrega a legenda
não tem nenhum limite de tempo imposto por uma plataforma de hospedagem
(diferente de funções serverless, como as do Vercel, que fecham conexões
WebSocket de longa duração antes dos 50 minutos de uma pregação).

Se no futuro quiserem que pessoas fora da rede da igreja também acompanhem
(por exemplo, numa transmissão ao vivo), o jeito certo é colocar este mesmo
`server.js` rodando num serviço com **processo persistente** — não serverless
— como Railway (worker service), Fly.io, ou uma VPS simples (Hetzner,
DigitalOcean). Isso mantém a mesma garantia de "nunca parar" que você tem
rodando local hoje.

## 9. Nota sobre a API do Gemini

Os nomes de campo usados aqui (`goAway`, `sessionResumption`,
`interimInputTranscription`, `inputTranscription`, etc.) foram confirmados na
documentação oficial do Google em setembro de 2026. É uma API relativamente
nova e pode mudar com o tempo. Se algo parar de funcionar do nada, vale
conferir a documentação atualizada:

- https://ai.google.dev/gemini-api/docs/live-api/live-transcribe
- https://ai.google.dev/gemini-api/docs/live-session
