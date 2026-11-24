/** Deliberately small JSON schema dialect; unknown object fields are always rejected. */
export type JSONValue =
  | string
  | number
  | boolean
  | null
  | JSONValue[]
  | { [key: string]: JSONValue };
export type Parameter = {
  required?: boolean;
  description?: string;
  default?: JSONValue;
} & (
  | { type: "string"; enum?: string[] }
  | { type: "number"; minimum?: number; maximum?: number }
  | { type: "boolean" }
  | { type: "object"; properties: Record<string, Parameter> }
  | { type: "array"; items: Parameter; minItems?: number; maxItems?: number }
);
const object = (v: unknown): v is Record<string, unknown> =>
  !!v &&
  typeof v === "object" &&
  !Array.isArray(v) &&
  [Object.prototype, null].includes(Object.getPrototypeOf(v));
const nameOK = (key: string) =>
  /^[a-zA-Z][a-zA-Z0-9_]*$/.test(key) &&
  !/password|token|secret|credential|cookie|otp/i.test(key) &&
  !["constructor", "prototype", "__proto__"].includes(key);
const MAX_DEPTH = 16;
export function validateParameterSchema(
  schema: Parameter,
  path: string,
  depth = 0,
): void {
  if (depth > MAX_DEPTH || !object(schema))
    throw Error(`Invalid parameter schema: ${path}`);
  const fields: Record<string, string[]> = {
    string: ["enum"],
    number: ["minimum", "maximum"],
    boolean: [],
    object: ["properties"],
    array: ["items", "minItems", "maxItems"],
  };
  if (!Object.hasOwn(fields, schema.type))
    throw Error(`Invalid parameter type: ${path}`);
  const allowed = [
    "type",
    "required",
    "description",
    "default",
    ...fields[schema.type],
  ];
  for (const key of Object.keys(schema))
    if (!allowed.includes(key))
      throw Error(`Unknown schema field: ${path}.${key}`);
  if (schema.required !== undefined && typeof schema.required !== "boolean")
    throw Error(`Invalid required flag: ${path}`);
  if (
    schema.description !== undefined &&
    typeof schema.description !== "string"
  )
    throw Error(`Invalid description: ${path}`);
  if (schema.type === "object") {
    if (!object(schema.properties))
      throw Error(`Object properties required: ${path}`);
    for (const [key, child] of Object.entries(schema.properties)) {
      if (!nameOK(key))
        throw Error(
          `Use private CUA input for secrets; invalid parameter name: ${path}.${key}`,
        );
      validateParameterSchema(child, `${path}.${key}`, depth + 1);
    }
  } else if (schema.type === "array") {
    validateParameterSchema(schema.items, `${path}[]`, depth + 1);
    for (const value of [schema.minItems, schema.maxItems])
      if (
        value !== undefined &&
        (!Number.isSafeInteger(value) || value < 0 || value > 10000)
      )
        throw Error(`Invalid array bounds: ${path}`);
    if ((schema.minItems ?? 0) > (schema.maxItems ?? 10000))
      throw Error(`Invalid array bounds: ${path}`);
  } else if (schema.type === "number") {
    for (const value of [schema.minimum, schema.maximum])
      if (value !== undefined && !Number.isFinite(value))
        throw Error(`Invalid number bounds: ${path}`);
    if ((schema.minimum ?? -Infinity) > (schema.maximum ?? Infinity))
      throw Error(`Invalid number bounds: ${path}`);
  } else if (
    schema.type === "string" &&
    schema.enum !== undefined &&
    (!Array.isArray(schema.enum) ||
      !schema.enum.length ||
      schema.enum.some((v) => typeof v !== "string"))
  )
    throw Error(`Invalid enum: ${path}`);
  if (schema.default !== undefined) {
    try {
      parameterValue(schema, schema.default, path, depth);
    } catch {
      throw Error(`Invalid default: ${path}`);
    }
  }
}
function parameterValue(
  schema: Parameter,
  input: unknown,
  path: string,
  depth: number,
): unknown {
  if (depth > MAX_DEPTH) throw Error(`Parameter nesting too deep: ${path}`);
  const value = input === undefined ? schema.default : input;
  if (value === undefined) {
    if (schema.required) throw Error(`Missing parameter: ${path}`);
    return undefined;
  }
  if (schema.type === "object") {
    if (!object(value))
      throw Error(`Invalid parameter: ${path} (expected object)`);
    for (const key of Object.keys(value))
      if (!Object.hasOwn(schema.properties, key))
        throw Error(`Unknown parameter: ${path}.${key}`);
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, child] of Object.entries(schema.properties)) {
      const v = parameterValue(
        child,
        Object.hasOwn(value, key) ? value[key] : undefined,
        `${path}.${key}`,
        depth + 1,
      );
      if (v !== undefined) result[key] = v;
    }
    return result;
  }
  if (schema.type === "array") {
    if (
      !Array.isArray(value) ||
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? 10000)
    )
      throw Error(`Invalid parameter: ${path} (array length)`);
    return Array.from(value, (v, i) => {
      if (v === undefined) throw Error(`Invalid parameter: ${path}[${i}]`);
      return parameterValue(schema.items, v, `${path}[${i}]`, depth + 1);
    });
  }
  if (
    typeof value !== schema.type ||
    (schema.type === "number" &&
      (!Number.isFinite(value) ||
        (value as number) < (schema.minimum ?? -Infinity) ||
        (value as number) > (schema.maximum ?? Infinity))) ||
    (schema.type === "string" &&
      schema.enum &&
      !schema.enum.includes(value as string))
  )
    throw Error(`Invalid parameter: ${path} (expected ${schema.type})`);
  return value;
}
export function resolveParameters(
  parameters: Record<string, Parameter>,
  supplied: Record<string, unknown>,
) {
  const schema: Parameter = {
    type: "object",
    properties: parameters,
    required: true,
  };
  validateParameterSchema(schema, "params");
  return parameterValue(schema, supplied, "params", 0) as Record<
    string,
    unknown
  >;
}
