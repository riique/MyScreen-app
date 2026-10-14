# MyScreen — controle remoto com consentimento ("modo AnyDesk")

> Plano de implementação para que uma pessoa na sala controle o mouse e o teclado do computador
> de outra, **só depois que a dona do computador permitir**, usando a chamada que já existe
> (LiveKit SFU + app de desktop Electron). Escrito a partir do código atual de `MyScreen-app/`
> (idêntico a `MyScreen/desktop/`) e do site em `MyScreen/`.
>
> Público: quem vai implementar. Onde há decisão, ela vem com o porquê. Onde há algo que só se
> sabe medindo, está marcado como **medir no spike** — nenhum número de latência aqui é inventado.

> **Estado (v1.1.0): fase 1 implementada** — desktop ↔ desktop, com "Enviar texto" (adiantado da
> fase 2). Servidor: `canUpdateOwnMetadata` e `identityProof` no site. Pendente: spike/matriz
> manual (seções 11.2 e 12, fase 0) em hardware real e as fases 2–4.

---

## 0. Resumo da decisão

| Pergunta | Resposta |
| :--- | :--- |
| **Quem pode ser controlado** | Só quem está no **app de Windows** e **compartilhando uma tela inteira** (não janela, na fase 1). O navegador não consegue injetar mouse/teclado no sistema operacional — isso é impossível pelo modelo de segurança da web. |
| **Quem pode controlar** | Qualquer participante: app de desktop (fase 1) e site no navegador (fase 2). Controlar é só capturar eventos e mandar pela rede, o que a web faz. |
| **Imagem** | A **mesma track `ScreenShare`** que já é publicada. Não existe um segundo vídeo. |
| **Transporte do input** | **Data channel do LiveKit** (`publishData` com `topic` e `destinationIdentities`), que já existe no token (`canPublishData: true`). Nenhuma porta nova, nenhum servidor novo, funciona atrás de NAT/CGNAT pelo mesmo TURN. |
| **Injeção no Windows** | `SendInput` num **módulo novo do addon Rust** (`native/src/input.rs`), carregado num utility process `input` — o mesmo padrão do som. |
| **Quem decide se o evento entra** | O **processo principal** do Electron. Ele guarda a sessão de controle, confere remetente, sessão, frequência, coordenadas e zonas protegidas antes de qualquer `SendInput`. |
| **Consentimento** | Pedido explícito → diálogo no app da pessoa controlada, **"Recusar" com foco por padrão**, expira em 30 s. Vale para **um participante, numa conexão, enquanto a tela estiver no ar**. |
| **Parar** | A qualquer momento, pelos dois lados: barra fixa "Fulano está controlando · Parar", atalho global, bandeja. E automaticamente: tela parou, alguém saiu/reconectou, PC bloqueou, app perdeu a sala. |
| **Servidor** | Duas mudanças pequenas no site: `canUpdateOwnMetadata` no token (para anunciar "controlável") e **endurecer o reuso de identidade** no `/api/livekit/token` (seção 8.3 — hoje é um risco real que o controle remoto tornaria grave). |

O que **não** dá para fazer sem um serviço do Windows rodando como SYSTEM (como o AnyDesk
instala): controlar a tela de UAC, a tela de bloqueio/login, `Ctrl+Alt+Del` e janelas de
programas abertos como administrador. Isso fica documentado como limitação e vira fase 4
(seção 13).

---

## 1. Por que este desenho (e não outro)

**Por que reaproveitar a chamada e não abrir uma conexão P2P própria.** A parte difícil de um
AnyDesk é atravessar NAT e manter vídeo bom. O MyScreen já resolve as duas: SFU com TURN
embutido, tela a 60 FPS com encode configurado. Falta só o caminho de volta (input), e ele cabe
num data channel que já está aberto.

**Por que o input passa pelo processo principal e não vai direto do renderer para o addon.** O
renderer é o lugar que recebe bytes da internet. Se ele chamasse o `SendInput` direto, qualquer
bug de parsing ou de estado ali viraria "estranho controla meu PC". O processo principal é a
única peça que sabe, ao mesmo tempo, se existe uma sessão autorizada, onde estão as janelas do
MyScreen, qual monitor está sendo compartilhado e se o PC está bloqueado. É ali que mora o
portão.

**Por que `SendInput` num utility process.** O som já roda assim (`src/audio/worker.ts`): se o
nativo cair, a sala continua. O custo extra (um hop de `MessagePort`) é desprezível perto da
rede.

**Por que coordenadas absolutas normalizadas e não deltas.** Com coordenadas absolutas um
pacote de movimento perdido não acumula erro: o próximo põe o cursor no lugar certo. E isso
permite mandar movimento por um canal **com perda** (mais rápido) sem bagunçar a ordem dos
cliques (seção 5.3).

---

## 2. Arquitetura

