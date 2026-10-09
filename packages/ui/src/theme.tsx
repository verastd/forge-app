/**
 * Theme for the Embers surface (README "State management": light | dark |
 * system, persisted with next-themes, applied as `data-theme` on <html>).
 * The token stylesheet reads `:root[data-theme="dark"] .em-root`, so the
 * attribute only changes Embers surfaces; color-scheme is set on .em-root
 * by the stylesheet, not on <html>, so other pages of a host app keep theirs.
 * Default is dark: "a dark trading terminal warmed by embers".
 */
import { ThemeProvider, useTheme } from "next-themes";
import { useSyncExternalStore } from "react";
import type { ReactNode } from "react";

export type ThemeChoice = "light" | "dark" | "system";

export const THEME_STORAGE_KEY = "embers-theme";

export function EmbersThemeProvider({
  children,
  storageKey = THEME_STORAGE_KEY,
}: {
  children: ReactNode;
  storageKey?: string;
}) {
  return (
    <ThemeProvider
      attribute="data-theme"
      defaultTheme="dark"
      enableSystem
      enableColorScheme={false}
      disableTransitionOnChange
      storageKey={storageKey}
      themes={["light", "dark"]}
    >
      {children}
    </ThemeProvider>
  );
}

const noop = (): (() => void) => () => undefined;

/**
 * The chosen theme (light | dark | system) and a setter, for the TopBar theme
 * Segment. The stored choice only exists in the browser, so the server render
 * and hydration report the default; the real choice follows right after
 * hydration (no mismatch warning, no flash: the page colors come from the
 * `data-theme` next-themes sets before paint).
 */
export function useEmbersTheme(): {
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
} {
  const { theme, setTheme } = useTheme();
  const hydrated = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const choice: ThemeChoice =
    hydrated && (theme === "light" || theme === "dark" || theme === "system")
      ? theme
      : "dark";
  return { theme: choice, setTheme };
}
