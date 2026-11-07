import { useEffect, useRef, useState } from "react";
import { contentRect, toNormalized } from "@shared/remote/geometry";
import type { RemoteViewer, ViewerState } from "./useRemoteControlViewer";

type View = NonNullable<Extract<ViewerState, { phase: "active" }>["adminView"]>;

export function SecureDesktop({
  view, onClick, frame,
}: {
  view: View;
  onClick: RemoteViewer["adminClick"];
  frame: Blob | null;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const canvas = ref.current;
    if (!frame || !canvas) return;
    let cancelled = false;
    void createImageBitmap(frame).then((image) => {
      try {
        if (cancelled || image.width < 1 || image.width > 1024 || image.height < 1 || image.height > 768) return;
        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");
        if (context) {
          context.drawImage(image, 0, 0);
          setReady(true);
        }
      } finally {
        image.close();
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [frame]);

  if (view.desktop === "normal") return null;
  return (
    <div className="absolute inset-0 z-[5] flex items-center justify-center bg-monitor text-white">
      {view.desktop === "prompt" ? (
        <canvas
          ref={ref}
          aria-label="Aviso do Controle de Conta de Usuário do Windows"
          className="h-full w-full object-contain"
          onClick={(event) => {
            const canvas = event.currentTarget;
            if (!ready) return;
            const bounds = canvas.getBoundingClientRect();
            const fit = contentRect(bounds.width, bounds.height, canvas.width, canvas.height);
            const point = toNormalized(event.clientX - bounds.x, event.clientY - bounds.y, fit);
            if (point) onClick(view.generation, ...point);
          }}
        />
      ) : (
        <p role="status" className="px-4 text-center text-sm">O Windows abriu uma tela protegida. Aguardando o aviso ou a resposta no PC remoto.</p>
      )}
      {view.desktop === "prompt" && !ready ? (
        <p role="status" className="pointer-events-none absolute px-4 text-center text-sm">Abrindo o aviso do Windows…</p>
      ) : null}
    </div>
  );
}
