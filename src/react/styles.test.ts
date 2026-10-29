import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, test } from "vitest";

// Ways the styles can fail. Each one is a case below.
// 1. A text and background pair is under 4.5:1, or a border or focus color is under 3:1 (WCAG 2.2 AA).
// 2. A control is under the 24 px minimum target size, or has no visible focus style.
// 3. The sheet loads a font, image, or file from another host (a CDN call).
// 4. The sheet holds a hard-coded color, or names a token that agentic-design does not define.
// 5. The tokens give a pair that is under the minimum in the dark theme.

const css = readFileSync(new URL("./panel.css", import.meta.url), "utf8");
const tokenCss = readFileSync(createRequire(import.meta.url).resolve("agentic-design/tokens.css"), "utf8");
const mapping = Object.fromEntries([...css.matchAll(/--aa-([a-z-]+):\s*var\(--ad-color-([a-z-]+), [A-Za-z]+\);/g)].map((m) => [m[1] as string, m[2] as string]));

/** The colors in the first block of tokens.css whose selector holds `selector`. */
function theme(selector: string): Record<string, string> {
  const start = tokenCss.indexOf(selector);
  if (start < 0) throw new Error(`tokens.css has no block for ${selector}`);
  const body = tokenCss.slice(tokenCss.indexOf("{", start) + 1, tokenCss.indexOf("}", start));
  return Object.fromEntries([...body.matchAll(/--ad-color-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1] as string, m[2] as string]));
}
const themes = { light: theme('[data-theme="light"]'), dark: theme('[data-theme="dark"]'), os_dark: theme(":root:not([data-theme])") };
const variablesFor = (name: keyof typeof themes) => Object.fromEntries(Object.entries(mapping).map(([key, token]) => [key, themes[name][token] as string]));

function luminance(hex: string): number {
  const channel = (i: number) => {
    const value = Number.parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe("panel styles", () => {
  test("reads the palette from agentic-design tokens, with no hex color of its own", () => {
    expect(Object.keys(mapping)).toHaveLength(13);
    for (const name of Object.keys(themes) as (keyof typeof themes)[]) {
      for (const [key, value] of Object.entries(variablesFor(name))) expect(value, `${name} ${key}`).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(themes.dark).not.toEqual(themes.light);
    expect(themes.os_dark).toEqual(themes.dark);
  });

  test.each([
    ["fg", "bg", 4.5],
    ["fg", "card-bg", 4.5],
    ["muted", "bg", 4.5],
    ["muted", "card-bg", 4.5],
    ["machine-fg", "machine-bg", 4.5],
    ["accent-fg", "accent", 4.5],
    ["warn-fg", "warn-bg", 4.5],
    ["danger", "bg", 4.5],
    ["border", "bg", 3],
    ["border", "card-bg", 3],
    ["accent", "bg", 3],
    ["focus", "bg", 3],
    ["focus", "card-bg", 3],
    ["focus", "warn-bg", 3],
    ["danger", "bg", 3],
    ["warn-fg", "bg", 3],
  ])("%s on %s is at least %s:1 in light, dark, and OS dark", (fg, bg, minimum) => {
    for (const name of Object.keys(themes) as (keyof typeof themes)[]) {
      const variables = variablesFor(name);
      expect(contrast(variables[fg as string] as string, variables[bg as string] as string), name).toBeGreaterThanOrEqual(minimum as number);
    }
  });

  test("buttons meet the minimum target size, and focus is visible", () => {
    expect(css).toMatch(/\.aa-button \{[^}]*min-height: 2rem;[^}]*min-width: 2rem;/);
    expect(css).toMatch(/:focus-visible \{[^}]*outline: 3px solid var\(--aa-focus\)/);
  });

  test("loads nothing from another host", () => {
    expect(css).not.toMatch(/https?:|@import|@font-face|url\(/i);
  });
});
