# MyScreen para Windows — plano de recriação como app de desktop

> Documento de especificação para recriar o MyScreen (hoje um site Next.js) como um
> **aplicativo nativo de Windows**, com paridade total de transmissão de tela, áudio do
> sistema e câmera, usando **o mesmo servidor Ubuntu (acessado por SSH)** que já roda
> Caddy + LiveKit SFU + Next.js.
>
> Público: quem vai implementar. Tudo aqui foi derivado do código atual do repositório
> (commit `d4ce9cb`). Onde há decisão nova, ela vem com o porquê.

---

## 0. Resumo da decisão

| Pergunta | Resposta |
| :--- | :--- |
| **Stack do app** | **Electron + Vite + React 19 + TypeScript + Tailwind v4**, com o SDK `livekit-client` igual ao do site. |
| **Áudio do sistema** | Módulo **nativo em Rust** (napi-rs) reaproveitando o código do `companion/` (loopback por processo do WASAPI), rodando num `utilityProcess`. |
| **Captura de tela** | `desktopCapturer` + `session.setDisplayMediaRequestHandler` com **seletor próprio** (miniaturas de telas e janelas). |
| **Câmera / microfone** | `getUserMedia` do Chromium, com permissões concedidas pelo processo principal. |
| **Servidor** | O **mesmo** Ubuntu. Nenhuma porta nova. Muda pouco: uma rota `/downloads/` no Caddy para o instalador e o auto-update, e dois links no site. |
| **Interoperabilidade** | App e navegador entram **na mesma sala**, com o mesmo chat, as mesmas fontes de track e o mesmo link de convite. |
| **Distribuição** | Instalador NSIS por usuário (sem admin) + `electron-updater` lendo `https://SEU_DOMINIO/downloads/latest.yml`, publicado por `scp` via SSH. |

Por que não Tauri nem nativo puro, na seção 3.

---

## 1. O que existe hoje (inventário)

### 1.1 Servidor (Ubuntu, Docker Compose)

| Serviço | Papel | Observações que o app precisa respeitar |
| :--- | :--- | :--- |
| **Caddy** | TLS automático, proxy de `/rtc*` → LiveKit `7880` e de `/*` → Next.js `3000` | `request_body max_size 16KB`; `Permissions-Policy` libera câmera, microfone e captura de tela. |
| **LiveKit SFU** | Mídia WebRTC, com **TURN embutido** (3478 udp/tcp, 5349 TLS, relay 61000-62000/udp) | Portas de mídia: 50000-60000/udp. `7880`/`7881` **não** ficam publicadas. |
| **Next.js (app)** | Site + API | SQLite em `/app/data` via Prisma; `/api/health` faz o healthcheck. |
| **migrate** | `prisma db push` one-shot antes do app | — |

Dois modos de deploy convivem no repositório:

- `docker-compose.yml` + `deploy.sh`: VPS dedicado, o Caddy do compose é dono da borda (80/443).
- `docker-compose.prod.yml`: host com **Caddy do sistema + Cloudflare Tunnel** já existentes
  (produção atual, `myscreen.haumea.fun`). O app escuta em `127.0.0.1:3055` e o LiveKit roda
  em `network_mode: host` com `--node-ip` público.

**O app de desktop funciona com os dois modos sem mudança de porta.** A sinalização vai por
`wss://DOMINIO/rtc` (passa pelo Caddy/tunnel) e a mídia vai direto ao SFU por UDP, ou pelo TURN.

### 1.2 API HTTP (contrato que o app vai consumir)

| Rota | Entrada | Saída | Limites |
| :--- | :--- | :--- | :--- |
| `POST /api/rooms` | `{ title: string (≤120), password?: string (≤72 bytes), customId?: string (≤32, [a-zA-Z0-9-]) }` | `{ success, room: { id, title, isLocked, createdAt } }` | 20/h por IP; 409 se `customId` em uso |
| `GET /api/rooms/:id` | — | `{ exists: boolean, room: { id, title, isLocked, createdAt? } }` | 120/min por IP. Sala inexistente = sala efêmera válida |
| `POST /api/livekit/token` | `{ roomId, nickname (≤64), password?, participantIdentity? }` | `{ token, livekitUrl, participantIdentity, participantName }` | 30/15min por IP. 401 com senha errada/ausente |
| `GET /api/health` | — | `{ ok, db, dbLatencyMs, at }` ou 503 | — |

Erros vêm como `{ error: string, field: string \| null }`. 429 traz `Retry-After: 900`.

Regras importantes do token:

- A identidade é **estável**: `<apelido sanitizado>-<8 hex>`. O cliente reenvia
  `participantIdentity` ao renovar e o servidor só a aceita se casar com o apelido. Sem isso o
  participante aparece **duplicado** depois de reconectar.
- TTL de 6 h; o cliente renova **a cada 10 min** e injeta o token novo em `room.engine.token`
  (API privada do SDK, já usada hoje).
- Sala trancada pede senha **de todo mundo**, inclusive de quem criou.

### 1.3 Cliente web (o que precisa ser reproduzido)

| Arquivo | Função |
| :--- | :--- |
| `src/app/page.tsx` | Home: **Criar sala** (nome + senha opcionais) e **Entrar** (código ou link colado). |
| `src/app/room/[id]/page.tsx` | Busca a sala, mostra o lobby, pede o token, renova a cada 10 min, monta a sala. |
| `GreenRoom.tsx` | Lobby: preview da câmera, VU meter (AnalyserNode, 10 Hz), escolha de mic e câmera, apelido, senha. |
| `ConferenceRoom.tsx` | A sala (1.900 linhas): palco, grade, destaque, divisão lado a lado, faixa lateral, janelas separadas, tela cheia, PiP, doca recolhível, avisos, compartilhamento de tela com fallback de áudio. |
| `ShareDialog.tsx` + `CaptureRuler.tsx` | Diálogo de compartilhar: resolução (720p/1080p/4K), FPS (15/30/60), conteúdo (Texto=`detail` / Vídeo e jogos=`motion`), fonte do som (Navegador / App / Sem som). |
| `SettingsModal.tsx` | AEC, supressão de ruído e AGC **aplicados na track viva** (`applyConstraints`); troca de mic, câmera e saída (`switchActiveDevice`). |
| `MediaControls.tsx` | Doca: mic, câmera, compartilhar, tela cheia, configurações, sair. |
| `ChatSidebar.tsx` | Chat via `useChat` do `@livekit/components-react`; o histórico e o rascunho sobrevivem a fechar o painel. |
| `ParticipantsList.tsx` | Lista com estado de mic/câmera e quem está falando. |
| `TrackStatsDropdown.tsx` | Estatísticas honestas: FPS, resolução, bitrate (delta), RTT, jitter, codec, perda, qualidade, quadros descartados, PLI/NACK/FIR, decoder. Sem medida → `n/d` ou `--`. |
| `companionAudio.ts` | Ponte WebSocket com o MyScreen Áudio: PCM s16 estéreo 48 kHz, 10 ms por mensagem → AudioWorklet (buffer de ~50 ms, teto de ~200 ms) → track publicada como `ScreenShareAudio`. |
| `capturePrefs.ts` | Última escolha de captura no `localStorage`, validada campo a campo. |

