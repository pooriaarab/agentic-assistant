import Ajv2020Module from "ajv/dist/2020.js";
import { describe, expect, test } from "vitest";
import { compileFallback } from "./schema-fallback.js";

// Ways the checker can fail. Each one is a case below, judged against Ajv on the same input.
// 1. A wrong type, a missing required name, or an extra name passes.
// 2. A bound, an enum, a const, or a list rule is ignored.
// 3. A nested or branching (anyOf, oneOf, allOf) rule is skipped.
// 4. A schema with a keyword the checker cannot enforce is accepted, so input passes unchecked.
// 5. A name like "__proto__" counts as present, or a deep input crashes the host.

const Ajv2020 = Ajv2020Module.default;
const ajv = new Ajv2020({ strict: false, logger: false });

const schema = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 5 },
    n: { type: "integer", minimum: 0, exclusiveMaximum: 10 },
    kind: { enum: ["a", "b"] },
    tags: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 2, uniqueItems: true },
    either: { anyOf: [{ type: "string" }, { type: "number" }] },
    one: { oneOf: [{ type: "number", minimum: 5 }, { type: "number", maximum: 6 }] },
    all: { allOf: [{ type: "number" }, { minimum: 1 }] },
    fixed: { const: { x: 1 } },
    nested: { type: "object", properties: { deep: { type: "boolean" } }, required: ["deep"], additionalProperties: false },
    nothing: { type: ["string", "null"] },
  },
  required: ["name"],
  additionalProperties: false,
};

const inputs: unknown[] = [
  { name: "ok" },
  {},
  [],
  null,
  "text",
  { name: 1 },
  { name: "" },
  { name: "toolong" },
  { name: "ok", extra: 1 },
  { name: "ok", n: 3 },
  { name: "ok", n: 3.5 },
  { name: "ok", n: -1 },
  { name: "ok", n: 10 },
  { name: "ok", kind: "a" },
  { name: "ok", kind: "c" },
  { name: "ok", tags: [] },
  { name: "ok", tags: ["a", "b"] },
  { name: "ok", tags: ["a", "b", "c"] },
  { name: "ok", tags: ["a", "a"] },
  { name: "ok", tags: [1] },
  { name: "ok", either: "s" },
  { name: "ok", either: true },
  { name: "ok", one: 5.5 },
  { name: "ok", one: 7 },
  { name: "ok", one: 3 },
  { name: "ok", all: 2 },
  { name: "ok", all: 0 },
  { name: "ok", fixed: { x: 1 } },
  { name: "ok", fixed: { x: 2 } },
  { name: "ok", nested: { deep: true } },
  { name: "ok", nested: {} },
  { name: "ok", nested: { deep: true, more: 1 } },
  { name: "ok", nothing: null },
  { name: "ok", nothing: 1 },
  JSON.parse('{"name":"ok","__proto__":1}'),
  JSON.parse('{"__proto__":{"name":"x"}}'),
];

describe("schema fallback", () => {
  test("agrees with Ajv on every input", () => {
    const fallback = compileFallback(schema);
    const reference = ajv.compile(schema);
    for (const input of inputs) expect([JSON.stringify(input), fallback(input)]).toEqual([JSON.stringify(input), reference(input)]);
  });
  test("names the first problem", () => {
    const fallback = compileFallback(schema);
    expect(fallback({ name: "ok", extra: 1 })).toBe(false);
    expect(fallback.errors?.[0]).toMatchObject({ instancePath: "", params: { additionalProperty: "extra" } });
    expect(fallback({ name: 1 })).toBe(false);
    expect(fallback.errors?.[0]?.instancePath).toBe("/name");
    expect(fallback({ name: "ok" })).toBe(true);
    expect(fallback.errors).toBeNull();
  });
  test("refuses a keyword it cannot enforce", () => {
    for (const bad of [{ type: "object", $ref: "#/x" }, { type: "object", patternProperties: {} }, { type: "object", dependentRequired: {} }, { type: "object", properties: { a: { not: {} } } }]) {
      expect(() => compileFallback(bad)).toThrow(/not supported/);
    }
    expect(() => compileFallback({ type: "object", properties: { a: { type: "nope" } } })).toThrow();
  });
  test("a deep input is walked only as far as the schema goes", () => {
    const recursive = { type: "object", properties: { a: { type: "object" } } };
    const fallback = compileFallback(recursive);
    let deep: unknown = {};
    for (let i = 0; i < 200; i++) deep = { a: deep };
    expect(fallback(deep)).toBe(true);
  });
});
