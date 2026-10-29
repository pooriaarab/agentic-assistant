/**
 * A small JSON Schema checker for hosts that forbid code generation, such as Cloudflare Workers.
 * Ajv builds its validators with `new Function`, which those hosts refuse. This checker walks the schema instead.
 * It fails closed: a schema that uses a keyword it does not know is refused, so no input passes unchecked.
 */
export interface SchemaError {
  instancePath: string;
  message?: string;
  params: Record<string, unknown>;
}
export type FallbackValidate = ((input: unknown) => boolean) & { errors?: SchemaError[] | null };

type Schema = Record<string, unknown>;

const ANNOTATIONS = new Set(["$schema", "$id", "$comment", "title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "format"]);
const KEYWORDS = new Set([
  "type", "properties", "required", "additionalProperties", "enum", "const", "items", "minItems", "maxItems", "minLength", "maxLength",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "anyOf", "oneOf", "allOf", "uniqueItems",
]);
const MAX_DEPTH = 64;
const TYPES = ["string", "number", "integer", "boolean", "null", "object", "array"];

const isObject = (value: unknown): value is Schema => typeof value === "object" && value !== null && !Array.isArray(value);

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isType(value: unknown, type: string): boolean {
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeOf(value) === type;
}

/** JSON text with sorted keys, so two equal objects give one text whatever the order of their keys. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

const same = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

/** Throws when the schema holds anything this checker cannot enforce. */
function assertSupported(schema: unknown, depth = 0): void {
  if (typeof schema === "boolean") return;
  if (!isObject(schema)) throw new Error("a schema must be an object");
  if (depth > MAX_DEPTH) throw new Error("the schema is nested too deeply");
  for (const [key, value] of Object.entries(schema)) {
    if (ANNOTATIONS.has(key)) continue;
    if (!KEYWORDS.has(key)) throw new Error(`the keyword "${key}" is not supported without code generation`);
    if (key === "type") {
      const types = Array.isArray(value) ? value : [value];
      if (types.some((t) => typeof t !== "string" || !TYPES.includes(t))) throw new Error("a bad type");
    } else if (key === "properties") {
      if (!isObject(value)) throw new Error("properties must be an object");
      for (const child of Object.values(value)) assertSupported(child, depth + 1);
    } else if (key === "items" || key === "additionalProperties") assertSupported(value, depth + 1);
    else if (key === "anyOf" || key === "oneOf" || key === "allOf") {
      if (!Array.isArray(value)) throw new Error(`${key} must be a list`);
      for (const child of value) assertSupported(child, depth + 1);
    } else if (key === "required") {
      if (!Array.isArray(value) || value.some((name) => typeof name !== "string")) throw new Error("required must be a list of names");
    } else if (key === "enum") {
      if (!Array.isArray(value)) throw new Error("enum must be a list");
    } else if (key === "uniqueItems") {
      if (typeof value !== "boolean") throw new Error("uniqueItems must be true or false");
    } else if (key !== "const" && typeof value !== "number") throw new Error(`${key} must be a number`);
  }
}

function check(schema: unknown, value: unknown, path: string, depth: number): SchemaError | undefined {
  if (depth > MAX_DEPTH) throw new Error("too deep");
  if (schema === true) return undefined;
  if (schema === false) return { instancePath: path, message: "must not be present", params: {} };
  const s = schema as Schema;
  const fail = (message: string, params: Record<string, unknown> = {}): SchemaError => ({ instancePath: path, message, params });

  if (s.type !== undefined) {
    const types = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!types.some((t) => isType(value, t))) return fail(`must be ${types.join(" or ")}`);
  }
  if ("const" in s && !same(s.const, value)) return fail("must be equal to constant");
  if (Array.isArray(s.enum) && !s.enum.some((option) => same(option, value))) return fail("must be equal to one of the allowed values");
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) return fail(`must NOT have fewer than ${s.minLength} characters`);
    if (typeof s.maxLength === "number" && [...value].length > s.maxLength) return fail(`must NOT have more than ${s.maxLength} characters`);
  }
  if (typeof value === "number") {
    if (typeof s.minimum === "number" && value < s.minimum) return fail(`must be >= ${s.minimum}`);
    if (typeof s.maximum === "number" && value > s.maximum) return fail(`must be <= ${s.maximum}`);
    if (typeof s.exclusiveMinimum === "number" && value <= s.exclusiveMinimum) return fail(`must be > ${s.exclusiveMinimum}`);
    if (typeof s.exclusiveMaximum === "number" && value >= s.exclusiveMaximum) return fail(`must be < ${s.exclusiveMaximum}`);
  }
  if (Array.isArray(value)) {
    if (typeof s.minItems === "number" && value.length < s.minItems) return fail(`must NOT have fewer than ${s.minItems} items`);
    if (typeof s.maxItems === "number" && value.length > s.maxItems) return fail(`must NOT have more than ${s.maxItems} items`);
    if (s.uniqueItems === true) {
      const seen = new Set<string>();
      for (const item of value) {
        const text = canonical(item);
        if (seen.has(text)) return fail("must NOT have duplicate items");
        seen.add(text);
      }
    }
    if (s.items !== undefined) {
      for (let i = 0; i < value.length; i++) {
        const error = check(s.items, value[i], `${path}/${i}`, depth + 1);
        if (error) return error;
      }
    }
  }
  if (isObject(value)) {
    for (const name of (s.required as string[] | undefined) ?? []) {
      if (!Object.hasOwn(value, name)) return fail(`must have required property '${name}'`, { missingProperty: name });
    }
    const properties = isObject(s.properties) ? s.properties : {};
    for (const [name, child] of Object.entries(value)) {
      const key = `${path}/${name.replace(/~/g, "~0").replace(/\//g, "~1")}`;
      if (Object.hasOwn(properties, name)) {
        const error = check(properties[name], child, key, depth + 1);
        if (error) return error;
      } else if (s.additionalProperties === false) {
        return fail("must NOT have additional properties", { additionalProperty: name });
      } else if (s.additionalProperties !== undefined) {
        const error = check(s.additionalProperties, child, key, depth + 1);
        if (error) return error;
      }
    }
  }
  if (Array.isArray(s.allOf)) {
    for (const child of s.allOf) {
      const error = check(child, value, path, depth + 1);
      if (error) return error;
    }
  }
  if (Array.isArray(s.anyOf) && !s.anyOf.some((child) => check(child, value, path, depth + 1) === undefined)) return fail("must match a schema in anyOf");
  if (Array.isArray(s.oneOf) && s.oneOf.filter((child) => check(child, value, path, depth + 1) === undefined).length !== 1) {
    return fail("must match exactly one schema in oneOf");
  }
  return undefined;
}

/** Builds a validator from a schema. Throws when the schema is not supported. */
export function compileFallback(schema: Schema): FallbackValidate {
  assertSupported(schema);
  const validate: FallbackValidate = (input) => {
    const error = check(schema, input, "", 0);
    validate.errors = error ? [error] : null;
    return error === undefined;
  };
  return validate;
}

/** True when this host lets Ajv build validators. */
export function canGenerateCode(): boolean {
  try {
    new Function("return 1")();
    return true;
  } catch {
    return false;
  }
}
