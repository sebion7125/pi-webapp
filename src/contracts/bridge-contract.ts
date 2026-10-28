import type { PluginEntry, WebInteraction } from "@chengzhiyi/pi-web-protocol";
import type { ErrorCorrelation } from "./telemetry.ts";

/** Wire DTOs only: no Pi runtime objects, Node values or browser-owned File state. */
export const SESSION_SCHEMA_VERSION = 1 as const;

export interface ViewBlock {
  kind: "text" | "thinking" | "image" | "toolCall";
  text: string;
  toolName?: string;
  toolCallId?: string;
}
export interface ViewUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: number;
}
/** One labelled group of protocol lines; `key` is the field name written by the protocol entry. */
export interface ViewProtocolSection {
  key: string;
  items: string[];
}
/** Display-only projection of a persistent session protocol entry (`custom` entry). It never enters model context. */
export interface ViewProtocol {
  /** Turn the protocol describes; null when the entry carries none. */
  turn: number | null;
  /** How the entry was produced, for example inline, followup, backfill or missing. */
  source: string | null;
  sections: ViewProtocolSection[];
}
/** One step of a compaction pass with the time it took. */
export interface ViewCompactStep {
  label: string;
  state: "ok" | "fail" | "skipped";
  /** Milliseconds the step ran; null when it never started. */
  ms: number | null;
  note: string | null;
}
/** Display-only projection of a `pi-protokoll` compaction status entry (`custom` entry customType "protokoll-compact"). */
export interface ViewCompact {
  /** protocol: the extension wrote the summary; no_room or failed: Pi summarized instead. Null for entries written by older versions. */
  outcome: string | null;
  startedAt: string | null;
  /** Wall time of the whole pass in milliseconds. */
  durationMs: number | null;
  steps: ViewCompactStep[];
  notes: string[];
  condensedTurns: number | null;
  detailTurns: number | null;
  keptTurns: number | null;
  missingTurns: number | null;
  backfilled: number | null;
  newlyFolded: number | null;
  pending: number | null;
  error: string | null;
}
/**
 * One live line of a `pi-protokoll` pass that is still running. Unlike ViewCompact it is never
 * stored in the session: it arrives over Pi's shared extension bus and is gone when the pass ends.
 */
export interface ViewCompactProgress {
  /** session the pass belongs to, so other sessions can ignore it */
  session: string;
  /** which kind of run reports: compaction, repair, ... */
  run: string;
  title: string;
  /** 1-based index of the current step */
  step: number;
  steps: number;
  label: string;
  state: "wait" | "run" | "ok" | "fail";
  /** wall time of the whole pass so far in milliseconds */
  ms: number;
  /** every step of the pass, in order — the same status the console widget shows */
  lines: ViewCompactProgressLine[];
  /** last line of the pass: the stored status entry follows, so the line can disappear */
  closed: boolean;
}
/** One step of a running pass: how far the model already is. */
export interface ViewCompactProgressLine {
  label: string;
  state: "wait" | "run" | "ok" | "fail";
  /** wall time of this step so far, null while it has not started */
  ms: number | null;
  /** characters the model has sent for this step so far, thinking included */
  chars: number | null;
  /** true while those characters are thinking instead of answer text */
  thinking: boolean;
  note: string | null;
}
export interface ViewMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "notice" | "protocol" | "compact";
  timestamp: string;
  blocks: ViewBlock[];
  protocol?: ViewProtocol;
  compact?: ViewCompact;
  isError?: boolean;
  toolCallId?: string;
  toolName?: string;
  usage?: ViewUsage;
  model?: string;
  error?: string;
}
/** Runtime delivery policy, not an interruption or a new concurrent run. */
export type PromptDelivery = "steer" | "followUp";
export interface PromptQueue { steering: string[]; followUp: string[] }
export interface QueuedPrompt {
  id: string;
  revision: number;
  text: string;
  attachments: Array<{ name: string; image: boolean }>;
  status: "queued" | "sending";
  error?: string;
}
export type QueuedPromptAction = { kind: "edit"; text: string } | { kind: "remove" } | { kind: "steer" };

