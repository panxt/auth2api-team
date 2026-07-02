import { useEffect, useState } from "react";

export type ThemePref = "light" | "dark" | "system";

const KEY = "theme";
const mql = () => window.matchMedia("(prefers-color-scheme: dark)");

function readPref(): ThemePref {
  const v = localStorage.getItem(KEY);
  return v === "light" || v === "dark" ? v : "system";
}

/** Resolve a preference to the effective dark/light and apply it to <html>. */
function apply(pref: ThemePref): void {
  const dark = pref === "dark" || (pref === "system" && mql().matches);
  document.documentElement.classList.toggle("dark", dark);
}

/**
 * Theme preference hook: light / dark / follow-system. Persists to
 * localStorage and — while on "system" — tracks OS changes live. The pre-paint
 * script in index.html applies the same logic before React mounts (no flash).
 */
export function useTheme(): {
  pref: ThemePref;
  setPref: (p: ThemePref) => void;
  cycle: () => void;
} {
  const [pref, setPrefState] = useState<ThemePref>(readPref);

  const setPref = (p: ThemePref) => {
    setPrefState(p);
    if (p === "system") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, p);
    apply(p);
  };

  // Follow the OS while on "system".
  useEffect(() => {
    if (pref !== "system") return;
    const m = mql();
    const onChange = () => apply("system");
    m.addEventListener("change", onChange);
    return () => m.removeEventListener("change", onChange);
  }, [pref]);

  const order: ThemePref[] = ["system", "light", "dark"];
  const cycle = () => setPref(order[(order.indexOf(pref) + 1) % order.length]);

  return { pref, setPref, cycle };
}
