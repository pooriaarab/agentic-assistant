import { describe, expect, test } from "vitest";
import worker from "./worker.js";

describe("worker", () => {
  test("GET /health reports ok", async () => {
    const response = await worker.fetch(new Request("https://pack.test/health"), { PACK_NAME: "probe" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, pack: "probe" });
  });
  test("the sample Worker has no API and says so", async () => {
    const response = await worker.fetch(new Request("https://pack.test/api/v1/tools"), {});
    expect(response.status).toBe(503);
  });
  test("unknown routes return 404", async () => {
    expect((await worker.fetch(new Request("https://pack.test/nowhere"), {})).status).toBe(404);
  });
});
