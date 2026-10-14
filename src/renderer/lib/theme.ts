import type { ThemePreference } from "@shared/ipc";

export const THEME_STORAGE_KEY = "myscreen-theme";

export function readThemePreference(): ThemePreference {
  try {
    const v = localStorage.getItem(THEME_STORAGE_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function systemDark(): boolean {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function effectiveTheme(pref: ThemePreference): "light" | "dark" {
  return pref === "system" ? (systemDark() ? "dark" : "light") : pref;
}

/**
 * Aplica o tema no documento e avisa o processo principal (a barra de título
 * nativa acompanha as cores da folha). Sem escolha, segue o Windows.
 */
export function applyTheme(pref: ThemePreference, animate = false): void {
  const root = document.documentElement;
  const eff = effectiveTheme(pref);
  if (animate) {
    root.classList.add("theme-switching");
    window.setTimeout(() => root.classList.remove("theme-switching"), 260);
  }
  if (eff === "dark") root.dataset.theme = "dark";
  else delete root.dataset.theme;
  window.myscreen?.app.setTheme(eff, pref);
}

export function setThemePreference(pref: ThemePreference): void {
  try {
    if (pref === "system") localStorage.removeItem(THEME_STORAGE_KEY);
    else localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Vale só para esta sessão.
  }
  applyTheme(pref, true);
  window.dispatchEvent(new CustomEvent("myscreen:theme", { detail: pref }));
}

/** Liga o tema na carga e acompanha o Windows quando não há escolha. */
export function bootTheme(): void {
  applyTheme(readThemePreference());
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (readThemePreference() === "system") applyTheme("system", true);
  });
}
