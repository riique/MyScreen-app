import { useEffect, useRef, useState } from "react";
import type { AppSettings, ThemePreference, UpdateStatus } from "@shared/ipc";
import { CheckCell, ChoiceRow, Field, inputClass } from "@/components/sheet";
import { readThemePreference, setThemePreference } from "@/lib/theme";
import { setServerUrlCache } from "@/platform";

/**
 * Configurações do app: servidor (para quem hospeda o próprio MyScreen), tema,
 * atalhos globais e atualizações. Fica na home: trocar de servidor no meio de uma sala não
 * faz sentido.
 */
export function AppSettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [server, setServer] = useState("");
  const [serverError, setServerError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    setSaved(false);
    setServerError(null);
    setTheme(readThemePreference());
    void window.myscreen.settings.get().then((s) => {
      setSettings(s);
      setServer(s.serverUrl);
    });
    panelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  async function saveServer(event: React.FormEvent) {
    event.preventDefault();
    const r = await window.myscreen.settings.set({ serverUrl: server });
    if (!r.ok) {
      setServerError(r.error);
      return;
    }
    setSettings(r.data);
    setServer(r.data.serverUrl);
    setServerUrlCache(r.data.serverUrl);
    setServerError(null);
    setSaved(true);
  }

  async function toggleShortcuts(on: boolean) {
    const r = await window.myscreen.settings.set({ shortcutsEnabled: on });
    if (r.ok) setSettings(r.data);
  }

  async function toggleAutoDownload(on: boolean) {
    const r = await window.myscreen.settings.set({ autoDownloadUpdates: on });
    if (r.ok) setSettings(r.data);
  }

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-scrim p-6"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="app-settings-title"
        className="max-h-[90vh] w-full max-w-[38rem] overflow-y-auto border border-rule-2 bg-sheet shadow-overlay [border-radius:var(--radius-sheet)]"
      >
        <div className="flex items-start justify-between gap-6 border-b border-rule px-6 py-4">
          <h2 id="app-settings-title" className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-ink">
            Configurações
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 border border-rule-2 px-2.5 py-1 text-[0.8125rem] text-ink-2 transition-colors hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]"
          >
            Concluído
          </button>
        </div>

        <div className="space-y-7 px-6 py-5">
          <form onSubmit={saveServer}>
            <Field
              label="Servidor"
              htmlFor="set-server"
              error={serverError ?? undefined}
              hint={
                saved
                  ? "Salvo. As próximas salas usam este servidor."
                  : "O endereço do seu MyScreen (o mesmo do site). Quem hospeda o próprio servidor troca aqui."
              }
            >
              <div className="flex gap-2">
                <input
                  id="set-server"
                  value={server}
                  onChange={(e) => {
                    setServer(e.target.value);
                    setSaved(false);
                  }}
                  spellCheck={false}
                  autoComplete="off"
                  className={`${inputClass} font-mono`}
                />
                <button
                  type="submit"
                  disabled={!settings || server === settings.serverUrl}
                  className="shrink-0 border border-signal bg-signal px-4 text-[0.8125rem] font-semibold text-on-signal transition-colors hover:bg-signal-2 disabled:opacity-40 [border-radius:var(--radius-cell)]"
                >
                  Salvar
                </button>
              </div>
            </Field>
          </form>

          <div>
            <span className="label-col">Tema</span>
            <ChoiceRow
              className="mt-2"
              name="set-theme"
              ariaLabel="Tema"
              value={theme}
              onChange={(v) => {
                const pref = v as ThemePreference;
                setTheme(pref);
                setThemePreference(pref);
              }}
              options={[
                { value: "system", label: "Seguir o Windows" },
                { value: "light", label: "Claro" },
                { value: "dark", label: "Escuro" },
              ]}
            />
          </div>

          <div>
            <h3 className="border-b border-rule pb-2 text-[0.875rem] font-semibold text-ink">Atalhos globais</h3>
            <CheckCell
              name="set-shortcuts"
              checked={settings?.shortcutsEnabled ?? true}
              disabled={!settings}
              onChange={(v) => void toggleShortcuts(v)}
              label="Ligar atalhos durante a chamada"
              note="Funcionam com o app fora de foco: Ctrl+Shift+M (microfone), Ctrl+Shift+V (câmera), Ctrl+Shift+S (parar a tela)."
            />
          </div>

          <div>
            <h3 className="border-b border-rule pb-2 text-[0.875rem] font-semibold text-ink">Atualizações</h3>
            <UpdatesRow />
            <CheckCell
              name="set-auto-update"
              checked={settings?.autoDownloadUpdates ?? true}
              disabled={!settings}
              onChange={(v) => void toggleAutoDownload(v)}
              label="Baixar atualizações automaticamente"
              note="Baixa em segundo plano assim que sai uma versão nova. Instalar continua sendo com você: nunca no meio de uma chamada."
            />
          </div>
        </div>
      </div>
    </div>
  );
}

/** Versão instalada, o estado da atualização e o botão que cabe a cada estado. */
function UpdatesRow() {
  const [version, setVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });

  useEffect(() => {
    void window.myscreen.app.info().then((i) => setVersion(i.version));
    void window.myscreen.updates.status().then(setStatus);
    return window.myscreen.updates.onStatus(setStatus);
  }, []);

  const text =
    status.state === "checking"
      ? "Procurando versão nova…"
      : status.state === "uptodate"
        ? "Você está na versão mais recente."
        : status.state === "available"
          ? `A versão ${status.version} está disponível.`
          : status.state === "downloading"
            ? `Baixando atualização… ${status.percent}%`
            : status.state === "ready"
              ? `A versão ${status.version} foi baixada e está pronta.`
              : status.state === "error"
                ? status.message
                : "Procure versão nova quando quiser.";

  const button =
    status.state === "available"
      ? { label: "Baixar", onClick: () => window.myscreen.updates.download() }
      : status.state === "ready"
        ? { label: "Reiniciar e atualizar", onClick: () => window.myscreen.updates.install() }
        : {
            label: "Verificar atualizações",
            onClick: () => window.myscreen.updates.check(),
            disabled: status.state === "checking" || status.state === "downloading",
          };
  const primary = status.state === "available" || status.state === "ready";

  return (
    <div className="flex items-center justify-between gap-4 border-b border-rule px-5 py-3.5">
      <div className="min-w-0">
        <p className="text-[0.875rem] text-ink">
          MyScreen <span className="font-mono text-[0.8125rem] text-ink-2">{version ? `v${version}` : ""}</span>
        </p>
        <p
          aria-live="polite"
          className={`mt-0.5 text-[0.8125rem] leading-[1.5] ${status.state === "error" ? "text-warn" : "text-ink-3"}`}
        >
          {text}
        </p>
      </div>
      <button
        type="button"
        onClick={button.onClick}
        disabled={"disabled" in button ? button.disabled : false}
        className={
          primary
            ? "shrink-0 border border-signal bg-signal px-4 py-2 text-[0.8125rem] font-semibold text-on-signal transition-colors hover:bg-signal-2 [border-radius:var(--radius-cell)]"
            : "shrink-0 border border-rule-2 bg-sheet px-4 py-2 text-[0.8125rem] font-semibold text-ink transition-colors hover:border-rule-3 hover:bg-band disabled:opacity-45 [border-radius:var(--radius-cell)]"
        }
      >
        {button.label}
      </button>
    </div>
  );
}