```
 CONTROLADOR (app ou navegador)                        CONTROLADO (app de Windows)
┌────────────────────────────────┐                   ┌──────────────────────────────────────────┐
│ Quadro da tela remota          │                   │ RENDERER                                 │
│  └─ ControlOverlay             │                   │  ├─ useRemoteControlHost                 │
│      pointer/teclado/roda      │                   │  │   recebe rc.ctl e rc.in do LiveKit     │
│      → coords 0..65535 do      │   LiveKit SFU     │  │   repassa bytes crus ao main (IPC)     │
│        quadro de vídeo         │  (data channel,   │  └─ ConsentDialog / indicador na sala    │
│      → keyboard.code → scancode│   mesmo TURN)     │                   │ ipc remote:input     │
│  useRemoteControlViewer ───────┼──────────────────►│ MAIN (portão)     ▼                      │
│   rc.ctl (confiável, JSON)     │  destino: só a    │  remote.ts                               │
│   rc.in  (binário):            │  identidade do    │   ├─ sessão: {sid, identity, display}    │
│     movimento → com perda      │  controlado       │   ├─ valida remetente, sessão, taxa      │
│     clique/tecla/roda → confiável                  │   ├─ mapeia 0..65535 → pixels físicos    │
│                                │                   │   ├─ zonas protegidas (janelas MyScreen) │
│ ◄──── vídeo ScreenShare ───────┼───────────────────┤   ├─ revoga: lock, share parou, saiu…    │
└────────────────────────────────┘                   │   └─ ControlBar (janela fixa no topo)    │
                                                     │                   │ MessagePort          │
                                                     │ UTILITY "input"   ▼                      │
                                                     │  addon Rust → SendInput (+ soltar tudo)  │
                                                     └──────────────────────────────────────────┘
```

Fluxo de uma sessão:

1. O app controlado, ao compartilhar uma **tela**, publica nos atributos do participante
   `rc.v = "1"` e `rc.display = "<largura>x<altura>"`. Quem vê esse atributo mostra o botão
   **"Pedir controle"** no quadro da tela dessa pessoa.
2. Controlador manda `rc.ctl/request` só para a identidade do controlado.
3. O renderer do controlado repassa ao main; o main abre o **diálogo de consentimento** (traz a
   janela para frente, pisca na barra de tarefas, notificação do Windows).
4. "Permitir" → o main cria a sessão (`sessionId` aleatório, presa ao **SID** do participante,
   não só à identidade) e responde `grant`. Abre a **ControlBar** vermelha no topo da tela.
5. O controlador entra em modo controle no quadro: eventos viram pacotes `rc.in`.
6. Cada pacote: renderer controlado → IPC → main valida → `MessagePort` → utility → `SendInput`.
7. Fim por qualquer lado ou por gatilho automático → `revoke`, o main manda **soltar todas as
   teclas e botões** e fecha a ControlBar.

---

## 3. Experiência de uso

### 3.1 Lado controlado (dona do computador)

- **Só aparece para quem está compartilhando a tela inteira pelo app.** Sem tela no ar, ninguém
  pode nem pedir.
- **Diálogo de consentimento**, modal, no app e trazido para frente mesmo minimizado:
  > **Ana quer controlar seu computador**
  > Ana vai poder mover o mouse e digitar na tela "Monitor 1 (principal)". Você vê tudo o que
  > acontece e pode parar a qualquer momento com `Ctrl+Alt+Shift+S` ou pelo botão vermelho no
  > topo da tela.
  > [ Recusar ] (foco) [ Permitir controle ]
  - Mostra nome **e** o sufixo da identidade (`Ana · 1a2b3c4d`): dois "Ana" na sala são
    distinguíveis.
  - Expira em 30 s sem resposta = recusa.
  - Só um pedido pendente por vez; depois de "Recusar", a mesma identidade espera 30 s para
    pedir de novo (anti-spam).
  - Opção na seção de configurações: **"Nunca aceitar pedidos de controle"** (o app nem publica
    `rc.v`).
- **ControlBar**: janela pequena, sempre no topo, centralizada no topo do monitor compartilhado,
  **fora da captura** (`setContentProtection(true)`), vermelha: `● Ana está controlando ·
  Pausar · Parar`. Não pode ser fechada pelo X; só pelos botões. (Hoje não existe barra flutuante
  no app — o "Parar" fica nos botões da miniatura da barra de tarefas — então ela é nova.)
- **Bandeja**: ícone muda enquanto há controle; menu ganha "Parar controle remoto".
- **Atalho global de pânico**: `Ctrl+Alt+Shift+S` (configurável) encerra na hora.
- **Prioridade local** (fase 2): se a pessoa mexer no mouse/teclado físico, o input remoto pausa
  por 1 s. Evita a briga pelo cursor.
- **Chat recebe uma linha de sistema**: "Ana começou a controlar a tela de Bruno" / "parou".
  Transparência para todos na sala.

### 3.2 Lado controlador

- No quadro da tela remota (palco, grade ou tela cheia), ação **"Pedir controle"** (ícone
  `MousePointer2`), visível só se o participante anuncia `rc.v` compatível.
- Estado "Aguardando Bruno permitir…" com "Cancelar". Recusa/expirou aparece como aviso.
- Concedido: o quadro ganha borda de destaque e uma barra fina:
  `Controlando a tela de Bruno · latência 48 ms · Tela cheia · Enviar texto · Soltar`.
  A latência é **medida** (ping no `rc.ctl`), não estimada — mesmo princípio do painel de
  estatísticas: o que não foi medido aparece como `--`.
