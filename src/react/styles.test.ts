import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

// Ways the styles can fail. Each one is a case below.
// 1. A text and background pair is under 4.5:1, or a border or focus color is under 3:1 (WCAG 2.2 AA).
// 2. A control is under the 24 px minimum target size, or has no visible focus style.
// 3. The sheet loads a font, image, or file from another host (a CDN call).

const css = readFileSync(new URL("./panel.css", import.meta.url), "utf8");
const variables = Object.fromEntries([...css.matchAll(/--aa-([a-z-]+):\s*(#[0-9a-fA-F]{6});/g)].map((m) => [m[1] as string, m[2] as string]));

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
  test("reads the palette", () => {
    expect(Object.keys(variables).length).toBeGreaterThanOrEqual(12);
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
  ])("%s on %s is at least %s:1", (fg, bg, minimum) => {
    expect(contrast(variables[fg as string] as string, variables[bg as string] as string)).toBeGreaterThanOrEqual(minimum as number);
  });

  test("buttons meet the minimum target size, and focus is visible", () => {
    expect(css).toMatch(/\.aa-button \{[^}]*min-height: 2rem;[^}]*min-width: 2rem;/);
    expect(css).toMatch(/:focus-visible \{[^}]*outline: 3px solid var\(--aa-focus\)/);
  });

  test("loads nothing from another host", () => {
    expect(css).not.toMatch(/https?:|@import|@font-face|url\(/i);
  });
});
