export * from "./errors.js";
import type {
  AggregateOutcome,
  Outcome,
  Phase,
  SerializedError,
} from "./errors.js";
export const CONTRACT_VERSION = 1;
export type TabState =
  | "ready"
  | "busy"
  | "dialog_open"
  | "handed_off"
  | "quarantined"
  | "closed";
export interface Warning {
  code: string;
  message: string;
  scopeId?: string;
  orphan?: boolean;
}
export interface OperationResult {
  operationId: string;
  kind: string;
  tabId?: string;
  status: "succeeded" | "failed" | "cancelled" | "abandoned";
  phase: Phase;
  outcome: Outcome;
  error?: SerializedError;
}
export interface OutputItem {
  sequence: number;
  type: "text" | "json" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
  imageId?: string;
  path?: string;
  truncated?: boolean;
  observationId?: string;
}
export interface ExecutionResult {
  runId?: string;
  executionId: string;
  status: "running" | "succeeded" | "failed" | "cancelled" | "timed_out";
  error?: SerializedError;
  operations: OperationResult[];
  aggregateOutcome: AggregateOutcome;
  stateImpact: "none" | "repl_restarted" | "browser_lost";
  output: OutputItem[];
  warnings: Warning[];
  cursor?: number;
}
export interface ProviderDescriptor {
  id: string;
  contractVersion: number;
  bindingKind: string;
  capabilities: string[];
  targetTypes?: string[];
  dependencies?: string[];
}
export interface TabInfo {
  id: string;
  url: string;
  title: string;
  source: "created" | "popup" | "claimed" | "user";
  state: TabState;
  epoch: number;
  viewportRevision: number;
  deliverable: boolean;
}
export interface FrameInfo {
  id: string;
  url: string;
  /** Document epoch; reference invalidation alone must not change it. */
  epoch: number;
  parentId?: string;
}
export interface ElementRef {
  type: "ref";
  sessionId: string;
  generation: number;
  tabId: string;
  frameId: string;
  epoch: number;
  refId: string;
}
export interface LocatorTarget {
  type: "locator";
  sessionId: string;
  generation: number;
  tabId: string;
  frameId?: string;
  selector?: string;
  role?: string;
  name?: string;
  text?: string;
  exact?: boolean;
}
export interface PointTarget {
  type: "point";
  sessionId: string;
  generation: number;
  tabId: string;
  screenshotId: string;
  epoch: number;
  viewportRevision: number;
  x: number;
  y: number;
}
export type Target = ElementRef | LocatorTarget | PointTarget;
export interface AXNode {
  id: string;
  role: string;
  name: string;
  value?: string;
  parentId?: string;
  frameId: string;
  ref?: ElementRef;
  /** Sensitive field (including editable fields on a protected document). */
  sensitive?: boolean;
}
export interface Snapshot {
  observationId: string;
  baseObservationId: string | null;
  isDiff: boolean;
  title: string;
  url: string;
  nodes: AXNode[];
  removed: string[];
  warnings: Warning[];
}
export interface Screenshot {
  imageId: string;
  mimeType: string;
  width: number;
  height: number;
  epoch: number;
  viewportRevision: number;
  tabId: string;
  sessionId: string;
  generation: number;
  scaleX: number;
  scaleY: number;
  offsetX: number;
  offsetY: number;
}
export interface DialogInfo {
  id: string;
  type: string;
  message: string;
  defaultValue: string;
  appearedAt: number;
}
export interface LocatorDiagnostics {
  kind:
    | "no_matches"
    | "multiple_matches"
    | "no_visible_match"
    | "intercepted"
    | "action_failed";
  matchCount: number;
  visibleCount: number;
  samples: {
    tag: string;
    role: string;
    name: string;
    text: string;
    visible: boolean;
    enabled: boolean;
  }[];
}
export interface OperationContext {
  sessionId: string;
  generation: number;
  scopeId: string;
  signal: AbortSignal;
  timeoutMs: number;
  check(): void;
  dispatch(): void;
  afterDispatch(): void;
  policy(url: string, kind?: string): Promise<void>;
}
export interface TabBinding {
  readonly kind: string;
  readonly id: string;
  info(): Promise<TabInfo>;
  frames(): Promise<FrameInfo[]>;
  dialog(): DialogInfo | undefined;
  onDialog(listener: (dialog: DialogInfo | undefined) => void): () => void;
  respondDialog(
    id: string,
    response: { accept: boolean; promptText?: string },
  ): Promise<void>;
  navigate(
    kind: "goto" | "reload" | "back" | "forward",
    url: string | undefined,
    context: OperationContext,
  ): Promise<void>;
  evaluate(
    source: string,
    args: unknown,
    frameId: string | undefined,
    context: OperationContext,
  ): Promise<unknown>;
  recoverEvaluation(): Promise<"ready" | "quarantined">;
  devLogs(options?: Record<string, unknown>): unknown[];
  /** Invalidate references/coordinates while preserving each live frame's document epoch. */
  invalidate(): void;
  quarantine(): void;
  markDeliverable(value: boolean): Warning | undefined;
  close(): Promise<void>;
}
export interface BrowserConnection {
  readonly id: string;
  readonly kind: string;
  readonly mode: "create" | "attach";
  health(): Promise<void>;
  tabs(): Promise<TabBinding[]>;
  create(url?: string): Promise<TabBinding>;
  userTabs(): Promise<TabInfo[]>;
  claim(info: TabInfo): Promise<TabBinding>;
  popups(tabId: string): Promise<TabInfo[]>;
  get(id: string): Promise<TabBinding>;
  /** Present only when a user can take over this browser. */
  handoff?(tabId: string): Promise<HandoffTarget>;
  /** Host-only human UI; never exposed to the REPL. Only connected, owned tabs. */
  openHumanView?(tabId: string): Promise<HumanBrowserView>;
  close(): Promise<void>;
}
export interface HandoffTarget {
  kind: "window" | "url" | "user_browser";
  /** Shown only on the user's terminal; never returned to the model. */
  url?: string;
}
export interface CredentialField {
  id: string;
  label: string;
  type: string;
}
export interface CredentialRequest {
  id: string;
  sessionId: string;
  origin: string;
  fields: CredentialField[];
  expiresAt: number;
}
export interface HandoffRequest {
  id: string;
  sessionId: string;
  tabId: string;
  origin: string;
  reason?: string;
  target: HandoffTarget;
  expiresAt: number;
}
export type SecureFormControl =
  | "text"
  | "email"
  | "tel"
  | "password"
  | "date"
  | "select";