- O quadro capta **mouse sempre** e **teclado quando focado** (clicar no quadro foca). Clicar
  fora / trocar de janela solta todas as teclas.
- **Tela cheia com Keyboard Lock** (`navigator.keyboard.lock()`): só assim `Alt+Tab`, a tecla
  Windows e `Esc` vão para o PC remoto em vez do local. Sai da tela cheia segurando `Esc`
  (comportamento padrão do Chromium). **Verificar no spike** se o Electron 44 honra o Keyboard
  Lock como o Chrome.
- **"Enviar texto"**: caixa onde se cola um texto que é digitado no remoto caractere a
  caractere (útil quando os teclados têm layouts diferentes, ou para colar um comando longo).
- Atalhos que nunca chegam ao remoto e o porquê aparecem numa dica: `Ctrl+Alt+Del` (exige serviço
  do sistema), tela de UAC e de bloqueio.

---

## 4. Descoberta de capacidade (quem pode ser controlado)

Usar **atributos de participante** do LiveKit (`localParticipant.setAttributes`), que todos
recebem em tempo real (`ParticipantAttributesChanged`):

| Atributo | Valor | Quem publica |
| :--- | :--- | :--- |
| `rc.v` | `"1"` (versão do protocolo) | app controlado, enquanto compartilha **tela** e a opção não está desligada |
| `rc.display` | `"2560x1440"` | idem, tamanho físico do monitor compartilhado (só informativo) |
| `rc.by` | identidade do controlador, ou ausente | app controlado, durante a sessão (para o indicador da sala) |

Requer `canUpdateOwnMetadata: true` no grant do token (seção 8.1). Atributo de um participante
só pode ser escrito por ele mesmo, então ninguém consegue "anunciar" que outro é controlável.

Sem o atributo (site, app antigo, opção desligada), o botão não aparece. App antigo que receber
um `rc.ctl` simplesmente ignora o tópico.

---

## 5. Protocolo

Dois tópicos, sempre com `destinationIdentities: [<outro lado>]` — **teclas digitadas não podem
ir para a sala inteira** (senha digitada no remoto chegaria a todos).

### 5.1 `myscreen.rc.ctl` — controle (confiável, JSON UTF-8)

```ts
type Ctl =
  | { t: "request"; v: 1; reqId: string }                       // controlador → controlado
  | { t: "cancel";  reqId: string }                             // controlador → controlado
  | { t: "grant";   reqId: string; sessionId: string;           // controlado → controlador
      trackSid: string; width: number; height: number }
  | { t: "deny";    reqId: string; reason: "refused" | "timeout" | "busy" | "disabled" | "not-sharing" }
  | { t: "revoke";  sessionId: string; reason: RevokeReason }   // qualquer lado
  | { t: "state";   sessionId: string; paused: boolean;          // controlado → controlador
      why?: "local-input" | "locked" | "elevated" | "user" }
  | { t: "ping";    sessionId: string; n: number }              // controlador → controlado
  | { t: "pong";    sessionId: string; n: number };             // controlado → controlador

type RevokeReason = "user" | "share-ended" | "left" | "reconnected" | "locked" | "panic" | "error";
```

`reqId` e `sessionId`: 16 bytes aleatórios em base64url. `trackSid` amarra a sessão à
publicação de tela específica: se a pessoa trocar de tela, a sessão cai (o controlador estaria
clicando às cegas na tela nova).

### 5.2 `myscreen.rc.in` — input (binário, compacto)

Cabeçalho comum (7 bytes): `u8 tipo | u32 sessionTag | u16 seq` — `sessionTag` são os 4
primeiros bytes do `sessionId` (pacote de sessão velha é descartado sem custo), `seq` é um
contador único para todos os tipos (com wrap).

| Tipo | Corpo | Canal |
| :--- | :--- | :--- |
| `0x01 MOVE` | `u16 x, u16 y` | **com perda** (`reliable: false`) |
| `0x02 BUTTON` | `u8 botão (0 esq,1 meio,2 dir,3 voltar,4 avançar), u8 down, u16 x, u16 y` | confiável |
| `0x03 WHEEL` | `i16 dx, i16 dy, u16 x, u16 y` (unidades de `WHEEL_DELTA` = 120 por "dente") | confiável |
| `0x04 KEY` | `u16 scancode (bit 0x100 = estendida), u8 down` | confiável |
| `0x05 TEXT` | UTF-8, até 1 KiB | confiável |
| `0x06 RELEASE_ALL` | — | confiável |

`x`, `y` em `0..65535` relativos **ao quadro de vídeo** (não ao elemento HTML, não à tela do
controlador).

### 5.3 Ordem entre canal com perda e confiável

Movimento vai pelo canal com perda porque é o grosso do tráfego e um movimento atrasado não
serve para nada. O risco seria um clique chegar antes do movimento que o precede — resolvido
porque **todo clique, roda e tecla de mouse carregam a própria coordenada**: o controlado faz
"mover para (x,y) e então clicar". Regra no main: um `MOVE` com `seq` anterior ao último
evento aplicado é descartado (comparação com wrap de 16 bits).

### 5.4 Frequência