Chaves de `localStorage` em uso: `myscreen:nickname`, `myscreen:capture`, `myscreen:companion`,
`myscreen:dock-hidden`, `myscreen:screen-volume`, `myscreen-theme`.

### 1.4 MyScreen Áudio (`companion/`, Rust)

App de bandeja que existe porque **o Chrome no Windows falha com `NotReadableError` ao
capturar o som do sistema quando a saída tem mais de 2 canais** (fone 7.1). Ele:

- usa o **loopback por processo** do WASAPI (`new_application_loopback_client(pid, include_tree)`);
- exclui por padrão a árvore do `chrome.exe` (sem isso, a voz dos outros participantes que o
  Chrome toca volta para a sala como eco) e, opcionalmente, o Discord;
- como o modo *exclude* aceita **uma** árvore só, usa a estratégia "mista": abre um loopback
  *include* por processo que toca som e soma tudo (`capture_mixed`);
- normaliza o volume (RMS alvo de −16 dBFS, ataque de 80 ms, release de 1,5 s, segura o ganho
  no silêncio) e aplica um limitador suave (joelho em 0,8);
- serve PCM por `ws://127.0.0.1:47810/?code=XXXX-XXXX`, só para origens permitidas.

**No app de desktop esse código vira biblioteca**, e a ponte por WebSocket deixa de existir
(seção 9). O `companion/` continua existindo para quem usa o site no Chrome.

---

## 2. Objetivos e não-objetivos

### Objetivos

1. **Paridade total** com a sala web: tudo da tabela 1.3 funciona no app.
2. **Compatibilidade completa de captura**:
   - tela inteira (qualquer monitor) e janela, a 15/30/60 FPS em 720p/1080p/4K;
   - som do sistema **sempre**, inclusive com fone 7.1/surround, **sem eco** da própria chamada;
   - **som só da janela escolhida** (impossível no navegador);
   - câmera e microfone **simultâneos** com a tela.
3. **Interoperabilidade**: um participante no app e outro no Chrome veem, ouvem e conversam
   na mesma sala, pelo mesmo link.
4. **Zero mudança na infraestrutura de mídia**: mesmo LiveKit, mesmas portas, mesmo TURN.
5. Instalação sem administrador e atualização automática servida pelo próprio servidor.

### Não-objetivos (fase 1)

- Contas e login (o produto não tem, por decisão: commit `6074fff`).
- Gravação (removida no mesmo commit).
- macOS e Linux. O Electron permite depois, mas o áudio nativo é específico do Windows.
- Trocar o SFU, o banco ou o modelo de segurança do servidor.

---

## 3. Por que Electron