export interface SecureFormDescriptor {
  bindingRevision?: string;
  nodeId: string;
  control: SecureFormControl;
  required: boolean;
  nonEmpty: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  options?: { value: string; label: string; disabled?: boolean }[];
}
export interface SecureFormField {
  id: string;
  label: string;
  control: SecureFormControl;
  groupId?: string;
  masked: boolean;
  required: boolean;
  nonEmpty: boolean;
  maxLength?: number;
  min?: string;
  max?: string;
  options?: { id: string; label: string }[];
}
export interface SecureFormRequest {
  type: "secure_form";
  id: string;
  sessionId: string;
  tabId: string;
  scopeId: string;
  executionId?: string;
  schemaRevision: string;
  origin: string;
  title: string;
  groups: { id: string; label: string }[];
  fields: SecureFormField[];
  delivery: { mode: "fill" };
  expiresAt: number;
}
export type SecureFormStatus =
  | "pending"
  | "accepted"
  | "delivering"
  | "filled"
  | "failed_before_write"
  | "partial_or_unknown"
  | "cancelled"
  | "expired"
  | "stale";
export interface SecureFormState {
  requestId: string;
  operationId: string;
  sessionId: string;
  scopeId: string;
  executionId?: string;
  schemaRevision: string;
  status: SecureFormStatus;
  confirmedFieldIds: string[];
  uncertainFieldIds: string[];
  businessOutcome: "unverified";
  actionOutcome: "not_dispatched";
  nextAction: "fill" | "wait" | "human_review" | "new_request" | "stop";
  reasonCode?: string;
  request?: SecureFormRequest;
}
export type SecureFormAnswer =
  | {
      action: "submit";
      schemaRevision: string;
      submissionId: string;
      values: Record<string, string>;
    }
  | { action: "decline" };