- Controlador **coalesce** `pointermove` em `requestAnimationFrame` (no máximo um `MOVE` por
  quadro de tela, ~60/s; `getCoalescedEvents` não é necessário porque só a última posição
  importa).
- Main do controlado aplica um teto (balde de fichas): 240 eventos/s sustentados, rajada de 480.
  Acima disso, descarta `MOVE` primeiro; se mesmo eventos confiáveis estourarem, revoga com
  `"error"` (alguém está inundando).

---

## 6. Lado controlador — detalhes

### 6.1 Coordenadas

O vídeo da tela é desenhado com `object-contain`, então existe tarja preta. Calcular o
retângulo do conteúdo a partir de `video.videoWidth/videoHeight` e do tamanho do elemento:

```ts
// shared/remote/geometry.ts (puro, testado)
export function contentRect(elW: number, elH: number, vidW: number, vidH: number) {
  const scale = Math.min(elW / vidW, elH / vidH);
  const w = vidW * scale, h = vidH * scale;
  return { x: (elW - w) / 2, y: (elH - h) / 2, w, h };
}
export function toNormalized(px: number, py: number, r: Rect): [number, number] | null {
  const nx = (px - r.x) / r.w, ny = (py - r.y) / r.h;
  if (nx < 0 || ny < 0 || nx > 1 || ny > 1) return null;      // na tarja: não envia
  return [Math.round(nx * 65535), Math.round(ny * 65535)];
}
```

Recalcular a cada evento (o vídeo pode mudar de resolução no meio — `resize` do track).

### 6.2 Eventos

- `ControlOverlay` é uma `div` transparente por cima do `<VideoTrack>`, com `tabIndex=0`,
  `touch-action: none` e `cursor: default` (o cursor de verdade vem no vídeo; o local continua
  visível, como no AnyDesk).
- `pointerdown/up` com `setPointerCapture` (arrastar para fora do quadro não deixa botão preso);
  `contextmenu` com `preventDefault`; `wheel` com `{ passive: false }` e conversão de
  `deltaMode` (pixel → linhas → 120 por dente, acumulando frações).
- `keydown/keyup` com `preventDefault`, usando **`event.code`** (tecla física) → scancode pela
  tabela `shared/remote/keymap.ts`. Repetição (`event.repeat`) é repassada: o Windows não gera
  auto-repeat para tecla injetada.
- `blur` da janela, `visibilitychange`, sair do modo controle, desmontar o quadro →
  `RELEASE_ALL`.
- No quadro de tela, desligar duplo clique = tela cheia e o menu de contexto do quadro enquanto
  controla (hoje `onDoubleClick` alterna tela cheia — em modo controle o duplo clique é do
  remoto). A tela cheia passa a ser o botão da barra.

### 6.3 Tabela de teclas (`event.code` → scancode set 1)

Pura e testada. Pontos que costumam errar:

- Estendidas (bit `0x100`, viram `KEYEVENTF_EXTENDEDKEY`): setas, `Insert`, `Delete`, `Home`,
  `End`, `PageUp`, `PageDown`, `ControlRight`, `AltRight` (AltGr), `NumpadEnter`,
  `NumpadDivide`, `MetaLeft/Right` (0x5B/0x5C), `ContextMenu` (0x5D), `PrintScreen`.
- ABNT2: `IntlRo` (`/?`, 0x73) e `NumpadComma` (0x7E).
- `Pause` é sequência especial (E1 1D 45) — tratar à parte ou não suportar na fase 1.
- Como o que vai é a tecla física, **o layout que vale é o do PC controlado**. Mesmo layout dos
  dois lados (o caso comum, ABNT2↔ABNT2) funciona inclusive com acentos e AltGr. Layouts
  diferentes: usar "Enviar texto".

### 6.4 Latência de exibição

Enquanto controla, baixar o buffer de jitter do receptor da track de tela
(`RTCRtpReceiver.jitterBufferTarget = 0`, se o Chromium aceitar) e restaurar ao sair. **Medir no
spike** quanto ganha; se não ganhar, não entra.

---

## 7. Lado controlado — detalhes

### 7.1 Renderer (`useRemoteControlHost`)

- Publica/remove `rc.v`/`rc.display` conforme o estado do compartilhamento (`startScreenShare`
  e `endSharing` em `ConferenceRoom.tsx` já são os pontos únicos de entrada e saída).
- Escuta `RoomEvent.DataReceived` nos dois tópicos. Para `rc.in`, **não interpreta**: manda os
  bytes crus + `participant.identity` + `participant.sid` ao main (`remote:input`). Para
  `rc.ctl`, faz o parse do JSON com validação de esquema e repassa.
- A identidade/SID do remetente vem do SFU (o servidor carimba o remetente do pacote; o cliente
  não consegue mentir). É isso que o main usa para conferir.
- Escuta `ParticipantDisconnected`, `ParticipantConnected` (mesma identidade voltando = sessão
  nova, ver 8.3), `Reconnecting`/`Disconnected` da sala → avisa o main para revogar.
- Mostra o `ConsentDialog` quando o main pede, e devolve a decisão ao main. O main é quem cria a
  sessão — o renderer não tem um "grant" que funcione sozinho.

### 7.2 Main (`src/main/remote.ts`) — o portão

Estado:

