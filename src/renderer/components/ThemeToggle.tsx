import { Monitor, Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { ThemePreference } from "@shared/ipc";
import { readThemePreference, setThemePreference } from "@/lib/theme";

const NEXT: Record<ThemePreference, ThemePreference> = { system: "light", light: "dark", dark: "system" };
const LABEL: Record<ThemePreference, string> = {
  system: "Tema: seguir o Windows",
  light: "Tema: claro",
  dark: "Tema: escuro",
};

/**
 * Três estados em ciclo: seguir o Windows (padrão), claro, escuro. Mais de um
 * botão pode estar montado; todos seguem o evento, não o próprio clique.
 */
export function ThemeToggle() {
  const [pref, setPref] = useState<ThemePreference>(readThemePreference);

  useEffect(() => {
    const onChange = (e: Event) => setPref((e as CustomEvent<ThemePreference>).detail);
    window.addEventListener("myscreen:theme", onChange);
    return () => window.removeEventListener("myscreen:theme", onChange);
  }, []);

  const Icon = pref === "system" ? Monitor : pref === "dark" ? Moon : Sun;
  const label = `${LABEL[pref]} (clique para trocar)`;

  return (
    <button
      type="button"
      onClick={() => setThemePreference(NEXT[pref])}
      aria-label={label}
      title={label}
      className="relative inline-flex size-8 shrink-0 items-center justify-center border border-transparent text-ink-2 transition-colors hover:border-rule hover:bg-band hover:text-ink [border-radius:var(--radius-cell)]"
    >
      <Icon aria-hidden className="size-[1.0625rem]" strokeWidth={1.75} />
    </button>
  );
}
