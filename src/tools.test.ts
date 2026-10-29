import { describe, expect, test } from "vitest";
import { ToolRegistry, defineTool } from "./tools.js";

// Ways input validation can fail. Each one is a case below.
// 1. A string passes for a number, because the validator coerces types.
// 2. An extra property passes when the schema forbids it.
// 3. A missing required field passes.
// 4. A schema that is not an object schema is accepted.
// 5. A schema that does not compile is accepted, or throws a raw validator error.
// 6. A schema with a draft marker or an id from another server breaks the registry, or two tools clash on one id.
// 7. A schema with a pattern (a backtracking regular expression) is accepted, and one hostile input freezes the host.
// 8. A nested error loses its path, or the message echoes the bad value.
describe("input validation", () => {
  const schema = {
    type: "object",
    properties: { id: { type: "string" }, count: { type: "integer", minimum: 1 }, nested: { type: "object", properties: { flag: { type: "boolean" } } } },
    required: ["id"],
    additionalProperties: false,
  };
  const registry = new ToolRegistry().register({ name: "t", description: "d", inputSchema: schema, scope: "notes:read", risk: "safe", handler: () => "ok" });

  test.each([
    ["a good input", { id: "a", count: 2 }, undefined],
    ["a missing required field", { count: 2 }, "input must have required property"],
    ["a string for an integer", { id: "a", count: "2" }, "/count must be integer"],
    ["a value below the minimum", { id: "a", count: 0 }, "/count must be >= 1"],
    ["an extra property", { id: "a", extra: true }, 'input must NOT have additional properties "extra"'],
    ["a nested type error", { id: "a", nested: { flag: "yes" } }, "/nested/flag must be boolean"],
  ])("%s", (_name, input, expected) => {
    const problem = registry.checkInput("t", input);
    if (expected === undefined) expect(problem).toBeUndefined();
    else expect(problem).toContain(expected);
  });

  test("an error message never echoes the bad value", () => {
    expect(registry.checkInput("t", { id: "sk-SECRET-VALUE", count: "sk-SECRET-VALUE" })).not.toContain("SECRET");
  });

  test("rejects a schema that is not an object schema", () => {
    expect(() => new ToolRegistry().register({ name: "a", description: "d", inputSchema: { type: "string" }, scope: "notes:read", risk: "safe", handler: () => 1 })).toThrow(/type "object"/);
    expect(() => new ToolRegistry().register({ name: "a", description: "d", inputSchema: {}, scope: "notes:read", risk: "safe", handler: () => 1 })).toThrow(/type "object"/);
  });

  test("rejects a schema that does not compile, with a clear error", () => {
    const bad = { type: "object", properties: { a: { type: "nonsense" } } };
    expect(() => new ToolRegistry().register({ name: "a", description: "d", inputSchema: bad, scope: "notes:read", risk: "safe", handler: () => 1 })).toThrow(/invalid input schema/);
  });

  test("accepts a draft marker, and the same id in two tools", () => {
    const withMeta = { $schema: "http://json-schema.org/draft-07/schema#", $id: "https://other.example/tool.json", type: "object" };
    const two = new ToolRegistry()
      .register({ name: "a", description: "d", inputSchema: withMeta, scope: "notes:read", risk: "safe", handler: () => 1 })
      .register({ name: "b", description: "d", inputSchema: withMeta, scope: "notes:read", risk: "safe", handler: () => 1 });
    expect(two.list()).toHaveLength(2);
  });

  test.each([
    ["a pattern", { type: "object", properties: { q: { type: "string", pattern: "^(a|a)*$" } } }],
    ["a nested pattern", { type: "object", properties: { a: { type: "object", properties: { b: { type: "string", pattern: "x" } } } } }],
    ["a pattern in a list", { type: "object", anyOf: [{ properties: { q: { type: "string", pattern: "x" } } }] }],
    ["patternProperties", { type: "object", patternProperties: { "^a": { type: "string" } } }],
  ])("refuses a schema with %s", (_name, inputSchema) => {
    expect(() => new ToolRegistry().register({ name: "a", description: "d", inputSchema, scope: "notes:read", risk: "safe", handler: () => 1 })).toThrow(/regular expression/);
  });

  test("allows a property that is named pattern", () => {
    const ok = { type: "object", properties: { pattern: { type: "string" } } };
    expect(() => new ToolRegistry().register({ name: "a", description: "d", inputSchema: ok, scope: "notes:read", risk: "safe", handler: () => 1 })).not.toThrow();
  });

  test("input nested too deeply is a problem, not a crash", () => {
    const recursive = { type: "object", properties: { c: { $ref: "#/$defs/n" } }, $defs: { n: { type: "object", properties: { c: { $ref: "#/$defs/n" } } } } };
    const tools = new ToolRegistry().register({ name: "deep", description: "d", inputSchema: recursive, scope: "notes:read", risk: "safe", handler: () => 1 });
    let input: Record<string, unknown> = {};
    for (let i = 0; i < 20_000; i++) input = { c: input };
    expect(tools.checkInput("deep", input)).toContain("too deeply");
  });

  test("checking an unknown tool is a problem, not a pass", () => {
    expect(registry.checkInput("nope", {})).toContain("unknown tool");
  });

  test("defineTool types the handler input", () => {
    const tool = defineTool<{ id: string }>({
      name: "typed",
      description: "d",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      scope: "notes:read", risk: "safe",
      handler: ({ id }) => id.toUpperCase(),
    });
    expect(new ToolRegistry().register(tool).get("typed")?.name).toBe("typed");
  });
});
