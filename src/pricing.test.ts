import { describe, expect, test } from "vitest";
import { AnthropicProvider, KNOWN_PRICING, PRICING_CHECKED_ON } from "./providers/anthropic.js";

const DAY_MS = 86_400_000;
const MAX_AGE_DAYS = 120;

/** Days from the check date to `now`. Anything but a plain date gives NaN. */
function ageInDays(checkedOn: string, now: number): number {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(checkedOn)) return Number.NaN;
  const start = Date.parse(`${checkedOn}T00:00:00Z`);
  // Date.parse rolls 2026-02-31 over to March, so the date must print back as it was written.
  if (!Number.isFinite(start) || new Date(start).toISOString().slice(0, 10) !== checkedOn) return Number.NaN;
  return (now - start) / DAY_MS;
}

describe("price table", () => {
  test("was checked in the last 120 days", () => {
    const age = ageInDays(PRICING_CHECKED_ON, Date.now());
    // A stale table fails here. Compare the prices with the published table, then update the date.
    expect(age, `prices were checked on ${PRICING_CHECKED_ON}`).toBeLessThanOrEqual(MAX_AGE_DAYS);
  });

  test("the check date is a real date that is not in the future", () => {
    const age = ageInDays(PRICING_CHECKED_ON, Date.now());
    expect(Number.isNaN(age)).toBe(false);
    expect(age).toBeGreaterThanOrEqual(-1);
  });

  test("the age rule rejects an old date and a bad date", () => {
    const now = Date.parse("2026-10-29T00:00:00Z");
    expect(ageInDays("2026-06-01", now)).toBeGreaterThan(MAX_AGE_DAYS);
    expect(ageInDays("2026-07-01", now)).toBeLessThanOrEqual(MAX_AGE_DAYS);
    expect(Number.isNaN(ageInDays("last week", now))).toBe(true);
    expect(Number.isNaN(ageInDays("2026-02-31", now))).toBe(true);
    expect(Number.isNaN(ageInDays("2026-13-45", now))).toBe(true);
  });

  test("the table cannot be changed at run time", () => {
    expect(Object.isFrozen(KNOWN_PRICING)).toBe(true);
    for (const price of Object.values(KNOWN_PRICING)) expect(Object.isFrozen(price)).toBe(true);
  });

  test("a model whose price depends on the prompt size has no single built-in rate", () => {
    expect(Object.keys(KNOWN_PRICING)).not.toContain("claude-haiku-5-5");
    expect(() => new AnthropicProvider({ model: "claude-haiku-5-5", baseUrl: "https://eu.example.org", apiKey: "k".repeat(20) }).pricing).not.toThrow();
    expect(new AnthropicProvider({ model: "claude-haiku-5-5", baseUrl: "https://eu.example.org", apiKey: "k".repeat(20) }).pricing).toBeUndefined();
  });

  test("every price is a finite number of 0 or more", () => {
    for (const price of Object.values(KNOWN_PRICING)) {
      expect(Number.isFinite(price.inputPerMTok) && price.inputPerMTok >= 0).toBe(true);
      expect(Number.isFinite(price.outputPerMTok) && price.outputPerMTok >= 0).toBe(true);
    }
  });
});