| Opção | Prós | Contras | Veredito |
| :--- | :--- | :--- | :--- |
| **Electron** | Chromium inteiro: o **mesmo WebRTC** e o mesmo `livekit-client` do site, então a interop é garantida. `desktopCapturer` e `setDisplayMediaRequestHandler` dão seletor próprio. Reaproveita ~80% do React/Tailwind atual. | Instalador de ~100 MB e RAM maior. | **Escolhido.** |
| Tauri (WebView2) | Instalador de ~10 MB e menos RAM; backend em Rust (o `companion/` entraria quase direto); plugins prontos de updater, deep link e atalhos. | O `ScreenCaptureStarting` do WebView2 só **cancela ou adia** o `getDisplayMedia`: a fonte sempre sai do seletor do Edge, então não há seletor próprio e o app não sabe **qual janela** foi escolhida (o "som só desta janela" vira gambiarra pelo `track.label`). O runtime evergreen muda o motor WebRTC em cada máquina sem release nossa; fixar a versão leva o instalador a ~180 MB. Permissões, autoplay e throttling exigem código específico do WebView2. | Viável, mas rejeitado: perde o controle da captura, que é o que o produto vende. Seria a escolha se o tamanho do app pesasse mais que esse controle. |
| Nativo (C#/Rust + LiveKit Rust SDK) | Máximo controle e desempenho (WGC + encoder de hardware direto). | Reescrever **toda** a UI, o chat, as estatísticas e o layout; interop do chat precisa ser reimplementada. Meses a mais. | Fica para o futuro, se o Electron bater no teto de desempenho. |

O que o produto vende é a captura sair nítida e com som (`PRODUCT.md`). O Electron entrega isso
com o mesmo motor WebRTC já validado no site, e o Rust entra só onde o Chromium falha (o áudio).

---

## 4. Arquitetura

```
┌──────────────────────────── MyScreen.exe (Electron) ─────────────────────────────┐
│                                                                                  │
│  MAIN PROCESS (Node)                                                             │
│   ├─ janelas (principal, pop-outs, barra "Parar compartilhamento")               │
│   ├─ protocolo app://myscreen  → serve o renderer empacotado                     │
│   ├─ desktopCapturer + setDisplayMediaRequestHandler  (seletor próprio)          │
│   ├─ permissões (media, display-capture, fullscreen…) só para app://myscreen     │
│   ├─ ponte HTTP com o servidor (net.fetch → https://DOMINIO/api/…)               │
│   ├─ deep link myscreen://room/<id>, single-instance, tray, atalhos globais      │
│   ├─ powerSaveBlocker durante a transmissão, electron-updater                    │
│   └─ MessageChannelMain ─────────────┐                                           │
│                                      │ porta PCM (s16, estéreo, 48 kHz, 10 ms)   │
│  UTILITY PROCESS "audio"             ▼                                           │
│   └─ addon nativo Rust (napi-rs) ── WASAPI loopback por processo                 │
│        (exclui a árvore do MyScreen; ou inclui só o PID da janela escolhida)     │
│                                      │                                           │
│  RENDERER (React + livekit-client)   ▼                                           │
│   ├─ Home, Lobby, Sala (portados do site)                                        │
│   ├─ AudioWorklet "myscreen-pcm" recebe a porta direto no thread de áudio        │
│   │     └─ MediaStreamDestination → track publicada como ScreenShareAudio        │
│   ├─ getDisplayMedia (vídeo da tela) → ScreenShare                               │
│   └─ getUserMedia (câmera, mic) → Camera, Microphone                             │
└───────────────────────────────┬──────────────────────────────────────────────────┘
                                │ HTTPS (API)  +  WSS /rtc (sinalização)
                                │ UDP 50000-60000 (mídia) / TURN 3478, 5349
                                ▼
┌──────────────────────── Servidor Ubuntu (SSH) ────────────────────────┐
│  Caddy ── /api/*, /room/*  → Next.js (SQLite)                          │
│        ── /rtc*            → LiveKit SFU (+ TURN embutido)             │
│        ── /downloads/*     → instalador + latest.yml   ← NOVO          │
└────────────────────────────────────────────────────────────────────────┘
```

Fluxo de um compartilhamento (o mesmo caminho "via app" que o site já tem, sem o WebSocket):

1. A pessoa abre o seletor do app e escolhe a fonte (tela ou janela), a régua e o som.
2. O renderer chama `capture:select(sourceId)` e em seguida
   `localParticipant.setScreenShareEnabled(true, { audio: false, … })`.
3. O `getDisplayMedia` cai no `setDisplayMediaRequestHandler`, que devolve a fonte escolhida.
4. O renderer pede `audio:start({ mode, pid })`; o main cria um `MessageChannelMain`, entrega
   uma ponta ao utility process e a outra ao renderer.
5. O worklet toca o PCM numa `MediaStreamDestination`; a track é publicada como
   `Track.Source.ScreenShareAudio` com `musicHighQualityStereo`, `forceStereo`, sem DTX e sem RED.
6. Ao parar a tela, por qualquer caminho, o áudio para junto (como hoje em `stopCompanion`).

---

## 5. Servidor Ubuntu: o que muda e o que não muda

### 5.1 Não muda

- `livekit.yaml`, portas, UFW, TURN, `deploy.sh` (exceto o passo 5.4), o banco, `src/lib/*` e
  as rotas de API. O app é só mais um cliente.
- O rate limit por IP continua valendo (o Caddy reescreve `X-Forwarded-For`).

### 5.2 Rota de downloads e atualização (Caddy)

**Modo VPS dedicado** (`Caddyfile` do repositório), antes do `handle` final:

```caddy
	# Instalador do app de Windows e feed do electron-updater.
	handle_path /downloads/* {
		root * /srv/releases
		# O feed precisa estar sempre fresco; o .exe e versionado no nome.
		@feed path *.yml
		header @feed Cache-Control "no-cache"
		file_server
	}
```

E no `docker-compose.yml`, no serviço `caddy`:

```yaml
    volumes:
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
      - ./releases:/srv/releases:ro
```

**Modo produção atual** (`docker-compose.prod.yml`, Caddy do sistema + Cloudflare Tunnel):
o mesmo bloco `handle_path` entra no Caddyfile **do host**, com `root` apontando para um
diretório do host (ex.: `/opt/myscreen/releases`). Atrás do Cloudflare, o `Cache-Control:
no-cache` no `latest.yml` é obrigatório: sem ele, o Cloudflare pode servir o feed antigo e o
auto-update não enxerga a versão nova.

### 5.3 Mudanças no site (Next.js)

| Onde | Mudança |
| :--- | :--- |
| `src/app/page.tsx` | Link "Baixar o app para Windows" → `/downloads/MyScreen-Setup-latest.exe` (cópia estável do último instalador, feita pelo script de publicação). |
| `src/app/room/[id]/page.tsx` | Botão "Abrir no app" → `myscreen://room/<id>`. Fica discreto: quem não tem o app vê o erro do navegador. |
| `ShareDialog.tsx` | Mantém o modo "App" (MyScreen Áudio) para o navegador. Opcional: sugerir o app de desktop como alternativa. |
| (opcional) `src/app/api/desktop/route.ts` | `GET` devolve `{ minVersion }` lido de env `DESKTOP_MIN_VERSION`. O app bloqueia a entrada e pede atualização se estiver abaixo. Só é necessário quando houver mudança incompatível de protocolo. |

O link de convite **continua sendo a URL web** (`https://DOMINIO/room/<id>`): ela funciona para
todo mundo, e quem tem o app clica em "Abrir no app".

### 5.4 Diretório de releases e publicação por SSH

No servidor (uma vez):

```bash
sudo mkdir -p /opt/myscreen/releases
sudo chown "$USER":"$USER" /opt/myscreen/releases
```

No VPS dedicado, o `releases/` fica dentro do clone (`./releases`, montado no Caddy) e entra no
`.gitignore` e no `.dockerignore`. O `deploy.sh` ganha só um `mkdir -p releases`.

Na máquina Windows de build, com `~/.ssh/config` apontando o host `myscreen`:

```powershell
# scripts/publish-desktop.ps1
param(
  [string]$SshHost = "myscreen",
  [string]$RemoteDir = "/opt/myscreen/releases"
)
$ErrorActionPreference = "Stop"

npm --prefix desktop run dist
$ver = (Get-Content desktop/package.json | ConvertFrom-Json).version
$out = "desktop/release"
$exe = "MyScreen-Setup-$ver.exe"

# Binarios primeiro, feed por ultimo: um cliente que le o latest.yml novo
# precisa encontrar o .exe que ele aponta.
scp "$out/$exe" "$out/$exe.blockmap" "${SshHost}:$RemoteDir/"
scp "$out/latest.yml" "${SshHost}:$RemoteDir/latest.yml.tmp"
ssh $SshHost "cd $RemoteDir && cp $exe MyScreen-Setup-latest.exe && mv latest.yml.tmp latest.yml"
```

O `mv` no fim é atômico: nenhum cliente lê um `latest.yml` pela metade.

---

## 6. Estrutura do repositório

O site continua na raiz (o `Dockerfile` e o compose não mudam de caminho). O app entra em
`desktop/`, e o código de UI compartilhado sai do Next para `shared/`.

```
MyScreen/
├─ src/                      # site Next.js (inalterado, passa a importar de shared/)
├─ shared/                   # React puro, sem next/* — usado pelo site E pelo app
│  ├─ conference/            # ConferenceRoom, GreenRoom, ShareDialog, Settings, Chat, Stats…
│  ├─ sheet/                 # componentes da folha (Sheet, Field, Choice, CheckCell, Stamp)
│  ├─ capture/               # capturePrefs, bitrate, resoluções
│  ├─ platform.ts            # interface Platform (ver 6.1)
│  └─ styles/globals.css     # tokens de cor, tema claro/escuro
├─ companion/                # MyScreen Áudio (continua, para usuários do navegador)
├─ desktop/
│  ├─ package.json           # electron, electron-builder, electron-updater, vite
│  ├─ electron-builder.yml
│  ├─ vite.config.ts         # renderer (React + @tailwindcss/vite)
│  ├─ src/main/              # index.ts, capture.ts, permissions.ts, server.ts, audio.ts,
│  │                         # windows.ts, deeplink.ts, updater.ts, tray.ts
│  ├─ src/preload/index.ts   # contextBridge → window.myscreen
│  ├─ src/renderer/          # main.tsx, rotas (Home, Room), DesktopPlatform, ShareSourcePicker
│  └─ native/                # crate napi-rs: loopback, AGC, downmix (de companion/src/main.rs)
└─ scripts/publish-desktop.ps1
```

Ajustes para o compartilhamento funcionar:

- `next.config.ts`: `experimental.externalDir: true` (importar de `../shared`).
- `tsconfig.json` (site e desktop): alias `@shared/*` → `shared/*`.
- `.dockerignore`: acrescentar `desktop/`, `companion/` e `releases/` (o build da imagem não
  precisa deles).
- Ninguém em `shared/` importa `next/*`. Hoje a sala usa `useRouter` e `useParams`; essas
  chamadas viram props/callbacks (`onLeave`, `roomId`) ou métodos de `Platform`.

### 6.1 A interface `Platform`

Tudo que difere entre navegador e desktop passa por uma interface injetada por contexto React.
O site implementa com as APIs do navegador; o app, com `window.myscreen`.

```ts
// shared/platform.ts
export interface CaptureSource {
  id: string;               // "screen:0:0" | "window:<HWND>:0"
  kind: "screen" | "window";
  name: string;
  thumbnail: string;        // data URL
  appIcon: string | null;
  displayId: string | null; // casa com screen.getAllDisplays() no main
}

export type SystemAudioMode =
  | { kind: "off" }
  | { kind: "system-except-self"; alsoExclude?: ("discord")[] } // tela inteira
  | { kind: "window-only"; sourceId: string };                  // só o processo da janela

export interface Platform {
  kind: "web" | "desktop";
  api: {
    createRoom(input: { title: string; password?: string }): Promise<{ id: string }>;
    getRoom(id: string): Promise<{ title: string; isLocked: boolean }>;
    token(input: {
      roomId: string; nickname: string; password?: string; participantIdentity?: string;
    }): Promise<{ token: string; livekitUrl: string; participantIdentity: string }>;
  };
  /** Desktop: lista fontes para o seletor próprio. Web: undefined (o navegador mostra o dele). */
  listCaptureSources?(): Promise<CaptureSource[]>;
  selectCaptureSource?(id: string): Promise<void>;
  /** Abre o som do PC como MediaStreamTrack. Web: companion WebSocket; desktop: nativo. */
  openSystemAudio?(mode: SystemAudioMode, onLost: () => void): Promise<{ track: MediaStreamTrack; close(): void }>;
  openPopout(trackRef: unknown, label: string): void;
  setSharingActive(active: boolean): void; // desktop: powerSaveBlocker, barra flutuante
  inviteUrl(roomId: string): string;       // sempre a URL web
  navigate(to: "home" | { room: string }): void;
}
```

---

## 7. Cliente HTTP do app

O renderer **não** faz `fetch` direto para o servidor. As chamadas passam pelo processo
principal (`ipcMain.handle("api:*")` → `net.fetch`). Motivos:

- a origem do renderer é `app://myscreen`, e o Next não manda CORS; pelo main não existe CORS;
- a URL do servidor fica em um lugar só (configurável em Configurações → Servidor, padrão
  definido no build por `MYSCREEN_SERVER_URL`);
- dá para validar a resposta e padronizar os erros (`{ error, field }`) antes do React.

Regras herdadas do site:

- `roomId` normalizado: `trim().toLowerCase()`; ao colar um link, extrair o que vem depois
  de `/room/` e cortar em `?` ou `#` (igual a `handleJoin` da home).
- Título padrão da sala criada: `"Reunião instantânea"`.
- Renovação do token a cada **10 min**, reenviando `participantIdentity` e a senha usada no join,
  e atribuindo o token novo a `room.engine.token`.
- Erro 429: mostrar a mensagem do servidor, sem tentar de novo sozinho.

---

## 8. Captura de tela

### 8.1 Seletor próprio

O seletor do app substitui o do navegador **e** o diálogo atual: é o `ShareDialog` com uma
coluna nova de fontes.

```
┌ Compartilhar tela ─────────────────────────────────────────────────┐
│ [ Telas ] [ Janelas ]                                              │
│ ┌──────┐ ┌──────┐ ┌──────┐                                         │
│ │ mon 1│ │ mon 2│ │ VS   │   miniaturas 320×180, atualizadas a     │
│ └──────┘ └──────┘ └──────┘   cada 3 s enquanto o diálogo está aberto│
├────────────────────────────────────────────────────────────────────┤
│ Resolução 720p · 1080p · 4K   FPS 15 · 30 · 60   Texto · Vídeo/jogos│  ← CaptureRuler
├────────────────────────────────────────────────────────────────────┤
│ Som do PC:  ( ) Sistema inteiro, exceto o MyScreen                 │
│             ( ) Só esta janela          ← só aparece com janela    │
│             ( ) Sem som                                            │
│ [x] Esconder as janelas do MyScreen da captura                     │
├────────────────────────────────────────────────────────────────────┤
│                                   [Cancelar]  [Compartilhar]       │
└────────────────────────────────────────────────────────────────────┘
```

- **Telas** primeiro, com o nome do monitor e a resolução (de `screen.getAllDisplays()`,
  casado por `display_id`).
- **Janelas** com o ícone do app (`fetchWindowIcons: true`). Janelas do próprio MyScreen não
  aparecem na lista.
- Padrões: a última escolha (`myscreen:capture`), como hoje.

### 8.2 Processo principal

```ts
// desktop/src/main/capture.ts
import { desktopCapturer, ipcMain, session } from "electron";
import { assertAppSender } from "./security";

let chosen: string | null = null;

ipcMain.handle("capture:list", async (event) => {
  assertAppSender(event);
  const sources = await desktopCapturer.getSources({
    types: ["screen", "window"],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return sources
    .filter((s) => !isOwnWindow(s.id))
    .map((s) => ({
      id: s.id,
      kind: s.id.startsWith("screen:") ? "screen" : "window",
      name: s.name,
      thumbnail: s.thumbnail.toDataURL(),
      appIcon: s.appIcon?.toDataURL() ?? null,
      displayId: s.display_id || null,
    }));
});

ipcMain.handle("capture:select", (event, sourceId: unknown) => {
  assertAppSender(event);
  if (typeof sourceId !== "string") throw new Error("fonte invalida");
  chosen = sourceId;
});

export function installDisplayMediaHandler() {
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    const id = chosen;
    chosen = null; // uma escolha vale para um getDisplayMedia so
    // Miniatura 0x0: aqui so importa o id, e gerar thumbnail de todas as
    // janelas atrasaria o inicio da captura.
    const sources = id
      ? await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 0, height: 0 } })
      : [];
    const source = sources.find((s) => s.id === id);
    // Sem fonte escolhida o pedido e negado. O audio NUNCA vem daqui: ele sai
    // do modulo nativo, que sabe excluir o proprio MyScreen.
    callback(source ? { video: source } : {});
  });
}
```

### 8.3 Renderer (mudança mínima no `toggleScreenShare` atual)

O caminho é exatamente o "via app" que já existe em `ConferenceRoom.tsx`:

```ts
await platform.selectCaptureSource!(source.id);
await localParticipant.setScreenShareEnabled(
  true,
  {
    audio: false,                      // o som vem do nativo
    contentHint,                       // "detail" | "motion"
    resolution: { width, height, frameRate: fps },
  },
  {
    screenShareEncoding: { maxBitrate: screenBitrate(res, fps), maxFramerate: fps, priority: "high" },
    simulcast: false,
    degradationPreference: contentHint === "detail" ? "maintain-resolution" : "maintain-framerate",
  },
);
if (audioMode.kind !== "off") {
  const audio = await platform.openSystemAudio!(audioMode, onAudioLost);
  await localParticipant.publishTrack(audio.track, {
    source: Track.Source.ScreenShareAudio,
    name: "screen_share_audio",
    audioPreset: AudioPresets.musicHighQualityStereo,
    forceStereo: true,
    dtx: false,
    red: false,
  });
}
platform.setSharingActive(true);
```

O `getDisplayMedia` do Chromium exige **ativação transitória** (gesto do usuário). O
`await selectCaptureSource` é um IPC de milissegundos, dentro da janela de ativação. Se alguma
versão do Electron recusar, o plano B é a constraint legada, que não exige gesto:
`getUserMedia({ video: { mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId, maxWidth, maxHeight, maxFrameRate } } })`,
publicando com `publishTrack(new LocalVideoTrack(track), { source: Track.Source.ScreenShare, … })`.

### 8.4 Qualidade de captura

- **Orçamento de bits** (igual ao site, `SCREEN_BITRATE`): 720p 3,5 Mbps · 1080p 6 Mbps ·
  4K 14 Mbps a 30 FPS; ×1,5 a 60 FPS; ×0,6 a 15 FPS.
- **Uma camada só** (`simulcast: false`): quem assiste recebe sempre a tela inteira.
- **`contentHint`**: "Texto" = `detail` (segura a resolução, cai a taxa); "Vídeo e jogos" =
  `motion` (segura a taxa, cai a resolução). Manter o texto explicativo do site.
- **Captador do Windows**: o Chromium usa o Windows Graphics Capture (WGC) quando está
  disponível. É o que permite 60 FPS estáveis e captura de janela por trás de outras. Validar na
  versão do Electron escolhida (`chrome://gpu` numa janela de debug) e, se preciso, ligar as
  features do WGC por `app.commandLine.appendSwitch("enable-features", …)`.
- **Codec**: na fase 1, o padrão do site (VP8), para paridade. Na fase de otimização, medir
  **H.264** (encoder de hardware via Media Foundation) para 1080p60 e 4K, comparando CPU e
  quadros descartados no painel de estatísticas. Os navegadores atuais decodificam H.264.
- **Tela HDR**: o WGC pode entregar cores lavadas em monitores com HDR ligado. Documentar e
  testar (seção 14).
- **Conteúdo com DRM** (Netflix, Prime) sai preto. É do sistema, não do app: avisar na ajuda.

### 8.5 Esconder o próprio MyScreen da captura

Com "Tela inteira", a janela da sala aparece dentro da própria tela transmitida (efeito
espelho infinito). Opção no seletor (ligada por padrão):
`BrowserWindow.setContentProtection(true)` em **todas** as janelas do app enquanto a
transmissão durar. No Windows 10 2004+ isso usa `WDA_EXCLUDEFROMCAPTURE`: a janela some da
captura mas continua visível para quem está na máquina.

### 8.6 Barra "Você está compartilhando"

Janela pequena, sempre no topo, sem moldura, com content protection, centrada no topo do monitor
capturado: `● Compartilhando "Monitor 1" · [Pausar som] [Parar]`. Faz o papel da barra do Chrome,
que o app não tem.

---

## 9. Áudio do sistema (módulo nativo)

### 9.1 Por que nativo, e não `audio: "loopback"` do Electron

O `setDisplayMediaRequestHandler` aceita `audio: "loopback"`, mas é o **mesmo loopback do
Chromium** que:

1. falha com saída de mais de 2 canais (o motivo de o `companion/` existir);
2. captura **tudo**, inclusive a voz dos outros participantes que o próprio app toca, e
   devolve à sala como eco;
3. não sabe capturar só uma janela.

O loopback por processo do WASAPI resolve os três: o Windows mistura em estéreo 48 kHz em
qualquer formato de saída, permite **excluir** a árvore do MyScreen e permite **incluir** só a
árvore de um processo.

`audio: "loopback"` fica só como **plano B**, quando o nativo não está disponível (Windows
antigo), e o app avisa a pessoa sobre o risco de eco.

### 9.2 Crate `desktop/native` (napi-rs)

Reaproveita do `companion/src/main.rs`: `Loopback` (open/pull/frames/mix_into), `downmix`,
`device_channels`, `root_pid`, `roots_named`, `capture_mixed`, `Agc`, `soft_limit`. Sai tudo
que é UI (eframe), bandeja, WebSocket, token de pareamento e registro do Windows.

API exposta ao JavaScript:

```ts
// tipos gerados pelo napi-rs
export function pidFromHwnd(hwnd: bigint): number;          // GetWindowThreadProcessId
export function isProcessLoopbackSupported(): boolean;       // checa a versão do Windows
export interface CaptureOptions {
  mode: "exclude" | "include";
  pids: number[];        // exclude: [pid do MyScreen, …Discord]; include: [pid da janela]
  normalize: boolean;    // AGC, padrão true
  gainPct: number;       // 0–400, padrão 100
}
export class SystemAudioCapture {
  constructor(options: CaptureOptions, onPcm: (pcm: Buffer) => void, onError: (msg: string) => void);
  setOptions(options: Partial<CaptureOptions>): void; // reinicia a captura (generation++)
  level(): number;                                    // pico para o medidor da UI
  stop(): void;
}
```

Saída: o mesmo formato do companion — **s16le, estéreo intercalado, 48 kHz, 480 quadros (10 ms,
1.920 bytes) por pacote**. Com o mesmo formato, o worklet do site serve sem mudança.

Regras herdadas do companion:

- **Exclusão de várias árvores** (MyScreen + Discord): o modo *exclude* do Windows aceita uma
  árvore só; usar a estratégia mista (`capture_mixed`), com um loopback *include* por processo
  que toca som.
- **Abrir um loopback pode levar segundos** (o WhatsApp levou 4,7 s): abrir em thread separada e
  somar quando ficar pronto, sem travar os outros.
- **Pacote atrasado é descartado** (`TrySendError::Full`), nunca acumulado: o som não pode ficar
  cada vez mais atrasado em relação à tela.

### 9.3 Qual PID excluir ou incluir

| Fonte escolhida | Modo de som | `CaptureOptions` |
| :--- | :--- | :--- |
| Tela | Sistema, exceto o MyScreen | `exclude`, `pids: [process.pid do main]` (a árvore cobre o renderer e o serviço de áudio do Chromium) |
| Tela | + ignorar o Discord | `exclude`, `pids: [main, …roots de discord*.exe]` → modo misto |
| Janela | Só esta janela | `include`, `pids: [root_pid(pidFromHwnd(hwnd))]` — o HWND sai do id `window:<HWND>:0` |
| Janela | Sistema, exceto o MyScreen | igual à tela |
| Qualquer | Sem som | não inicia captura |

A **raiz** da árvore importa: navegadores e o Discord tocam som num processo filho, então
incluir só o PID dono da janela não pega nada. O `root_pid` do companion sobe até o ancestral
de mesmo executável.

### 9.4 Caminho do PCM até o WebRTC (sem passar pelo thread de UI)

```
utilityProcess("audio")            main                        renderer
  SystemAudioCapture  ──port1──  MessageChannelMain  ──port2──  preload
       onPcm(buf) → port1.postMessage(buf)                        │ window.postMessage(…, [port2])
                                                                  ▼
                                                     AudioWorkletNode.port.postMessage({ port }, [port])
                                                                  ▼
                                                     worklet: port.onmessage = push PCM (thread de áudio)
```

```ts
// preload: a porta não atravessa o contextBridge; vai por postMessage para o mundo principal.
ipcRenderer.on("audio:port", (event) => {
  window.postMessage({ type: "myscreen:audio-port" }, "*", event.ports);
});

// renderer (DesktopPlatform.openSystemAudio)
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.type !== "myscreen:audio-port") return;
  const [port] = e.ports;
  node.port.postMessage({ type: "pcm-port", port }, [port]);
});
```

O worklet é o `WORKLET` de `companionAudio.ts` com uma adição: ao receber `{type:"pcm-port"}`,
liga `port.onmessage` direto no buffer circular. Mantém `TARGET = 2400` (50 ms),
`MAX = 9600` (200 ms) e o descarte do excesso.

### 9.5 Controles de som na sala

Durante a transmissão, a barra da seção 8.6 e o menu da doca mostram o medidor de nível
(`level()`), "Normalizar volume" (liga e desliga o AGC) e o volume enviado (0–400%), como no
companion. As escolhas ficam em `myscreen:system-audio`.

---

## 10. Câmera e microfone

- **Permissões**: o main concede `media` só para `app://myscreen` (seção 12). Não existe
  prompt do Chromium no app.
- **Privacidade do Windows**: se `getUserMedia` falhar com `NotAllowedError` mesmo com a
  permissão do app concedida, o bloqueio é do Windows (Configurações → Privacidade → Câmera /
  Microfone → "Permitir que aplicativos da área de trabalho…"). O aviso traz um botão que abre
  `ms-settings:privacy-webcam` ou `ms-settings:privacy-microphone` via `shell.openExternal`.
- **Câmera ocupada por outro app** (Teams, OBS): no Windows ela costuma dar `NotReadableError`.
  Mensagem específica: "A câmera está em uso por outro aplicativo".
- **Opções da sala** (iguais ao site): `videoCaptureDefaults.resolution = 1080p`; câmera
  publicada a até 3 Mbps / 30 FPS, prioridade alta, `maintain-resolution`; mic com AEC, NS e AGC
  ligados por padrão e alterados ao vivo com `applyConstraints`; trocas de dispositivo por
  `room.switchActiveDevice` (nunca `restartTrack`, que perde o `deviceId`).
- **Saída de áudio**: `setSinkId` funciona no Chromium do Electron; o seletor de alto-falante
  aparece sempre.
- **Lobby**: igual ao `GreenRoom` (preview, VU a 10 Hz com limiar 5, escolha de dispositivos).
  O `deviceId` só é enviado quando a permissão já liberou ids reais.
- **Tela + câmera ao mesmo tempo**: são tracks independentes (`ScreenShare` e `Camera`); nada
  muda em relação ao site. O palco mostra a tela em destaque e a câmera na faixa, com
  "lado a lado" disponível.

---

## 11. Paridade da sala: checklist web → desktop

| Funcionalidade (site) | No app | Observação |
| :--- | :--- | :--- |
| `LiveKitRoom` com `adaptiveStream: false`, `dynacast: true`, `webAudioMix: true`, `stopLocalTrackOnUnpublish: true` | igual | Mesmas `publishDefaults`. |
| Assinatura presa na camada `HIGH` (TrackSubscribed/TrackPublished) | igual | — |
| `RoomAudioRenderer` | igual | `autoplayPolicy: "no-user-gesture-required"` na janela: o aviso "o navegador bloqueou o áudio" não acontece mais, mas o código fica. |
| Palco: destaque, faixa lateral, grade 16:9 ótima, divisão lado a lado (`SplitStage`) | igual | Algoritmos de colunas copiados sem mudança. |
| Fixar, soltar, "lado a lado", desfazer divisão | igual | — |
| Tela cheia da chamada e de um quadro; cursor some após 2,5 s | igual | API Fullscreen do Chromium. |
| Janela separada (`window.open("")` + `mountPopout`) | **BrowserWindow** | `setWindowOpenHandler` permite `about:blank` com moldura nativa; o menu ganha "Sempre no topo" e "Mover para o monitor X". A trilha é a mesma, sem nova assinatura. |
| Janela flutuante (PiP) | igual + pop-out sempre no topo | — |
| Menu do botão direito no quadro | igual | — |
| Volume do som da tela por participante (`setVolume(v, ScreenShareAudio)`) | igual | Chave `myscreen:screen-volume`. |
| Doca recolhível (`myscreen:dock-hidden`) | igual | — |
| Avisos (tela sem áudio, erro de controle, conexão instável, mídia) | igual | Textos novos para os erros do nativo. |
| Banner de reconexão (`Reconnecting` / `SignalReconnecting`) | igual | — |
| Erro fatal com "Reconectar" / "Início" | igual | "Reconectar" recria a sala em vez de `location.reload()`. |
| Chat (`useChat`), não lidos, rascunho persistente | igual | **Mesma versão** de `@livekit/components-react` no site e no app: o protocolo de chat mudou entre versões (tópico legado `lk-chat-topic` × text streams `lk.chat`) e versões diferentes não conversam. |
| Lista de pessoas | igual | — |
| Estatísticas (`TrackStatsDropdown`) | igual | Mesmas regras: FPS por delta de `framesDecoded`, bitrate por delta de bytes, RTT só no transmissor, `n/d` para o que não foi medido. |
| Copiar convite | `platform.inviteUrl()` | Sempre a URL **web**. |
| Tema claro/escuro (`myscreen-theme`) | igual + "Seguir o Windows" | `nativeTheme.shouldUseDarkColors`. |
| Apelido lembrado (`myscreen:nickname`) | igual | — |

---

## 12. Exclusivo do desktop

| Recurso | Implementação | Prioridade |
| :--- | :--- | :--- |
| Som só da janela compartilhada | seção 9.3 | **Fase 2 (essencial)** |
| Sem eco do próprio app no som do sistema | seção 9.3 | **Fase 2 (essencial)** |
| Fone 7.1/surround funcionando | nativo | **Fase 2 (essencial)** |
| Esconder o MyScreen da captura | `setContentProtection` | Fase 2 |
| Barra "Compartilhando · Parar" | janela always-on-top | Fase 2 |
| Não dormir durante a transmissão | `powerSaveBlocker.start("prevent-display-sleep")` | Fase 2 |
| Continuar a 60 FPS minimizado | `backgroundThrottling: false` na janela da sala | Fase 2 |
| Deep link `myscreen://room/<id>` | `setAsDefaultProtocolClient` + `requestSingleInstanceLock` + `second-instance` | Fase 3 |
| Atalhos globais (mic: `Ctrl+Shift+M`, câmera: `Ctrl+Shift+V`, parar tela: `Ctrl+Shift+S`) | `globalShortcut`, configuráveis | Fase 3 |
| Botões na miniatura da barra de tarefas (mic, câmera, sair) | `win.setThumbarButtons` | Fase 3 |
| Notificação de mensagem com a janela fora de foco | `Notification` + `win.flashFrame(true)` | Fase 3 |
| Bandeja com "Mostrar" / "Sair da sala" / "Sair" | `Tray` | Fase 3 |
| Salas recentes na home | `localStorage` (só id e título; **nunca** a senha) | Fase 3 |

---

## 13. Segurança do Electron

Não negociável:

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`.
- O renderer é servido por **protocolo próprio** `app://myscreen` (`protocol.handle`, esquema
  registrado como `standard` e `secure`; contexto seguro para `getUserMedia`), com proteção contra
  *path traversal* e fallback SPA para `index.html`. Nada de `file://`.