export interface SessionView {
  schemaVersion: typeof SESSION_SCHEMA_VERSION;
  sessionId: string;
  cwd: string;
  name: string;
  model: string | null;
  thinkingLevel: string | null;
  thinkingLevels: string[];
  idle: boolean;
  paused?: boolean;
  /** Native SDK queue; pending prompts are not yet transcript messages. */
  promptQueue?: PromptQueue;
  /** Host-owned pending submissions remain editable until handed to Pi. */
  queuedPrompts?: QueuedPrompt[];
  /** TUI contexts expose only whether a native queue is pending. */
  hasPendingPrompts?: boolean;
  contextUsage: { tokens: number | null; contextWindow: number; percent: number | null } | null;
  messages: ViewMessage[];
  pluginEntries: PluginEntry[];
  interactions?: WebInteraction[];
  streaming?: ViewMessage | null;
  /** live line of a `pi-protokoll` pass that is running right now, null when none is */
  compactProgress?: ViewCompactProgress | null;
}
export interface WorkspaceView {
  id: string;
  path: string;
  title: string;
  /** Computed availability, absent in older records. */
  available?: boolean;
}
export interface WorkspaceSessionView { id: string; workspaceId: string; path: string | null; name: string; modified: string; idle?: boolean }
export interface WorkspaceListView { items: WorkspaceView[]; activeId: string | null; sessions: WorkspaceSessionView[] }
export interface DirectoryEntry { name: string; path: string; hidden: boolean }
export interface DirectoryListing { path: string; home: string; crumbs: DirectoryEntry[]; entries: DirectoryEntry[]; truncated: boolean }
export type DirectoryPickerKind = "native" | "browse";
export interface ModelOption { provider: string; id: string; name: string }
export interface CommandOption { name: string; description?: string }
export interface AttachmentReceipt { id: string; name: string; bytes: number }

export type ConfigKind = "packages" | "extensions" | "skills";
export type ConfigScope = "global" | "project";
export interface ResourceItem { name: string; path: string; source: string; scope: "user" | "project" | "temporary"; enabled: boolean }
export interface ConfigView {
  projectTrusted: boolean;
  global: Record<ConfigKind, string[]>;
  project: Record<ConfigKind, string[]>;
  installed: Record<ConfigKind, ResourceItem[]>;
}
export interface ConfigChange { sessionId: string; kind: ConfigKind; scope: ConfigScope; action: "add" | "remove"; value: string }
export type UpdateChannel = "stable" | "alpha";
export interface UpdateRequest { channel: UpdateChannel; version: string; allowDowngrade?: boolean }
export interface UpdateStatus { current: string; latest: string | null; available: boolean; canRestart: boolean; channel?: UpdateChannel; downgrade?: boolean; reason?: string; desktopShell?: { version: string; build: string } }
export type LoginMethod = "api_key" | "oauth";
export interface ProviderView { id: string; name: string; configured: boolean; storedCredential: boolean; methods: LoginMethod[] }
export interface ProviderModelFields { id: string; name?: string; contextWindow?: number; maxTokens?: number; input?: Array<"text" | "image"> }
export interface ProviderModelRow extends ProviderModelFields { source: "builtin" | "custom"; overridden: boolean }
export interface ProviderModelsView { providerId: string; baseUrl?: string; models: ProviderModelRow[] }
export type ProviderModelChange = { action: "save"; originalId?: string; model: ProviderModelFields } | { action: "remove"; id: string } | { action: "base_url"; baseUrl: string | null };
export type CustomProviderApi = "openai-completions" | "openai-responses" | "anthropic-messages";
export interface CustomProviderInput { id: string; name: string; baseUrl: string; api: CustomProviderApi; modelId: string }
export type LoginPrompt =
  | { type: "text" | "secret" | "manual_code"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] };
export type LoginEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };
export interface LoginView {
  id: string;
  providerId: string;
  method: LoginMethod;
  status: "running" | "waiting" | "done" | "error" | "cancelled";
  prompt?: LoginPrompt;
  event?: LoginEvent;
  authorization?: Extract<LoginEvent, { type: "auth_url" | "device_code" }>;
  error?: string;
  errorId?: string;
}
export interface WebPluginView { id: string; client: string; style?: string }
export interface WebPluginCatalogView { plugins: WebPluginView[]; errors: string[] }

/** Bridge reload protocolVersion and plugin apiVersion are separate from session schema. */
export type BridgeEvent =
  | { type: "shutdown"; reconnect?: boolean }
  | { type: "plugins_changed" }
  | { type: "hosted_plugins_changed" }
  | { type: "plugin_state"; disabled: string[] }
  | { type: "snapshot"; session: SessionView }
  | { type: "stream"; message: ViewMessage | null }
  | { type: "workspaces"; value: WorkspaceListView }
  | ({ type: "error"; message: string; errorCode?: string; errorReported?: boolean } & ErrorCorrelation);