```ts
type Session = {
  sessionId: Uint8Array; tag: number;
  identity: string; participantSid: string; trackSid: string;
  display: { id: string; physical: Rect };   // monitor compartilhado, em pixels físicos
  paused: boolean; lastSeq: number; pressedKeys: Set<number>; pressedButtons: Set<number>;
  bucket: TokenBucket; startedAt: number;
};
let session: Session | null = null;   // no máximo uma sessão por vez
```

Para cada pacote `remote:input`:

1. Existe sessão, não pausada? `identity` **e** `participantSid` batem? `sessionTag` bate?
2. Parse estrito (tamanho exato por tipo; valores fora de faixa = descarta).
3. Balde de fichas (5.4).
4. `MOVE` velho por `seq` → descarta.
5. Coordenada → pixel físico do monitor compartilhado:
   `px = display.physical.x + round(x / 65535 * (display.physical.w - 1))`, idem `y`.
6. **Zona protegida**: se `(px, py)` cai dentro de qualquer `BrowserWindow` do MyScreen
   (`getBounds()` → físico via `screen.dipToScreenRect`) → descarta cliques/roda (movimento
   pode passar). Se a janela em primeiro plano é do MyScreen → descarta teclas. Isso impede o
   controlador de clicar às cegas no próprio app do controlado (mudar o servidor, conceder
   controle a mais alguém, desligar a ControlBar).
7. Atualiza `pressedKeys`/`pressedButtons` e manda ao utility `input`.

Gatilhos de revogação no main (todos chamam `endSession(reason)`, que manda `RELEASE_ALL` antes de
tudo):

| Gatilho | Fonte |
| :--- | :--- |
| Botão "Parar" na ControlBar / bandeja / atalho global | main |
| Compartilhamento parou ou trocou de fonte | `room:setSharing` com `active: false` ou outro `displayId` |
| Controlador saiu, reconectou, ou a sala caiu | renderer (`remote:peerGone`) |
| PC bloqueado, suspensão, sessão do Windows trocada | `powerMonitor` `lock-screen`, `suspend`; `session-end` da janela |
| Renderer recarregou ou caiu | `render-process-gone`, `did-start-loading` da janela principal |
| Utility `input` caiu | evento `exit` do utility process (não reinicia sozinho no meio de uma sessão) |
| Monitor compartilhado desconectado | `screen` `display-removed` |
| Inundação | balde de fichas estourado em evento confiável |

### 7.3 Mapeamento para o monitor (DPI e vários monitores)

- O Electron já roda com *per-monitor DPI awareness v2*; `screen.getAllDisplays()` dá bounds em
  DIP. Converter com `screen.dipToScreenRect(null, display.bounds)` para pixels físicos.
- O `displayId` do monitor compartilhado já chega ao main pelo `room:setSharing` (é o mesmo
  dado que o `CaptureSource.displayId`).
- No addon: `SendInput` com `MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK`,
  normalizando sobre a área virtual (`GetSystemMetrics(SM_XVIRTUALSCREEN…SM_CYVIRTUALSCREEN)`):
  `nx = ((px - vx) * 65535) / (vw - 1)`. Existe arredondamento de ±1 px em telas muito largas;
  se o spike mostrar erro visível, usar `SetCursorPos(px, py)` + `SendInput` só do botão.
- **Matriz obrigatória do spike**: 1 monitor 100%; 2 monitores 100% + 150%; monitor secundário à
  esquerda (coordenadas negativas); 4K a 200%.

### 7.4 Addon nativo (`native/src/input.rs`)

```rust
#[napi] pub struct InputInjector { pressed_keys: HashSet<u16>, pressed_buttons: u8 }
#[napi] impl InputInjector {
  #[napi(constructor)] pub fn new() -> Self;
  #[napi] pub fn move_to(&self, px: i32, py: i32) -> Result<()>;
  #[napi] pub fn button(&mut self, button: u8, down: bool, px: i32, py: i32) -> Result<()>;
  #[napi] pub fn wheel(&self, dx: i32, dy: i32, px: i32, py: i32) -> Result<()>; // MOUSEEVENTF_WHEEL / HWHEEL
  #[napi] pub fn key(&mut self, scancode: u16, down: bool) -> Result<()>;        // KEYEVENTF_SCANCODE (+EXTENDEDKEY)
  #[napi] pub fn text(&self, s: String) -> Result<()>;                            // KEYEVENTF_UNICODE, pares surrogate
  #[napi] pub fn release_all(&mut self) -> Result<()>;                            // solta tudo que está em pressed_*
  #[napi] pub fn foreground(&self) -> ForegroundInfo;                             // hwnd, pid, elevated: Option<bool>
}
```

- Todo `INPUT` sai com `dwExtraInfo = 0x4D59_5343` ("MYSC"): permite à fase 2 (prioridade local)
  distinguir o que é nosso no hook de baixo nível.
- `SendInput` devolve quantos eventos entraram; 0 com `GetLastError() == ERROR_ACCESS_DENIED` é
  o sinal de **UIPI** (janela de processo elevado em primeiro plano) → o main manda
  `state { paused: true, why: "elevated" }` e o controlador vê "O Bruno está numa janela de
  administrador; só ele pode clicar nela".