- **CSP** no `index.html`: `default-src 'self'; connect-src 'self' wss://DOMINIO https://DOMINIO; media-src 'self' blob: mediastream:; img-src 'self' data: blob:; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'`. O worklet hoje é carregado de um `Blob`: manter `blob:` em `worker-src`, ou empacotar o worklet como arquivo.
- **Permissões**: `setPermissionRequestHandler` e `setPermissionCheckHandler` só concedem
  `media`, `display-capture`, `fullscreen`, `clipboard-sanitized-write` e `notifications`, e só
  para a origem `app://myscreen`. Todo o resto é negado.
- **Navegação**: `will-navigate` bloqueado; `setWindowOpenHandler` só permite `about:blank` (pop-out)
  e manda links `https:` para o navegador padrão via `shell.openExternal`, com allowlist.
- **IPC**: todo `ipcMain.handle` valida `event.senderFrame.url` (origem do app) e o tipo dos
  argumentos. O preload expõe funções estreitas (`window.myscreen.capture.list()`), nunca
  `ipcRenderer` cru.
- **Senha de sala**: vive só na memória da sessão, para o refresh do token. Nunca no disco.
- **Fuses** do Electron: desligar `RunAsNode`, `EnableNodeCliInspectArguments` e
  `EnableNodeOptionsEnvironmentVariable`; ligar `EnableEmbeddedAsarIntegrityValidation` e
  `OnlyLoadAppFromAsar`.
