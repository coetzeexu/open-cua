/** CUA Runner v1 wire contracts and server entry point. */
export {
  startRunner,
  validateRunnerConfig,
  type RunnerOptions,
} from "./server.js";
export { RunnerFault } from "./common.js";
export type { McpConnection, McpConnector } from "./mcp.js";
export const RUNNER_PROTOCOL_VERSION = 1;
export const RUNNER_ROUTES = {
  schema: "/get_script_schema",
  run: "/run_cua_script",
  result: "/get_cua_result",
} as const;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
/** JSON Schema 2020-12 document; compile and validate at the runtime boundary. */
export type JsonSchema = boolean | { [keyword: string]: JsonValue };
export type ObservationMode = "default" | "ax" | "dom";

export interface ScriptSchemaRequest {
  cua_script_id: string;
  /** Omitted means resolve the published version at request time. */
  script_version?: string;
}
export interface ScriptSchema {
  cua_script_id: string;
  script_version: string;
  description: string;
  input_schema: JsonSchema;
  output_schema: JsonSchema;
}
export interface ScriptManifest extends ScriptSchema {
  protocol_version: typeof RUNNER_PROTOCOL_VERSION;
  /** Relative keys under the configured script source; never caller URLs. */
  entry: string;
  verify_entry: string;
  /** SHA-256 of raw downloaded bytes. */
  entry_sha256: string;
  verify_sha256: string;
  observation_mode: ObservationMode;
  timeout_ms: number;
}
/** Appears in input only at schema locations marked x-cua-file: true. */
export interface InputFileRef {
  file_id: string;
  sha256: string;
  size_bytes: number;
}
export interface RunScriptRequest extends ScriptSchemaRequest {
  /** Required, scoped to the authenticated principal. */
  request_id: string;
  input: { [key: string]: JsonValue };
}
export interface RunAccepted {
  run_id: string;
  cua_script_id: string;
  script_version: string;
  /** Admission snapshot; query get_cua_result for current state. */
  status: "queued";
}
export interface GetResultRequest {
  run_id: string;
}
export type RunStatus =
  | "queued"
  | "preparing"
  | "running"
  | "publishing"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "interrupted";
export type RunnerErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "SCRIPT_NOT_FOUND"
  | "VERSION_NOT_PUBLISHED"
  | "RUN_NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "QUEUE_FULL"
  | "SCHEMA_INVALID"
  | "INPUT_INVALID"
  | "SOURCE_UNAVAILABLE"
  | "INTEGRITY_MISMATCH"
  | "FILE_INVALID"
  | "MCP_UNAVAILABLE"
  | "EXECUTION_FAILED"
  | "VERIFICATION_FAILED"
  | "OUTPUT_INVALID"
  | "OUTPUT_PUBLISH_FAILED"
  | "USER_ACTION_REQUIRED"
  | "DEADLINE_EXCEEDED"
  | "EXECUTION_UNKNOWN"
  | "INTERNAL_ERROR";
export interface RunnerError {
  code: RunnerErrorCode;
  message: string;
  /** Sanitized diagnostics; excludes credentials, source and private inputs. */
  details?: { [key: string]: JsonValue };
}
export interface ErrorResponse {
  error: RunnerError;
}
export interface OutputFile {
  file_id: string;
  name: string;
  size_bytes: number;
  sha256: string;
  mime_type: string;
  /** Authenticated download endpoint, never a server filesystem path. */
  download_url: string;
}
export interface RunResultBase {
  run_id: string;
  cua_script_id: string;
  script_version: string;
  created_at: string;
  updated_at: string;
  /** Independent from transport success and artifact publication. */
  business_success: boolean | null;
  cleanup: "pending" | "succeeded" | "failed";
}
export type RunResult = RunResultBase &
  (
    | {
        status: "queued" | "preparing" | "running" | "publishing";
        output?: never;
        files?: never;
        error?: never;
      }
    | {
        status: "succeeded";
        business_success: true;
        output: JsonValue;
        files: OutputFile[];
        finished_at: string;
        error?: never;
      }
    | {
        status: "failed" | "timed_out" | "interrupted";
        error: RunnerError;
        finished_at: string;
        output?: never;
        files?: never;
      }
  );

/** Host configuration, never accepted in a run request. */
export interface RunnerConfig {
  listen: { host: string; port: number; token_env: string };
  mcp: {
    url: string;
    token_env: string;
    profile: string;
    observation_mode: ObservationMode;
  };
  script_source: { base_url: string; token_env?: string };
  input_files: { base_url: string; token_env?: string; max_bytes: number };
  output_files: { base_url: string; token_env?: string; max_bytes: number };
  /** Runner and CUA service must share this absolute path in v1. */
  work_directory: string;
  state_directory: string;
  limits: {
    max_queue_size: number;
    request_max_bytes: number;
    max_script_bytes: number;
    max_files_per_run: number;
    max_run_file_bytes: number;
    run_timeout_ms: number;
    io_timeout_ms: number;
    cleanup_timeout_ms: number;
    retention_days: number;
  };
}

/** Script body receives these bindings inside the CUA REPL wrapper. */
export interface ScriptContext {
  runId: string;
  input: Readonly<{ [key: string]: JsonValue }>;
  /** Keys are JSON Pointers to x-cua-file locations; paths exist on CUA host. */
  files: Readonly<Record<string, string>>;
  outputDirectory: string;
}
/** Returned by the script body, then checked by verify_entry. */
export interface ScriptReturn {
  output: JsonValue;
  /** Relative paths below outputDirectory. */
  files: Array<{ path: string; mime_type: string }>;
}