- `foreground().elevated`: `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION)` +
  `GetTokenInformation(TokenElevation)`; se o `OpenProcess` falhar, devolve `None` (não sabemos —
  e a interface diz que não sabe).
- Features novas do `windows-sys`: `Win32_UI_Input_KeyboardAndMouse`, `Win32_System_Threading`,
  `Win32_Security`, `Win32_Graphics_Gdi`.
- `cargo test`: normalização de coordenadas, conversão de scancode → flags, divisão de texto em
  UTF-16 com surrogates. O `SendInput` em si não roda em teste.

### 7.5 Utility process `input` (`src/input/worker.ts`)

Mesmo esqueleto de `src/audio/worker.ts`: carrega o addon, recebe comandos por `MessagePort`
(formato já decodificado pelo main, nunca os bytes da rede), responde erros. Se o addon não
carregar, `remote:capabilities` devolve `{ available: false, reason }` e o app não publica `rc.v`.

### 7.6 ControlBar

Nova `BrowserWindow` (em `windows.ts`): sem moldura, `alwaysOnTop("screen-saver")`,
`skipTaskbar`, `focusable: false` (não rouba o foco do que está sendo controlado),
`setContentProtection(true)`, posicionada no topo do monitor compartilhado. Página própria no
renderer (`#/control-bar`) com `preload` restrito a `remote:stop` e `remote:pause`. Fica fora
da zona de clique do controlador por estar na lista de janelas protegidas (7.2-6).

---

## 8. Servidor (site Next.js)

### 8.1 Token: atributos

`src/lib/livekit.ts`:

```ts
at.addGrant({
  roomJoin: true, room: roomName,
  canPublish: true, canPublishData: true, canSubscribe: true,
  canUpdateOwnMetadata: true,   // novo: rc.v / rc.display / rc.by
});
```

Efeito colateral: o participante também pode trocar o próprio nome. Aceitável (o nome já é livre
na entrada), mas o diálogo de consentimento mostra o **sufixo da identidade**, que não muda.

### 8.2 Nada mais muda na infraestrutura

Sem porta nova, sem container novo, sem mudança no `livekit.yaml` nem no Caddy. O data channel
já passa pelo mesmo caminho (UDP direto ou TURN).

### 8.3 Endurecer o reuso de identidade — **pré-requisito**

Hoje `/api/livekit/token` devolve a mesma identidade a quem mandar `participantIdentity` no
formato `<apelido>-<8 hex>` **com o mesmo apelido**. A identidade de todos é visível para todos na
sala. Então quem souber que "Ana-1a2b3c4d" está controlando o PC do Bruno pode pedir um token
com apelido "Ana" e essa identidade: o LiveKit derruba a Ana verdadeira e o atacante entra no
lugar dela. Em chat isso é impersonação; com controle remoto vira **sequestro da sessão de
controle**.

Duas defesas, as duas entram:

1. **No cliente (já resolve o sequestro):** a sessão é presa ao **`participant.sid`**, que muda a
   cada conexão. Qualquer reconexão da identidade autorizada (`ParticipantConnected` com a mesma
   identidade, ou SID diferente num pacote) revoga com `"reconnected"`. O controlador legítimo
   pede de novo; o controlado vê o pedido.
2. **No servidor:** só reusar identidade com prova. O token devolve também
   `identityProof = base64url(HMAC-SHA256(LIVEKIT_API_SECRET, roomId + "\n" + identity))`; o
   cliente guarda e manda junto para reusar. Sem prova válida (`timingSafeEqual`), identidade
   nova. Muda `route.ts`, `TokenResponse` nos dois clientes e os testes em `handlers.test.ts`
   (casos: prova certa reusa; prova de outra sala não reusa; sem prova não reusa).

---

## 9. Segurança — modelo de ameaça

| Ameaça | Defesa |
| :--- | :--- |
| Alguém controla sem permissão | Sessão só nasce no main depois de clique em "Permitir" no diálogo; `Recusar` é o padrão; expira em 30 s. |
| Participante finge ser o autorizado | Remetente carimbado pelo SFU; sessão presa a identidade **+ SID**; reconexão revoga; prova HMAC no token (8.3). |
| Outro participante injeta input | Main descarta qualquer pacote de identidade/SID ≠ sessão. |
| Teclas (senhas) vazam para a sala | `destinationIdentities` em todo pacote; nunca broadcast. |
| O SFU vê as teclas | É o seu servidor (premissa do produto). Para quem não aceita isso: E2EE do LiveKit na fase 4 — **verificar** se a versão cobre data packets. |
| Controlador mexe no próprio MyScreen do controlado | Zonas protegidas (7.2-6); ControlBar não focável e protegida. |
| Tecla ou botão presos | `pressed*` rastreado no addon; `RELEASE_ALL` em todo fim de sessão, `blur`, pausa e queda de processo. |
| Inundação / pacote malformado | Parser de tamanho exato, faixa checada, balde de fichas, revogação se insistir. |
| Spam de pedidos | Um pendente por vez; 30 s de espera por identidade depois de recusa. |
| Controle continua "esquecido" | ControlBar sempre visível no monitor controlado; ícone da bandeja; linha no chat; atalho global de pânico. |
| Controlador age em tela que não vê | Coordenadas presas ao monitor compartilhado; trocar a fonte revoga (`trackSid`). |
| XSS no renderer concederia controle | CSP existente; o diálogo é página do app (`app://myscreen`), não conteúdo remoto; nome do participante renderizado como texto (React) e truncado. |