- **Módulo nativo**: roda no `utilityProcess`. Se travar ou cair, a sala continua e a tela segue
  sem som, com o aviso "O áudio do sistema parou" (mesmo comportamento do `onLost` de hoje).

---

## 14. Build, assinatura, instalador e atualização

`desktop/electron-builder.yml`:

```yaml
appId: com.myscreen.desktop
productName: MyScreen
artifactName: MyScreen-Setup-${version}.${ext}
directories:
  output: release
files:
  - dist/**
  - package.json
asarUnpack:
  - "**/*.node"            # o addon nativo nao carrega de dentro do asar
win:
  target: nsis
  icon: build/icon.ico
nsis:
  oneClick: false
  perMachine: false        # por usuario, sem administrador (como o MyScreen Audio)
  allowToChangeInstallationDirectory: true
  createStartMenuShortcut: true
protocols:
  - name: MyScreen
    schemes: [myscreen]
publish:
  provider: generic
  url: https://SEU_DOMINIO/downloads/
```

- **Versão do Electron**: a estável mais recente no início do projeto, travada no
  `package-lock.json`. Atualizar a cada release maior (correções de segurança do Chromium).
- **Requisitos**: Rust stable + `@napi-rs/cli` para o addon; Node LTS.
- **Assinatura**: sem certificado, o SmartScreen avisa na primeira execução (como já acontece
  com o MyScreen Áudio). Recomendado: Azure Trusted Signing ou um certificado OV. Com assinatura,
  configurar `publisherName` para o `electron-updater` validar o instalador baixado.
