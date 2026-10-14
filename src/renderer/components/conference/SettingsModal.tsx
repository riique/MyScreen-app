
import { useEffect, useRef, useState } from "react";
import type { ScreenResolution } from "@shared/media";
import { CheckCell, Field, inputClass } from "@/components/sheet";

const TITLE_ID = "settings-modal-title";
const DESCRIPTION_ID = "settings-modal-desc";
const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export interface MediaSettings {
  screenFps: number;
  screenResolution: ScreenResolution;
  screenContentType: "motion" | "detail";
  systemAudio: boolean;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  autoGainControl: boolean;
  audioInputId?: string;
  videoInputId?: string;
  audioOutputId?: string;
}

interface DeviceSet {
  audioInputs: MediaDeviceInfo[];
  videoInputs: MediaDeviceInfo[];
  audioOutputs: MediaDeviceInfo[];
}

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  settings: MediaSettings;
  onApply: (patch: Partial<MediaSettings>) => void;
  devices: DeviceSet;
}

/**
 * Ajustar resolução, taxa e tipo de conteúdo com a faixa no ar não faz nada:
 * quem já está publicando continua na taxa antiga até parar. O fieldset fica
 * disabled e a folha diz isso, em vez de deixar a pessoa mexer num controle
 * que só vai valer na próxima vez.
 *
 * Este componente NÃO toca em track nenhuma. Ele emite o patch e quem aplica é
 * a sala — `applyConstraints` no microfone, `switchActiveDevice` nos
 * dispositivos. Um modal que também aplicasse seria o único lugar do app com
 * duas fontes de verdade para a mesma track.
 */