/** Out-of-band channel to the human user. Values never cross the worker IPC. */
export interface UserChannel {
  collectSecureForm?(
    request: SecureFormRequest,
    signal: AbortSignal,
    onAccept?: () => void,
  ): Promise<
    { action: "accept"; values: Record<string, string> } | { action: "decline" }
  >;
  secureFormState?(id: string): SecureFormState | undefined;
  updateSecureForm?(id: string, patch: Partial<SecureFormState>): void;
  collectCredentials(
    request: CredentialRequest,
    signal: AbortSignal,
  ): Promise<
    { action: "accept"; values: Record<string, string> } | { action: "decline" }
  >;
  handoff(
    request: HandoffRequest,
    signal: AbortSignal,
  ): Promise<"resumed" | "cancelled">;
}
export interface TargetDescription {
  secureForm?: SecureFormDescriptor;
  count: number;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  sensitive: boolean;
  /** Native form destination, including submit-button overrides. null = no form;
   * undefined = provider cannot attest the form and secure input must fail closed. */
  authForm?: { method: string; action: string } | null;
}
export interface BrowserProvider {
  readonly descriptor: ProviderDescriptor;
  readonly resourceKey?: string;
  connect(context?: OperationContext): Promise<BrowserConnection>;
  /** Opt-in recovery of an externally owned browser at the same endpoint.
   * Must not create/delete cloud resources or replay page operations. */
  reconnect?(context?: OperationContext): Promise<BrowserConnection>;
}
export interface CapabilityProvider<T> {
  readonly descriptor: ProviderDescriptor;
  bind(context: TabBindingContext): Promise<T>;
}
export interface TabBindingContext {
  binding: TabBinding;
  sessionId: string;
  generation: number;
}
export interface AXCapability {
  snapshot(
    context: OperationContext,
    /** Host-enforced privacy flag; redact editable values and their AX text descendants. */
    options?: { redactEditableValues: boolean },
  ): Promise<{ nodes: AXNode[]; warnings: Warning[] }>;
}
export interface DOMInspectOptions {
  selector?: string;
  limit?: number;
  maxTextLength?: number;
  frameId?: string;
}
export interface DOMObservation {
  page: { url: string; title: string; readyState: string };
  frameId: string;
  capturedAt: number;
  coordinateSystem: "frame-viewport-css";
  elements: {
    text: string;
    href: string | null;
    bounds: { x: number; y: number; width: number; height: number };
  }[];
  matched: number;
  truncated: boolean;
  textTruncated: boolean;
}
export interface DOMCapability {
  inspect?(
    options: DOMInspectOptions,
    context: OperationContext,
  ): Promise<DOMObservation>;
  snapshot(context: OperationContext): Promise<unknown>;
}
export interface ScreenshotCapability {
  capture(
    options: Record<string, unknown>,
    context: OperationContext,
  ): Promise<{ metadata: Screenshot; bytes: Uint8Array }>;
}
export interface ResolvedTarget {
  value: unknown;
  dispose(): Promise<void>;
}
export interface TargetResolver {
  readonly descriptor: ProviderDescriptor;
  resolve(
    target: Target,
    context: TabBindingContext,
    operation: OperationContext,
  ): Promise<ResolvedTarget>;
}
export interface ActionCapability {
  /** Private native-node delivery. Must not route through current focus or label matching. */
  deliverSecureForm?(
    kind: "fill" | "select",
    target: ResolvedTarget,
    value: string,
    context: OperationContext,
  ): Promise<void>;
  perform(
    kind: string,
    target: ResolvedTarget | undefined,
    args: unknown[],
    context: OperationContext,
  ): Promise<unknown>;
  /** Read-only inspection used for credential protection and secure input. */
  describe?(
    target: ResolvedTarget,
    context: OperationContext,
  ): Promise<TargetDescription>;
  focusedSensitive?(context: OperationContext): Promise<boolean>;
}
export interface PolicyProvider {
  check(
    url: string,
    context: { sessionId: string; kind: string },
  ): Promise<void>;
  closeSession?(sessionId: string): void;
}
export interface Capabilities {
  ax?: CapabilityProvider<AXCapability>;
  dom?: CapabilityProvider<DOMCapability>;
  screenshot?: CapabilityProvider<ScreenshotCapability>;
  action?: CapabilityProvider<ActionCapability>;
}
export interface SDKRequest {
  method: string;
  tabId?: string;
  args: unknown[];
  sessionId: string;
  generation: number;
  scopeId: string;
}
export interface Handle {
  __cuaHandle: "browser" | "tab";
  id: string;
  sessionId: string;
  generation: number;
}
export type WorkerMessage =
  | { type: "ready" }
  | { type: "sdk"; id: string; request: SDKRequest }
  | {
      type: "output";
      scopeId: string;
      kind: "text" | "json" | "image";
      value: unknown;
    }
  | { type: "moduleEnded"; scopeId: string; error?: SerializedError }
  | { type: "drained"; scopeId: string; error?: SerializedError }
  | { type: "warning"; warning: Warning }
  | { type: "fault"; message: string };
export type ParentMessage =
  | {
      type: "execute";
      scopeId: string;
      code: string;
      sessionId: string;
      generation: number;
    }
  | {
      type: "sdkResult";
      generation?: number;
      id: string;
      value?: unknown;
      error?: SerializedError;
    }
  | { type: "closeScope"; scopeId: string }
  | { type: "shutdown" }
  | { type: "ping" };
export * from "./facade.js";
export interface ResourceRecord {
  event: "intent" | "created" | "released" | "release_failed";
  key: string;
  kind: "agentbay" | "local-profile";
  owned: boolean;
  resourceId?: string;
  labels?: Record<string, string>;
  time?: number;
}
export interface ResourceJournal {
  append(record: ResourceRecord): Promise<void>;
}
export interface CDPTransport {
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  subscribe(event: string, listener: (payload: unknown) => void): () => void;
  close(): Promise<void>;
}

/** Private host UI channel. Frame data and input must not enter model context. */
export interface HumanBrowserView {
  capture(): Promise<{
    data: string;
    id: number;
    width: number;
    height: number;
  }>;
  input(input: HumanInput): Promise<void>;
  release(): Promise<void>;
  close(): Promise<void>;
}
export type HumanInput = { frameId: number } & (
  | {
      type: "pointer";
      phase: "down" | "move" | "up" | "cancel";
      x: number;
      y: number;
    }
  | { type: "click"; x: number; y: number }
  | { type: "wheel"; x: number; y: number; deltaX: number; deltaY: number }
  | { type: "text"; text: string }
  | { type: "key"; key: string; modifiers?: number }
  | { type: "selectAll" }
);