- **Auto-update**: `autoUpdater.checkForUpdatesAndNotify()` ao abrir e a cada 6 h; **nunca**
  instalar no meio de uma chamada: baixar em segundo plano e aplicar ao sair da sala.
- **Versão mínima** (opcional, seção 5.3): se `GET /api/desktop` disser que a versão local é
  antiga demais, a home bloqueia "Entrar" e mostra "Atualizar agora".

---

## 15. Design

- **Tokens** de `src/app/globals.css` (claro e escuro) vão para `shared/styles/globals.css` sem
  mudança de valor. O tema escuro passa a seguir o Windows quando a pessoa não escolheu nenhum.
- **Fontes**: Archivo e Spline Sans Mono, hoje via `next/font/google`. No app, empacotar com
  `@fontsource-variable/archivo` e `@fontsource/spline-sans-mono` (400/500/600): o app não
  depende de rede para desenhar texto.
- **Janela**: moldura nativa do Windows 11 (`titleBarStyle: "hidden"` + `titleBarOverlay` com as
  cores do token `sheet`/`ink`), e a barra superior da sala vira a área arrastável.
- **Home do app**: só as duas tarefas (Criar / Entrar) e as salas recentes. As seções de
  "capacidades" e "hospedagem" são vitrine do site e não entram.
