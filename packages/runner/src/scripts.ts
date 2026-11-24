import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { Script } from "node:vm";
import {
  bytes,
  canonical,
  endpoint,
  fetchBounded,
  fields,
  hash,
  id,
  object,
  parseJSON,
  requireValue,
  RunnerFault,
  sha,
  token,
} from "./common.js";
import type {
  InputFileRef,
  JsonSchema,
  RunnerConfig,
  ScriptManifest,
  ScriptSchemaRequest,
} from "./index.js";

const addFormats = addFormatsModule as unknown as (ajv: Ajv2020) => void;
export interface ScriptBundle {
  manifest: ScriptManifest;
  main: string;
  verify: string;
  fingerprint: string;
}
export class Scripts {
  private ajv = new Ajv2020({
    strict: true,
    allErrors: true,
    validateFormats: true,
    addUsedSchema: false,
  });
  constructor(private config: RunnerConfig) {
    addFormats(this.ajv);
    this.ajv.addKeyword({
      keyword: "x-cua-file",
      schemaType: "boolean",
      valid: true,
    });
  }
  compile(schema: JsonSchema) {
    try {
      this.checkFiles(schema, schema);
      const validate = this.ajv.compile(schema);
      requireValue(
        !object(schema) || !schema.$async,
        "SCHEMA_INVALID",
        "Async schemas are not supported",
      );
      return validate;
    } catch {
      throw new RunnerFault(
        "SCHEMA_INVALID",
        "Unsupported or invalid JSON Schema",
      );
    }
  }
  private ref(root: any, ref: string): any {
    requireValue(
      ref.startsWith("#/"),
      "SCHEMA_INVALID",
      "Only local JSON Pointer refs are supported",
    );
    return ref
      .slice(2)
      .split("/")
      .reduce(
        (v, key) => v?.[key.replace(/~1/g, "/").replace(/~0/g, "~")],
        root,
      );
  }
  private checkFiles(
    schema: any,
    root: any,
    active = new Set<any>(),
    ambiguous = false,
  ): void {
    if (!object(schema)) return;
    requireValue(
      !active.has(schema),
      "SCHEMA_INVALID",
      "Recursive schemas are not supported",
    );
    const next = new Set(active).add(schema);
    if (schema.$ref !== undefined) {
      requireValue(
        typeof schema.$ref === "string",
        "SCHEMA_INVALID",
        "Invalid ref",
      );
      const target = this.ref(root, schema.$ref);
      requireValue(target !== undefined, "SCHEMA_INVALID", "Unresolved ref");
      this.checkFiles(target, root, next, ambiguous);
    }
    if (schema["x-cua-file"])
      requireValue(
        !ambiguous && schema.type === "object",
        "SCHEMA_INVALID",
        "Ambiguous file annotation",
      );
    for (const [k, v] of Object.entries(schema)) {
      if (["properties", "$defs"].includes(k) && object(v))
        for (const child of Object.values(v))
          this.checkFiles(child, root, next, ambiguous);
      else if (k === "items") this.checkFiles(v, root, next, ambiguous);
      else if (
        ["oneOf", "anyOf", "allOf", "prefixItems"].includes(k) &&
        Array.isArray(v)
      )
        for (const child of v) this.checkFiles(child, root, next, true);
      else if (
        [
          "if",
          "then",
          "else",
          "not",
          "contains",
          "additionalProperties",
          "unevaluatedProperties",
          "unevaluatedItems",
          "propertyNames",
        ].includes(k)
      )
        this.checkFiles(v, root, next, true);
      else if (
        ["patternProperties", "dependentSchemas"].includes(k) &&
        object(v)
      )
        for (const child of Object.values(v))
          this.checkFiles(child, root, next, true);
    }
  }
  files(
    schema: JsonSchema,
    input: unknown,
  ): Array<{ pointer: string; ref: InputFileRef }> {
    const found = new Map<string, InputFileRef>();
    const visit = (s: any, v: any, pointer: string) => {
      if (!object(s) || v === undefined) return;
      if (s.$ref) visit(this.ref(schema, s.$ref), v, pointer);
      if (s["x-cua-file"]) {
        fields(v, ["file_id", "sha256", "size_bytes"]);
        requireValue(
          id(v.file_id) &&
            sha(v.sha256) &&
            Number.isSafeInteger(v.size_bytes) &&
            v.size_bytes >= 0,
          "FILE_INVALID",
          "Invalid file reference",
        );
        found.set(pointer, v);
      }
      if (object(s.properties) && object(v))
        for (const [k, child] of Object.entries(s.properties))
          visit(
            child,
            v[k],
            `${pointer}/${k.replace(/~/g, "~0").replace(/\//g, "~1")}`,
          );
      if (s.items && Array.isArray(v))
        v.forEach((child, n) => visit(s.items, child, `${pointer}/${n}`));
    };
    visit(schema, input, "");
    return [...found].map(([pointer, ref]) => ({ pointer, ref }));
  }
  private async get(path: string, signal?: AbortSignal) {
    const auth = token(this.config.script_source.token_env);
    const response = await fetchBounded(
      endpoint(this.config.script_source.base_url, path),
      { headers: auth ? { Authorization: `Bearer ${auth}` } : {} },
      this.config.limits.io_timeout_ms,
      signal,
    );
    requireValue(
      response.status !== 404 && response.status !== 410,
      "VERSION_NOT_PUBLISHED",
      "Script version is unavailable",
      404,
    );
    requireValue(
      response.ok,
      "SOURCE_UNAVAILABLE",
      "Script source failed",
      502,
    );
    return bytes(response, this.config.limits.max_script_bytes);
  }
  async load(
    request: ScriptSchemaRequest,
    signal?: AbortSignal,
  ): Promise<ScriptBundle> {
    requireValue(
      id(request.cua_script_id) &&
        (request.script_version === undefined || id(request.script_version)),
      "INVALID_REQUEST",
      "Invalid script identifier",
      400,
    );
    const root = `scripts/${request.cua_script_id}`;
    let version = request.script_version;
    if (!version) {
      const published = parseJSON(
        (await this.get(`${root}/published.json`, signal)).toString(),
      );
      requireValue(
        id(published?.script_version),
        "SCHEMA_INVALID",
        "Invalid published version",
      );
      version = published.script_version;
    }
    const versionRoot = `${root}/versions/${version}`;
    const m = parseJSON(
      (await this.get(`${versionRoot}/manifest.json`, signal)).toString(),
    ) as ScriptManifest;
    fields(m, [
      "protocol_version",
      "cua_script_id",
      "script_version",
      "description",
      "input_schema",
      "output_schema",
      "entry",
      "verify_entry",
      "entry_sha256",
      "verify_sha256",
      "observation_mode",
      "timeout_ms",
    ]);
    requireValue(
      m.protocol_version === 1 &&
        m.cua_script_id === request.cua_script_id &&
        m.script_version === version &&
        typeof m.description === "string" &&
        m.description.length <= 4000 &&
        sha(m.entry_sha256) &&
        sha(m.verify_sha256) &&
        Number.isSafeInteger(m.timeout_ms) &&
        m.timeout_ms > 0 &&
        ["default", "ax", "dom"].includes(m.observation_mode),
      "SCHEMA_INVALID",
      "Invalid script manifest",
    );
    requireValue(
      this.config.mcp.observation_mode === "default" ||
        m.observation_mode === "default" ||
        this.config.mcp.observation_mode === m.observation_mode,
      "SCHEMA_INVALID",
      "Script observation mode does not match deployment",
    );
    for (const path of [m.entry, m.verify_entry])
      requireValue(
        typeof path === "string" &&
          path
            .split("/")
            .every(
              (p) =>
                /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(p) &&
                p !== "." &&
                p !== "..",
            ),
        "SCHEMA_INVALID",
        "Invalid script entry path",
      );
    this.compile(m.input_schema);
    this.compile(m.output_schema);
    const main = await this.get(`${versionRoot}/${m.entry}`, signal);
    const verify = await this.get(`${versionRoot}/${m.verify_entry}`, signal);
    requireValue(
      hash(main) === m.entry_sha256 && hash(verify) === m.verify_sha256,
      "INTEGRITY_MISMATCH",
      "Script hash mismatch",
      409,
    );
    try {
      new Script(
        `(async function(ctx){${main.toString()}\n});(async function(ctx,result){${verify.toString()}\n})`,
      );
    } catch {
      throw new RunnerFault("SCHEMA_INVALID", "Script syntax is invalid");
    }
    return {
      manifest: m,
      main: main.toString(),
      verify: verify.toString(),
      fingerprint: hash(canonical(m)),
    };
  }
}
