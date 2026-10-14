# MyScreen para Windows

App de desktop do MyScreen (Electron + React + LiveKit), implementado a partir de
[APP-WINDOWS.md](APP-WINDOWS.md). Entra nas **mesmas salas** do site, pelo mesmo link, e usa o
mesmo servidor Ubuntu. O que ele faz que o navegador não faz:

- **Som do sistema sem eco**: a voz da chamada (tocada pelo próprio app) fica fora da captura.
- **Só o som da janela escolhida** (loopback por processo do WASAPI).
- **Fone 7.1/surround funcionando** (o Chrome falha com `NotReadableError`).
- Seletor próprio de telas e janelas, janelas do MyScreen escondidas da captura, barra
  "Compartilhando · Parar", 60 FPS com a janela minimizada, sem dormir durante a transmissão.
- Deep link `myscreen://room/<id>`, bandeja, atalhos globais, botões na miniatura da barra de
  tarefas, notificação de chat, salas recentes e atualização automática pelo próprio servidor.

## Estrutura

```
src/main/       processo principal: janelas, protocolo app://, permissões, captura, API, updater
src/preload/    a ponte window.myscreen (contextBridge, funções estreitas)
src/audio/      utility process "audio": carrega o addon e manda PCM por MessagePort
src/renderer/   React: home, lobby, sala, seletor de captura, barra "Compartilhando"
src/shared/     tipos do IPC e lógica pura (ids de sala, deep link, bitrate, grade, ícones)
native/         addon Rust (napi-rs) — loopback por processo, AGC, limitador, downmix
server/         o que entra no servidor (rota /downloads/ do Caddy, rota opcional do site)
tests/          Vitest (lógica) e tests/e2e/smoke.mjs (Playwright no Electron)
```

O som do PC percorre: `addon (WASAPI) → utility process → MessagePort → AudioWorklet →
MediaStreamDestination → track ScreenShareAudio` — sem passar pelo thread de interface. Pacotes de
10 ms em s16 estéreo 48 kHz, o mesmo formato do MyScreen Áudio.

## Requisitos

- Windows 10 2004+ (o som por processo precisa do build 19041)
- Node 22+ e Rust stable (`x86_64-pc-windows-msvc`)

## Comandos

```bash
npm install
npm run build:native   # compila o addon → native/myscreen-native.node
npm run dev            # Vite + Electron com recarga
npm run check          # tipos + Vitest + cargo test
npm run build && npm run test:e2e   # ponta a ponta no app real (não toca o servidor)
npm run dist           # instalador → release/MyScreen-Setup-<versão>.exe
npm run publish:desktop  # dist + envio por SSH (ver server/README.md)
```

O servidor padrão vem de `MYSCREEN_SERVER_URL` no build (padrão `https://myscreen.haumea.fun`) e
pode ser trocado em **Configurações → Servidor** (https, ou http só para localhost).

## Segurança

`contextIsolation`, `sandbox`, sem `nodeIntegration`; renderer servido por `app://myscreen` com
CSP por cabeçalho e proteção contra path traversal; permissões só para a origem do app; navegação
bloqueada e links externos só para o servidor configurado; todo IPC valida remetente e tipos;
senha de sala só na memória; fuses do Electron (`RunAsNode`, `NODE_OPTIONS` e `--inspect`
desligados, integridade do asar ligada).

## Pendências conhecidas

- **Assinatura de código**: sem certificado o SmartScreen avisa na primeira execução. Com um
  certificado (Azure Trusted Signing ou OV), configure `win.signtoolOptions` e `publisherName`.
- **H.264 por hardware** (fase 4 do plano): a fase 1 usa o codec padrão do site (VP8) para paridade.
- A matriz manual da seção 16.2 (fone 7.1, HDR, 4G/TURN, chamada de 7 h) precisa de hardware e
  rede reais.