- Princípios do `PRODUCT.md` continuam: a tela compartilhada é o produto; copy que explica o
  mecanismo; o que não foi medido aparece como não medido; pt-BR.

---

## 16. Testes e validação

### 16.1 Automatizados

| Camada | Ferramenta | O que cobre |
| :--- | :--- | :--- |
| Lógica compartilhada | Vitest (já existe) | `capturePrefs` (validação), `screenBitrate`, cálculo de colunas da grade e da divisão, extração de código de sala de um link. |
| Servidor | Vitest (já existe) | Inalterado. Acrescentar o teste da rota `/api/desktop`, se criada. |
| Main process | Vitest | Validação de IPC (remetente e tipos), resolução de caminhos do protocolo `app://` (traversal), mapeamento `window:<HWND>` → HWND. |
| Nativo | `cargo test` | `Agc` (converge para −16 dBFS, segura no silêncio), `soft_limit` (nunca passa de 1,0), `downmix` 5.1/7.1 → estéreo, empacotamento s16 de 10 ms. |
| Ponta a ponta | Playwright `_electron.launch` | Abre o app, cria sala no servidor de staging, entra pelo lobby, liga câmera falsa (`--use-fake-device-for-media-stream`), confere a track publicada. |

### 16.2 Matriz manual (antes de cada release)

