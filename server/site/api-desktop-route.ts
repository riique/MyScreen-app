// Copiar para MyScreen/src/app/api/desktop/route.ts (opcional).
//
// O app de Windows consulta esta rota na home. Se a versão dele for menor que
// DESKTOP_MIN_VERSION, "Criar" e "Entrar" ficam bloqueados até atualizar.
// Sem a variável, `minVersion` é null e nada é exigido.
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export function GET() {
  const raw = process.env.DESKTOP_MIN_VERSION?.trim() ?? "";
  const minVersion = /^\d+\.\d+\.\d+$/.test(raw) ? raw : null;
  return NextResponse.json({ minVersion }, { headers: { "Cache-Control": "no-store" } });
}