Princípio de produto aplicado: **não existe acesso sem a pessoa na frente do computador**. Nada de
senha fixa, acesso não assistido ou "lembrar este controlador" na fase 1.

---

## 10. Estrutura de arquivos

Caminhos relativos à raiz do app de desktop. (Hoje existem duas cópias idênticas,
`MyScreen-app/` e `MyScreen/desktop/`; decidir qual é a canônica **antes** de começar, ou o
trabalho diverge.)

```
native/src/input.rs                 NOVO  SendInput, soltar tudo, janela em primeiro plano
native/src/lib.rs                   +     exporta InputInjector
native/Cargo.toml                   +     features do windows-sys
src/input/worker.ts                 NOVO  utility process "input"
src/main/remote.ts                  NOVO  sessão, portão, mapeamento, revogação, ControlBar
src/main/ipc.ts                     +     remote:capabilities|request|decide|input|peerGone|stop|pause
src/main/windows.ts                 +     createControlBar(); lista de janelas protegidas
src/main/integration.ts             +     bandeja e atalho de pânico
src/main/index.ts                   +     powerMonitor; desligar sessão no before-quit
src/preload/index.ts                +     window.myscreen.remote.*
src/shared/ipc.ts                   +     tipos Remote*
src/shared/remote/protocol.ts       NOVO  encode/decode binário e esquema do rc.ctl (puro)
src/shared/remote/keymap.ts         NOVO  event.code → scancode (puro)
src/shared/remote/geometry.ts       NOVO  contentRect / toNormalized / toPhysical (puro)
src/renderer/components/conference/remote/
  useRemoteControlHost.ts           NOVO
  useRemoteControlViewer.ts         NOVO
  ConsentDialog.tsx                 NOVO
  ControlOverlay.tsx                NOVO
  ControlToolbar.tsx                NOVO
  SendTextDialog.tsx                NOVO (fase 2)
src/renderer/pages/ControlBar.tsx   NOVO
src/renderer/components/conference/ConferenceRoom.tsx  +  ação no quadro, overlay, chat de sistema
src/renderer/components/AppSettingsDialog.tsx          +  "Nunca aceitar pedidos de controle", atalho
tests/remote-protocol.test.ts       NOVO
tests/remote-keymap.test.ts         NOVO
tests/remote-geometry.test.ts       NOVO
tests/remote-gate.test.ts           NOVO  (main/remote.ts com injetor falso)
```

Site (`MyScreen/`), fase 2 — só o papel de controlador:

```
src/lib/livekit.ts                       canUpdateOwnMetadata (fase 1, porque o app depende)
src/app/api/livekit/token/route.ts       identityProof (fase 1)
src/components/conference/remote/        cópia de protocol/keymap/geometry + viewer + overlay
src/components/conference/ConferenceRoom.tsx
```

O protocolo fica duplicado entre os dois códigos (já é assim com o resto da sala). Para não
divergir, `tests/remote-protocol.vectors.json` com pacotes de referência é copiado igual nos dois
e os dois conjuntos de testes o leem.

---

## 11. Testes

### 11.1 Automatizados

- **Protocolo**: ida e volta de cada tipo; rejeição de tamanho errado, tipo desconhecido, texto
  > 1 KiB, UTF-8 inválido; *fuzz* com bytes aleatórios (nada pode lançar fora do parser).
- **Geometria**: tarja horizontal e vertical, clique na tarja = `null`, cantos exatos
  (0 e 65535 → primeiro e último pixel), monitores com origem negativa, 150%/200%.
- **Keymap**: tabela completa, estendidas, ABNT2.
- **Portão** (`remote.ts` com injetor falso): identidade certa + SID errado = descarta; sessão
  revogada = descarta; `MOVE` velho = descarta; zona protegida = descarta clique e permite
  movimento; estouro do balde; todo caminho de revogação chama `release_all` **antes** de
  limpar o estado.
- **Servidor**: casos do `identityProof` (8.3).
- **E2E** (`tests/e2e`): duas instâncias do Electron com `MYSCREEN_INPUT_DRYRUN=1` (o utility
  registra os comandos em vez de chamar `SendInput`) contra um LiveKit `--dev` local:
  pedido → recusa; pedido → permitir → clique chega com a coordenada esperada → parar
  compartilhamento revoga.

### 11.2 Matriz manual (antes de cada release com controle)

