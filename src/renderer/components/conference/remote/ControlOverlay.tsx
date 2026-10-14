import { useEffect, useRef } from "react";
import { contentRect, toNormalized } from "@shared/remote/geometry";
import { scancodeFor } from "@shared/remote/keymap";
import { WheelAccumulator, type InputEvent } from "@shared/remote/protocol";

/**
 * Camada transparente sobre o vídeo da tela controlada. Mouse sempre; teclado
 * quando focada (clicar no quadro foca). O cursor local continua visível — o
 * de verdade vem no vídeo, como no AnyDesk.
 *
 * Coordenadas relativas ao QUADRO DE VÍDEO, recalculadas a cada evento (a
 * resolução pode mudar no meio). Clique na tarja preta não sai.
 */
export function ControlOverlay({ send, label }: { send: (ev: InputEvent) => void; label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const out = (ev: InputEvent) => sendRef.current(ev);
    const buttons = new Set<number>();
    const keys = new Set<string>();
    const wheel = new WheelAccumulator();
    let pendingMove: [number, number] | null = null;
    let raf = 0;

    const point = (e: { clientX: number; clientY: number }, clamp: boolean) => {
      const video = el.parentElement?.querySelector("video");
      if (!video || !video.videoWidth) return null;
      const box = el.getBoundingClientRect();
      const r = contentRect(box.width, box.height, video.videoWidth, video.videoHeight);
      return toNormalized(e.clientX - box.left, e.clientY - box.top, r, clamp);
    };

    const flushMove = () => {
      raf = 0;
      if (!pendingMove) return;
      const [x, y] = pendingMove;
      pendingMove = null;
      out({ t: "move", x, y });
    };

    // Um MOVE por quadro de tela, no máximo: só a última posição importa.
    const onMove = (e: PointerEvent) => {
      const p = point(e, buttons.size > 0);
      if (!p) return;
      pendingMove = p;
      if (!raf) raf = requestAnimationFrame(flushMove);
    };

    const onDown = (e: PointerEvent) => {
      if (e.button < 0 || e.button > 4) return;
      e.preventDefault();
      e.stopPropagation();
      el.focus({ preventScroll: true });
      const p = point(e, false);
      if (!p) return;
      el.setPointerCapture(e.pointerId);
      pendingMove = null;
      buttons.add(e.button);
      out({ t: "button", button: e.button, down: true, x: p[0], y: p[1] });
    };

    const onUp = (e: PointerEvent) => {
      if (!buttons.has(e.button)) return;
      e.preventDefault();
      e.stopPropagation();
      const p = point(e, true) ?? [0, 0];
      buttons.delete(e.button);
      out({ t: "button", button: e.button, down: false, x: p[0], y: p[1] });
      if (buttons.size === 0 && el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const p = point(e, false);
      if (!p) return;
      const { dx, dy } = wheel.add(e.deltaX, e.deltaY, e.deltaMode);
      if (dx === 0 && dy === 0) return;
      out({ t: "wheel", dx, dy, x: p[0], y: p[1] });
    };

    const onKey = (e: KeyboardEvent) => {
      const scancode = scancodeFor(e.code);
      if (scancode === null) return;
      e.preventDefault();
      e.stopPropagation();
      const down = e.type === "keydown";
      if (down) {
        keys.add(e.code);
      } else if (!keys.delete(e.code)) {
        return;
      }
      // A repetição vai junto: o Windows não repete tecla injetada sozinho.
      out({ t: "key", scancode, down });
    };

    // Perdeu o foco ou o ponteiro: nada pode ficar apertado do outro lado.
    const releaseAll = () => {
      if (buttons.size === 0 && keys.size === 0) return;
      buttons.clear();
      keys.clear();
      out({ t: "release" });
    };
    // Captura perdida com botão apertado (janela trocou, alerta do sistema): solta.
    const onLostCapture = () => {
      if (buttons.size > 0) releaseAll();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") releaseAll();
    };
    const stop = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
    };

    // Tela cheia com Keyboard Lock: Alt+Tab, Windows e Esc vão para o PC
    // remoto. Segurar Esc sai da tela cheia (padrão do Chromium).
    type KeyboardLock = { lock?: (codes?: string[]) => Promise<void>; unlock?: () => void };
    const keyboard = (navigator as Navigator & { keyboard?: KeyboardLock }).keyboard;
    const onFullscreen = () => {
      const fs = document.fullscreenElement;
      if (fs && fs.contains(el)) {
        el.focus({ preventScroll: true });
        void keyboard?.lock?.().catch(() => {});
      } else {
        keyboard?.unlock?.();
      }
    };

    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", releaseAll);
    el.addEventListener("lostpointercapture", onLostCapture);
    el.addEventListener("wheel", onWheel, { passive: false });
    el.addEventListener("keydown", onKey);
    el.addEventListener("keyup", onKey);
    el.addEventListener("blur", releaseAll);
    el.addEventListener("contextmenu", stop);
    el.addEventListener("dblclick", stop);
    el.addEventListener("auxclick", stop);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    document.addEventListener("fullscreenchange", onFullscreen);
    onFullscreen();
    el.focus({ preventScroll: true });

    return () => {
      if (raf) cancelAnimationFrame(raf);
      releaseAll();
      keyboard?.unlock?.();
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", releaseAll);
      el.removeEventListener("lostpointercapture", onLostCapture);
      el.removeEventListener("wheel", onWheel);
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("keyup", onKey);
      el.removeEventListener("blur", releaseAll);
      el.removeEventListener("contextmenu", stop);
      el.removeEventListener("dblclick", stop);
      el.removeEventListener("auxclick", stop);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
      document.removeEventListener("fullscreenchange", onFullscreen);
    };
  }, []);

  return (
    <div
      ref={ref}
      tabIndex={0}
      role="application"
      aria-label={label}
      className="absolute inset-0 z-[5] cursor-default touch-none outline-none"
    />
  );
}
