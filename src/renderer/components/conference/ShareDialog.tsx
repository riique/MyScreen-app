import { AppWindow, Monitor, MonitorUp, RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { AudioCapabilities, CaptureSource } from "@shared/ipc";
import { CheckCell } from "@/components/sheet";
import { CaptureRuler } from "@/components/capture/CaptureRuler";
import type { CaptureSettings, SystemAudioPrefs } from "@/components/capture/capturePrefs";
import { cn } from "@/lib/utils";
import { usePlatform } from "@/platform";

/** Miniaturas atualizadas enquanto o diálogo está aberto. */
const THUMB_REFRESH_MS = 3000;

/**
 * O seletor do app substitui o do navegador E o diálogo de compartilhar do
 * site: fonte (tela ou janela) e régua de qualidade. O som vai sempre
 * completo: o sistema inteiro, menos o próprio MyScreen.
 *
 * "Compartilhar" chama `onConfirm` direto do clique: o `getDisplayMedia`
 * exige gesto do usuário, e nada assíncrono pode ficar no meio.
 */
export function ShareDialog({
  open,
  initial,
  audioPrefs,
  capabilities,
  onConfirm,
  onClose,
}: {
  open: boolean;
  initial: CaptureSettings;
  audioPrefs: SystemAudioPrefs;
  capabilities: AudioCapabilities | null;
  onConfirm: (settings: CaptureSettings, source: CaptureSource, audio: SystemAudioPrefs) => void;
  onClose: () => void;
}) {
  const platform = usePlatform();
  const [settings, setSettings] = useState<CaptureSettings>(initial);
  const [audio, setAudio] = useState<SystemAudioPrefs>(audioPrefs);
  const [sources, setSources] = useState<CaptureSource[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [tab, setTab] = useState<"screen" | "window">("screen");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);

  const native = capabilities?.native === true;

  const refresh = useCallback(async () => {
    try {
      const list = await platform.listCaptureSources();
      setSources(list);
      setListError(null);
    } catch (error) {
      console.error("Falha ao listar telas e janelas:", error);
      setListError("Não foi possível listar as telas e janelas.");
    }
  }, [platform]);

  // Cada abertura parte da última escolha confirmada.
  useEffect(() => {
    if (!open) return;
    setSettings(initial);
    setAudio(audioPrefs);
    setSources(null);
    setSelectedId(initial.lastSourceId);
    setTab(initial.lastSourceId?.startsWith("window:") ? "window" : "screen");
    void refresh();
    const id = setInterval(() => void refresh(), THUMB_REFRESH_MS);
    return () => clearInterval(id);
  }, [open, initial, audioPrefs, refresh]);

  // A última fonte pode não existir mais (janela fechada): cai na primeira tela.
  useEffect(() => {
    if (!sources) return;
    if (selectedId && sources.some((s) => s.id === selectedId)) return;
    const first = sources.find((s) => s.kind === tab) ?? sources[0];
    setSelectedId(first?.id ?? null);
  }, [sources, selectedId, tab]);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panelRef.current) return;
      const focusables = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open, onClose]);

  if (!open) return null;

  const selected = sources?.find((s) => s.id === selectedId) ?? null;
  const visible = (sources ?? []).filter((s) => s.kind === tab);
  const screens = (sources ?? []).filter((s) => s.kind === "screen").length;
  const windows = (sources ?? []).filter((s) => s.kind === "window").length;

  // Sem portal: a sala pode estar em tela cheia.
  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim p-6"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-dialog-title"
        className="flex max-h-[92vh] w-full max-w-[60rem] flex-col overflow-hidden border border-rule-2 bg-sheet shadow-overlay outline-none [border-radius:var(--radius-sheet)]"
      >
        <div className="flex items-start justify-between gap-6 px-6 pt-5 pb-3">
          <div className="min-w-0">
            <h2 id="share-dialog-title" className="text-[1.125rem] font-semibold tracking-[-0.015em] text-ink">
              Compartilhar tela
            </h2>
            <p className="mt-1 text-[0.875rem] leading-[1.5] text-ink-2">
              Escolha uma tela inteira ou uma janela. Janela por trás de outras continua sendo transmitida.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Cancelar compartilhamento"
            className="shrink-0 p-1.5 text-ink-3 transition-colors hover:text-ink"
          >
            <X size={18} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Fontes */}
          <div className="border-t border-rule">
            <div className="flex items-center gap-1 px-4 pt-3" role="tablist" aria-label="Tipo de fonte">
              <TabButton active={tab === "screen"} onClick={() => setTab("screen")} count={screens}>
                <Monitor size={15} strokeWidth={1.75} aria-hidden />
                Telas
              </TabButton>
              <TabButton active={tab === "window"} onClick={() => setTab("window")} count={windows}>
                <AppWindow size={15} strokeWidth={1.75} aria-hidden />
                Janelas
              </TabButton>
              <button
                type="button"
                onClick={() => void refresh()}
                aria-label="Atualizar lista"
                title="Atualizar lista"
                className="ml-auto p-1.5 text-ink-3 transition-colors hover:text-ink"
              >
                <RefreshCw size={14} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
            <div className="grid max-h-[18.5rem] grid-cols-2 gap-3 overflow-y-auto p-4 sm:grid-cols-3">
              {sources === null ? (
                <p className="col-span-full py-10 text-center font-mono text-[0.8125rem] text-ink-3">
                  {listError ?? "Listando telas e janelas..."}
                </p>
              ) : visible.length === 0 ? (
                <p className="col-span-full py-10 text-center text-[0.875rem] text-ink-3">
                  {tab === "window" ? "Nenhuma janela aberta para compartilhar." : "Nenhuma tela encontrada."}
                </p>
              ) : (
                visible.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    role="radio"
                    aria-checked={s.id === selectedId}
                    onClick={() => setSelectedId(s.id)}
                    onDoubleClick={() => confirmRef.current?.click()}
                    className={cn(
                      "group flex min-w-0 flex-col gap-2 border p-2 text-left transition-colors [border-radius:var(--radius-cell)]",
                      s.id === selectedId
                        ? "border-signal bg-signal-wash"
                        : "border-rule bg-sheet hover:border-rule-3 hover:bg-band",
                    )}
                  >
                    <span className="flex aspect-video w-full items-center justify-center overflow-hidden bg-monitor [border-radius:6px]">
                      {s.thumbnail ? (
                        <img src={s.thumbnail} alt="" className="h-full w-full object-contain" draggable={false} />
                      ) : null}
                    </span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      {s.appIcon ? <img src={s.appIcon} alt="" className="size-4 shrink-0" draggable={false} /> : null}
                      <span
                        className={cn(
                          "truncate text-[0.8125rem] font-medium",
                          s.id === selectedId ? "text-signal" : "text-ink",
                        )}
                        title={s.name}
                      >
                        {s.name}
                      </span>
                      {s.detail ? (
                        <span className="ml-auto shrink-0 font-mono text-[0.6875rem] text-ink-3">{s.detail}</span>
                      ) : null}
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="border-y border-rule">
            <CaptureRuler settings={settings} onChange={(next) => setSettings((prev) => ({ ...prev, ...next }))} />
          </div>

          <div>
            {native ? (
              <CheckCell
                name="share-discord"
                checked={audio.excludeDiscord}
                onChange={(v) => setAudio((a) => ({ ...a, excludeDiscord: v }))}
                label="Ignorar também o som do Discord"
                note="Para a voz de quem está numa chamada do Discord não ir junto."
              />
            ) : null}
            {!native ? (
              <p className="border-b border-rule px-5 py-3 text-[0.8125rem] leading-[1.5] text-warn">
                {capabilities?.reason ?? "O som nativo não está disponível."} O som vai pelo captador do Chromium,
                que pega tudo — inclusive a voz da chamada. Use fone de ouvido para não fazer eco.
              </p>
            ) : null}
            <CheckCell
              name="share-hide-self"
              checked={settings.hideSelf}
              onChange={(v) => setSettings((prev) => ({ ...prev, hideSelf: v }))}
              label="Esconder as janelas do MyScreen da captura"
              note="Evita o efeito espelho com a tela inteira. Você continua vendo o app normalmente."
            />
          </div>
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-rule px-6 py-4">
          <p className="min-w-0 truncate text-[0.8125rem] text-ink-3">
            {selected ? (
              <>
                Fonte: <span className="font-medium text-ink-2">{selected.name}</span>
              </>
            ) : (
              "Nenhuma fonte escolhida"
            )}
          </p>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={onClose}
              className="border border-rule-2 bg-sheet px-4 py-2.5 text-[0.875rem] font-semibold text-ink transition-colors hover:border-rule-3 hover:bg-band [border-radius:var(--radius-sheet)]"
            >
              Cancelar
            </button>
            <button
              ref={confirmRef}
              type="button"
              disabled={!selected}
              onClick={() => {
                if (!selected) return;
                onConfirm({ ...settings, lastSourceId: selected.id }, selected, audio);
              }}
              className="inline-flex items-center justify-center gap-2 border border-signal bg-signal px-5 py-2.5 text-[0.875rem] font-semibold text-on-signal transition-colors hover:border-signal-2 hover:bg-signal-2 disabled:cursor-not-allowed disabled:opacity-50 [border-radius:var(--radius-sheet)]"
            >
              <MonitorUp size={17} strokeWidth={1.75} aria-hidden />
              Compartilhar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function TabButton({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "flex h-8 items-center gap-1.5 border px-3 text-[0.8125rem] font-medium transition-colors [border-radius:var(--radius-cell)]",
        active ? "border-signal-line bg-signal-wash text-signal" : "border-transparent text-ink-2 hover:bg-band hover:text-ink",
      )}
    >
      {children}
      <span className="font-mono text-[0.6875rem] text-ink-3">{count}</span>
    </button>
  );
}
