import { useSyncExternalStore } from "react";

/**
 * Light / dark / follow-the-system. The choice is a per-browser convenience kept in
 * localStorage (every access is guarded: it can throw in private windows). The class is
 * applied before first paint by /theme-init.js (an external file, because the CSP allows
 * no inline scripts) and kept in sync here.
 */
export type ThemePreference = "system" | "light" | "dark";
const KEY = "tmg-theme";
const listeners = new Set<() => void>();

function read(): ThemePreference {
  try {
    const v = localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

const systemDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

export function applyTheme(pref: ThemePreference = read()): void {
  document.documentElement.classList.toggle("dark", pref === "dark" || (pref === "system" && systemDark()));
}

export function setTheme(pref: ThemePreference): void {
  try {
    if (pref === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, pref);
  } catch {
    /* keep working for this session without storage */
  }
  applyTheme(pref);
  listeners.forEach((l) => l());
}

let watching = false;
function subscribe(cb: () => void) {
  listeners.add(cb);
  if (!watching) {
    watching = true;
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
      if (read() === "system") applyTheme("system");
    });
  }
  return () => listeners.delete(cb);
}

export function useTheme(): { preference: ThemePreference; setPreference: (p: ThemePreference) => void } {
  const preference = useSyncExternalStore(subscribe, read, () => "system" as ThemePreference);
  return { preference, setPreference: setTheme };
}