export function SettingsModal({
  open,
  onClose,
  settings,
  onApply,
  devices,
}: SettingsModalProps) {
  const [mounted, setMounted] = useState(false);
  const [canSelectAudioOutput, setCanSelectAudioOutput] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<Element | null>(null);
  // O trap precisa do `onClose` ATUAL sem se religar a cada render do pai: sem
  // isto, digitar no campo de apelido roubaria o foco de volta para o painel.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => setMounted(true), []);
  // No Chromium do Electron o `setSinkId` sempre existe: o seletor aparece sempre.
  useEffect(() => setCanSelectAudioOutput(true), []);

  useEffect(() => {
    if (!open) return;
    const panel = panelRef.current;
    previouslyFocused.current = document.activeElement;

    // `inert` nos irmãos: o conteúdo de fora da folha para de ser focável, e o
    // trap vira uma rede de segurança em vez do único mecanismo.
    const inerted: { node: Element; previous: string | null }[] = [];
    if (panel?.parentElement) {
      for (const sibling of Array.from(panel.parentElement.children)) {
        if (sibling === panel || !(sibling instanceof HTMLElement)) continue;
        inerted.push({ node: sibling, previous: sibling.getAttribute("inert") });
        sibling.setAttribute("inert", "");
      }
    }

    panel?.focus();

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;

      const root = panelRef.current;
      if (!root) return;
      const focusables = Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;

      if (active === root || !active || !root.contains(active)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      for (const entry of inerted) {
        if (entry.previous === null) entry.node.removeAttribute("inert");
        else entry.node.setAttribute("inert", entry.previous);
      }
      (previouslyFocused.current as HTMLElement | null)?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const content = (
    <div className="fixed inset-0 z-[100] flex items-end justify-center bg-scrim sm:items-center sm:p-6">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={TITLE_ID}
        aria-describedby={DESCRIPTION_ID}
        tabIndex={-1}
        className="max-h-[92dvh] w-full max-w-[46rem] overflow-y-auto border border-rule-2 bg-sheet shadow-overlay sm:[border-radius:var(--radius-sheet)]"
      >
        <div className="flex items-start justify-between gap-6 border-b border-rule px-5 py-4 sm:px-6">
          <div className="min-w-0">
            <h2
              id={TITLE_ID}
              className="text-[1.0625rem] font-semibold tracking-[-0.015em] text-ink"
            >
              Configurações de mídia
            </h2>
            <p id={DESCRIPTION_ID} className="mt-1 text-[0.8125rem] leading-[1.5] text-ink-3">
              Ajuste de transmissão, áudio e dispositivos
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Fechar configurações de mídia"
            className="shrink-0 border border-rule-2 px-2.5 py-1 text-[0.8125rem] text-ink-2 transition-colors hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]"
          >
            Concluído
          </button>
        </div>

        <div className="space-y-7 px-5 py-5 sm:px-6">
          <div>
            <h3 className="border-b border-rule pb-2 text-[0.875rem] font-semibold text-ink">
              Aprimoramentos de microfone
            </h3>
            <div className="mt-1">
              <CheckCell
                name="set-echo"
                checked={settings.echoCancellation}
                onChange={(v) => onApply({ echoCancellation: v })}
                label="Cancelamento de eco"
                note="Evita retorno de áudio dos alto-falantes"
              />
              <CheckCell
                name="set-noise"
                checked={settings.noiseSuppression}
                onChange={(v) => onApply({ noiseSuppression: v })}
                label="Supressão de ruído de fundo"
                note="Filtra digitação no teclado e barulhos ambientais"
              />
              <CheckCell
                name="set-agc"
                checked={settings.autoGainControl}
                onChange={(v) => onApply({ autoGainControl: v })}
                label="Ganho automático (AGC)"
                note="Nivela o volume da sua voz automaticamente"
              />
            </div>
          </div>

          <div>
            <h3 className="border-b border-rule pb-2 text-[0.875rem] font-semibold text-ink">
              Dispositivos conectados
            </h3>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <DeviceSelect
                id="set-mic"
                label="Microfone"
                devices={devices.audioInputs}
                fallback="Padrão do sistema"
                selectedId={settings.audioInputId}
                onSelect={(audioInputId) => onApply({ audioInputId })}
                emptyMessage="Nenhum microfone listado. Confira se o Windows libera o microfone em Configurações → Privacidade."
              />
              <DeviceSelect
                id="set-cam"
                label="Câmera"
                devices={devices.videoInputs}
                fallback="Padrão do sistema"
                selectedId={settings.videoInputId}
                onSelect={(videoInputId) => onApply({ videoInputId })}
                emptyMessage="Nenhuma câmera listada. Confira se o Windows libera a câmera em Configurações → Privacidade."
              />
              {canSelectAudioOutput ? (
                <DeviceSelect
                  id="set-out"
                  label="Saída de áudio (alto-falante)"
                  devices={devices.audioOutputs}
                  fallback="Padrão do sistema"
                  selectedId={settings.audioOutputId}
                  onSelect={(audioOutputId) => onApply({ audioOutputId })}
                  emptyMessage="Nenhum alto-falante listado. Confira os dispositivos de som do Windows."
                />
              ) : null}
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (!mounted || typeof document === "undefined") return content;
  // Sem portal: a sala pode estar em tela cheia, e tudo que sai do elemento
  // em tela cheia (como um filho do <body>) fica invisível.
  return content;
}

/**
 * Um dispositivo com `deviceId` vazio é um slot que o navegador ainda não
 * autorizou. O `<select>` mostra a contagem em vez de uma lista que parece
 * quebrada — e some depois de um clique, quando a permissão chega.
 */
function DeviceSelect({
  id,
  label,
  devices,
  fallback,
  selectedId,
  onSelect,
  emptyMessage,
}: {
  id: string;
  label: string;
  devices: MediaDeviceInfo[];
  fallback: string;
  selectedId?: string;
  onSelect: (deviceId: string | undefined) => void;
  emptyMessage: string;
}) {
  const selectable = devices.filter((d) => Boolean(d.deviceId?.trim()));
  const blocked = devices.length - selectable.length;
  const hintId = `${id}-hint`;

  return (
    <Field label={label} htmlFor={id}>
      <select
        id={id}
        value={selectedId ?? ""}
        onChange={(e) => onSelect(e.target.value === "" ? undefined : e.target.value)}
        aria-describedby={devices.length === 0 ? hintId : undefined}
        className={inputClass}
      >
        <option value="">{fallback}</option>
        {selectable.map((d) => (
          <option key={d.deviceId} value={d.deviceId}>
            {d.label || `${fallback} (${d.deviceId.slice(0, 5)})`}
          </option>
        ))}
        {blocked > 0 ? (
          <option value="" disabled>
            {blocked === 1
              ? `${fallback} (permissão não concedida)`
              : `${blocked} dispositivos sem permissão concedida`}
          </option>
        ) : null}
      </select>
      {devices.length === 0 ? (
        <p id={hintId} className="mt-2 text-[0.8125rem] leading-[1.5] text-ink-3">
          {emptyMessage}
        </p>
      ) : null}
    </Field>
  );
}
