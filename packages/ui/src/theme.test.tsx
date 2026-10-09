import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { EmbersThemeProvider, useEmbersTheme } from "./theme";

function Probe() {
  const { theme, setTheme } = useEmbersTheme();
  return (
    <button
      type="button"
      onClick={() => setTheme(theme === "light" ? "dark" : "light")}
    >
      {theme}
    </button>
  );
}

describe("EmbersThemeProvider", () => {
  it("defaults to dark, sets data-theme on <html>, and switches", () => {
    window.matchMedia ??= (query: string) =>
      ({
        matches: false,
        media: query,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList;
    render(
      <EmbersThemeProvider storageKey="test-theme">
        <Probe />
      </EmbersThemeProvider>,
    );
    const btn = screen.getByRole("button");
    expect(btn.textContent).toBe("dark");
    act(() => btn.click());
    expect(screen.getByRole("button").textContent).toBe("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });

  it("reads anything unexpected as dark", () => {
    function Bare() {
      return <span>{useEmbersTheme().theme}</span>;
    }
    render(<Bare />);
    expect(screen.getByText("dark")).toBeTruthy();
  });
});

describe("useEmbersTheme during server render", () => {
  it("reports the default so hydration matches, whatever is stored", async () => {
    const { renderToString } = await import("react-dom/server");
    localStorage.setItem("embers-theme", "light");
    function Bare() {
      return <span>{useEmbersTheme().theme}</span>;
    }
    expect(
      renderToString(
        <EmbersThemeProvider>
          <Bare />
        </EmbersThemeProvider>,
      ),
    ).toContain("dark");
    localStorage.removeItem("embers-theme");
  });
});