| Caso | Esperado |
| :--- | :--- |
| 2 monitores, 100% + 150%, compartilhando o secundário | Clique no canto do vídeo cai no canto do monitor certo |
| Monitor à esquerda do principal | Coordenadas negativas corretas |
| ABNT2 ↔ ABNT2: `ç`, `~a`, `´e`, AltGr+Q (`/`) | Caracteres certos |
| Controlador com layout US | Documentado: usar "Enviar texto" |
| Arrastar janela e soltar fora do quadro | Botão não fica preso |
| `Alt+Tab` e tecla Windows em tela cheia | Vão para o remoto (se Keyboard Lock funcionar no Electron) |
| Gerenciador de Tarefas aberto no remoto | Pausa "elevated", aviso nos dois lados |
| `Win+L` no remoto | Sessão revogada, "locked" |
| Controlador perde a rede 20 s | Revogada ao reconectar; precisa pedir de novo |
| Mesmo apelido entrando com a identidade do controlador | Não reusa identidade; sessão não migra |
| Controlador clica onde está a janela do MyScreen do controlado | Clique descartado |
| 4G/TURN | Funciona; latência medida aparece na barra |
| Sessão de 1 h | Sem tecla presa, sem vazamento de memória no main |

---

## 12. Roteiro em fases

### Fase 0 — Spike (provar o que é incerto antes de construir)

1. `input.rs` mínimo + script Node que move e clica nos 4 cantos de cada monitor (matriz 7.3).
2. Keyboard Lock dentro do Electron 44 em tela cheia.
3. Ida e volta de `publishData` com `reliable: false` e `destinationIdentities` pelo SFU de
   produção e por TURN; medir RTT do `ping/pong`.
4. Comportamento de UIPI: o que o `SendInput` devolve com o Gerenciador de Tarefas na frente.
5. Decidir a cópia canônica do app (`MyScreen-app/` × `MyScreen/desktop/`).

Saída: notas com o que foi medido, ajustes neste documento.

### Fase 1 — MVP desktop ↔ desktop

- Servidor: `canUpdateOwnMetadata` + `identityProof` (deploy antes do app).
- Protocolo, keymap, geometria com testes.
- Addon + utility `input` + `remote.ts` (portão completo, todas as revogações).
- Atributos `rc.*`, "Pedir controle", diálogo, overlay de mouse e teclado, ControlBar, bandeja,
  atalho de pânico, linha no chat.
- Configuração "Nunca aceitar pedidos de controle".
- Só tela inteira. Sem "Enviar texto".
- Subir `minVersion` no `/api/desktop`? **Não**: app antigo só não oferece o recurso; não precisa
  ser forçado a atualizar.

### Fase 2 — Navegador como controlador e conforto

- Controlador no site (viewer + overlay + protocolo duplicado com vetores).
- "Enviar texto" (`KEYEVENTF_UNICODE`).
- Prioridade local: hook `WH_MOUSE_LL`/`WH_KEYBOARD_LL` no utility, ignorando eventos com
  `LLMHF_INJECTED` + `dwExtraInfo` nosso; input físico pausa o remoto por 1 s.
- `jitterBufferTarget` baixo durante o controle (se o spike mostrar ganho).
- Sugerir ao controlado trocar o tipo de conteúdo para "Telas e texto" ao conceder (hoje
  `startScreenShare` força `motion`; para controlar, nitidez do texto pesa mais).

### Fase 3 — Janela e área de transferência

- Controle de **janela** compartilhada: mapear para `DwmGetWindowAttribute(DWMWA_EXTENDED_FRAME_BOUNDS)`
  do HWND, acompanhar movimento/redimensionamento, descartar cliques fora dela.
- Área de transferência de texto, **sob comando explícito** ("Copiar do remoto" / "Colar no
  remoto"), nunca sincronizada sozinha.
- Pedir "trocar para o monitor 2" (o controlado confirma; troca de fonte = sessão nova).

### Fase 4 — Nível AnyDesk (decisão separada, muda o produto)

- Serviço do Windows como SYSTEM (instalador com administrador) para UAC, tela de bloqueio e
  `Ctrl+Alt+Del` (`SendSAS`). Isso exige instalador por máquina, assinatura de código e muda o
  modelo de segurança — não entra sem uma decisão explícita.
- Transferência de arquivos (data streams do LiveKit, `sendFile`).
- E2EE.

---

## 13. Limitações conhecidas (comunicar na interface, não esconder)

- **Navegador não pode ser controlado.** Só o app de Windows.
- **Janelas de administrador** (Gerenciador de Tarefas, instaladores, regedit) não recebem input
  do MyScreen enquanto o app roda sem elevação — regra do Windows (UIPI).
- **UAC, tela de bloqueio e `Ctrl+Alt+Del`** ficam na área de trabalho segura do Windows, que um
  app comum não alcança.
- **Layout de teclado**: vale o do PC controlado.
- **Latência** = rede ida (input) + encode, rede e decode da tela na volta. A barra mostra a
  parte de rede medida; a parte do vídeo aparece no painel de estatísticas que já existe.

---

## 14. Pontos em aberto

1. ~~Qual cópia do app é a canônica~~ — **decidido: `MyScreen-app/`**.
2. Atalho de pânico padrão (`Ctrl+Alt+Shift+S` proposto) — conferir conflito com os atalhos
   globais que o app já registra em `integration.ts`.
3. Mais de um controlador ao mesmo tempo: **não** na fase 1 (um por vez; outro pedido recebe
   `deny: busy`). Revisitar só se houver caso real.
4. "Só ver o cursor" (apontar sem clicar) como modo intermediário de permissão — útil para
   aula/suporte; barato de adicionar (portão aceita só `MOVE`), decidir com uso real.
