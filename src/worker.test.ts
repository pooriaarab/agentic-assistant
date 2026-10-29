import { describe, expect, test } from "vitest";
import worker from "./demo.js";
import { DEMO_PAGE } from "./demo-page.js";
import { createStaticTokenAuth } from "./static-auth.js";

// Ways the demo Worker can fail.
// 1. A call with no key, a wrong key, or no tokens configured gets in.
// 2. A short or malformed token map is accepted, or a token entry with a kind signs in as a person.
// 3. Chat with no model key answers with made-up output instead of "not_configured".
// 4. An unsigned caller learns the model state, or a signed one gets a 500.
// 5. The page loads from outside, or lacks the AI-generated label.
// 6. A hard-coded hex color returns to the page style, or the page ignores the color scheme.

const TOKEN = "t".repeat(40);
const env = (extra: Record<string, string> = {}) => ({ ASSISTANT_TOKENS: JSON.stringify({ [TOKEN]: { id: "ana", scopes: ["demo:read"] } }), ...extra });
const call = (path: string, init: RequestInit = {}, e: object = env()) => worker.fetch(new Request(`https://demo.test${path}`, init), e);
const bearer = { authorization: `Bearer ${TOKEN}` };

describe("demo worker", () => {
  test("GET /health reports ok", async () => {
    const response = await call("/health", {}, { PACK_NAME: "probe" });
    expect(await response.json()).toMatchObject({ ok: true, pack: "probe" });
  });
  test("the page is self-contained and labels the answer", async () => {
    const response = await call("/");
    const html = await response.text();
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(html).toContain("AI-generated");
    expect(html).not.toMatch(/https?:\/\//);
  });
  test("the page style has no hex colors and follows the color scheme", () => {
    const style = DEMO_PAGE.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    expect(style).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(style).toContain("color-scheme:light dark");
  });
  test("a call with no key, a wrong key, or no tokens is a 401", async () => {
    expect((await call("/api/v1/tools")).status).toBe(401);
    expect((await call("/api/v1/tools", { headers: { authorization: `Bearer ${"x".repeat(40)}` } })).status).toBe(401);
    expect((await call("/api/v1/tools", { headers: bearer }, {})).status).toBe(401);
  });
  test("a good key without the route scope is a 403 on every route", async () => {
    const other = { ASSISTANT_TOKENS: JSON.stringify({ [TOKEN]: { id: "ana", scopes: ["other:read"] } }) };
    expect((await call("/api/v1/tools", { headers: bearer }, other)).status).toBe(403);
    expect((await call("/api/v1/approvals", { headers: bearer }, other)).status).toBe(403);
    const chat = await call("/api/v1/chat", { method: "POST", headers: bearer, body: JSON.stringify({ message: "hi" }) }, other);
    expect(chat.status).toBe(403);
    expect(JSON.stringify(await chat.json())).not.toContain(TOKEN);
  });
  test("a token map with one id twice is refused", async () => {
    await expect(createStaticTokenAuth({ [TOKEN]: { id: "a", scopes: [] }, [`${TOKEN}2`]: { id: "a", scopes: ["demo:read"] } })).rejects.toThrow(/own id/);
  });
  test("a good key lists the demo tool", async () => {
    const response = await call("/api/v1/tools", { headers: bearer });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ tools: [{ name: "demo_time", risk: "safe" }] });
  });
  test("chat with no model key answers not_configured", async () => {
    const response = await call("/api/v1/chat", { method: "POST", headers: bearer, body: JSON.stringify({ message: "hi" }) });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "not_configured" });
  });
  test("a key with no endpoint is still not_configured", async () => {
    const response = await call("/api/v1/chat", { method: "POST", headers: bearer, body: JSON.stringify({ message: "hi" }) }, env({ MODEL_KEY: "k" }));
    expect(response.status).toBe(503);
  });
  test("chat with no sign-in is a 401, not a model hint", async () => {
    const response = await call("/api/v1/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) });
    expect(response.status).toBe(401);
  });
  test("bad token maps stop the API", async () => {
    expect((await call("/api/v1/tools", { headers: bearer }, { ASSISTANT_TOKENS: JSON.stringify({ short: { id: "a", scopes: [] } }) })).status).toBe(503);
    expect((await call("/api/v1/tools", { headers: bearer }, { ASSISTANT_TOKENS: "not json" })).status).toBe(503);
    await expect(createStaticTokenAuth({ [TOKEN]: { id: "", scopes: [] } })).rejects.toThrow();
    await expect(createStaticTokenAuth({ [`${TOKEN} x`]: { id: "a", scopes: [] } })).rejects.toThrow(/white space/);
    await expect(createStaticTokenAuth({ [`${TOKEN}.x`]: { id: "a", scopes: [] } })).rejects.toThrow(/A-Z a-z 0-9/);
    await expect(createStaticTokenAuth({ ["a".repeat(513)]: { id: "a", scopes: [] } })).rejects.toThrow(/512/);
    await expect(createStaticTokenAuth({ [TOKEN]: { id: "a", scopes: ["not a scope"] } })).rejects.toThrow();
    // A kind in the entry would be dropped and the caller would sign in as a person.
    await expect(createStaticTokenAuth({ [TOKEN]: { id: "bot", kind: "agent", scopes: [] } as never })).rejects.toThrow(/only an id and scopes/);
  });
  test("unknown routes return 404", async () => {
    expect((await call("/nowhere")).status).toBe(404);
  });
});