| # | Cenário | Esperado |
| :--- | :--- | :--- |
| 1 | App transmite tela 1080p60 "Texto"; o Chrome assiste | Texto legível; painel do Chrome mostra ~60 FPS e 1920×1080. |
| 2 | App transmite um jogo em 4K60 "Vídeo e jogos" | Sem quadros descartados contínuos; CPU anotada. |
| 3 | Fone 7.1 como saída padrão; tela inteira com som | Som chega estéreo, sem `NotReadableError`. |
| 4 | Tela inteira com som + outra pessoa falando | Quem assiste **não** ouve a própria voz de volta. |
| 5 | Janela do Spotify, "Só esta janela" | Só o Spotify é transmitido; notificações do Windows não. |
| 6 | Janela do Chrome com YouTube, "Só esta janela" | Som do Chrome (todas as abas; documentar). |
| 7 | Tela + câmera + mic simultâneos | Quatro tracks publicadas; lado a lado funciona no espectador. |
| 8 | Câmera em uso pelo Teams | Mensagem "em uso por outro aplicativo"; a sala segue sem câmera. |
| 9 | Privacidade do Windows bloqueando a câmera | Aviso com o botão para `ms-settings:privacy-webcam`. |
| 10 | Rede 4G (CGNAT) via roteador do celular | Conecta pelo TURN; o painel mostra o candidato `relay`. |
| 11 | Derrubar o Wi-Fi por 10 s | Banner de reconexão; volta **sem** participante duplicado. |
| 12 | Chamada de 7 h (ou TTL curto no staging) | O token renova; a chamada não cai. |
| 13 | Minimizar o app transmitindo | O espectador continua a 60 FPS. |
| 14 | Dois monitores com DPI diferentes | Miniaturas e capturas corretas nos dois. |
| 15 | Monitor com HDR ligado | Cores aceitáveis, ou limitação documentada. |
| 16 | Matar o utility process de áudio | A tela continua; aviso de som perdido; dá para retomar. |
| 17 | Chat entre app e navegador | Mensagens nos dois sentidos, com nome e hora. |
| 18 | Clicar "Abrir no app" no site | O app abre na sala certa (ou foca a instância aberta). |
| 19 | Publicar a versão N+1 por SSH | O app N baixa, espera o fim da chamada e atualiza. |

---

## 17. Roteiro em fases

### Fase 0 — Preparação (servidor e repositório)
- Extrair `shared/` (sem `next/*`) e a interface `Platform`; o site passa a usar `WebPlatform`.
- `experimental.externalDir`, aliases, `.dockerignore`.
- Rota `/downloads/` no Caddy (dos dois modos de deploy) e diretório de releases.
- **Aceite**: o site faz deploy e funciona igual; `npm run check` verde; `curl -I
  https://DOMINIO/downloads/` responde.

### Fase 1 — App com paridade (sem nativo)
- Esqueleto do Electron (protocolo `app://`, preload, permissões, segurança da seção 13).
- API pelo main; home, lobby e sala portados; seletor próprio de telas e janelas; câmera e mic.
- Som do sistema temporariamente por `audio: "loopback"`, com aviso de eco.
- Instalador NSIS, publicação por SSH, auto-update.
- **Aceite**: cenários 1, 2, 7, 10, 11, 12, 17 e 19 da matriz.

### Fase 2 — Áudio nativo e captura completa
- Crate `desktop/native` (napi-rs) a partir do `companion/`; utility process; MessagePort até o worklet.
- "Sistema exceto o MyScreen", "Só esta janela", Discord opcional, AGC e volume.
- Esconder o MyScreen da captura, barra flutuante, powerSaveBlocker, `backgroundThrottling: false`.
- **Aceite**: cenários 3, 4, 5, 6, 13, 14 e 16.

### Fase 3 — Integração com o Windows
- Deep link, single instance, atalhos globais, thumbar, bandeja, notificações, salas recentes.
- "Abrir no app" e "Baixar para Windows" no site.
- **Aceite**: cenário 18, mais os atalhos funcionando com o app fora de foco.

### Fase 4 — Otimização
- H.264 por hardware × VP8/VP9 para 1080p60 e 4K (medido no painel de estatísticas).
- Assinatura de código. Telemetria **local** opcional (exportar estatísticas da sessão para
  diagnóstico, nunca enviada sozinha).

---

## 18. Riscos e pontos em aberto

| Risco | Mitigação |
| :--- | :--- |
| O loopback por processo é documentado pela Microsoft a partir do build 20348, mas funciona na prática em Windows 10 2004+ (é o que o OBS e o próprio companion usam). | `isProcessLoopbackSupported()` no início; plano B `audio: "loopback"` com aviso; testar em Windows 10 22H2 e Windows 11. |
| A ativação transitória exigida pelo `getDisplayMedia` pode expirar em alguma versão do Electron. | Plano B com `chromeMediaSource: "desktop"` (seção 8.3). |
| Versões diferentes do `@livekit/components-react` no site e no app quebram o chat. | Mesma versão travada nos dois; teste 17 da matriz em toda release. |
| `room.engine.token` é API privada do SDK. | Já é usada hoje; cobrir com o teste 12 e revisar a cada upgrade do `livekit-client`. |
| Cores em telas HDR. | Teste 15; documentar; acompanhar as correções do Chromium. |
| SmartScreen sem assinatura. | Fase 4: assinatura. Até lá, instrução na página de download. |
| Cloudflare guardando um `latest.yml` velho (modo produção). | `Cache-Control: no-cache` no feed; se preciso, uma regra de "bypass cache" para `/downloads/*.yml`. |
| Instalador grande (~100 MB). | Aceito; o `.blockmap` faz o auto-update baixar só o diff. |

Decisões que ficam com o dono do produto:

1. **URL padrão do servidor** embutida no build (`MYSCREEN_SERVER_URL`) e se a tela de
   Configurações deixa trocar (útil para quem hospeda o próprio servidor).
2. **Nome e ícone** do app (o `PRODUCT.md` registra que não existe identidade visual além do nome).
3. Se o **MyScreen Áudio** continua sendo distribuído para usuários do navegador depois que o app
   de desktop existir, ou se o site passa a recomendar só o app.
