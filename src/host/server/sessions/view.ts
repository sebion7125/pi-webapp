import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { displayUserMessage } from "../../../contracts/user-message.ts";
import type { PluginEntry } from "@chengzhiyi/pi-web-protocol";
import type { SessionView, ViewBlock, ViewCompact, ViewCompactStep, ViewMessage, ViewProtocol, ViewProtocolSection, ViewUsage } from "../../../contracts/bridge-contract.ts";
export type { SessionView, ViewBlock, ViewCompact, ViewCompactStep, ViewMessage, ViewProtocol, ViewProtocolSection, ViewUsage } from "../../../contracts/bridge-contract.ts";

export const PAUSED_ENTRY = 'pi-webapp/paused';
export const RESUME_MESSAGE = 'pi-webapp/resume';
/** `pi-protokoll` stores its per-turn protocol as a `custom` entry under this customType. */
export const PROTOKOLL_ENTRY = 'protokoll';
/** `pi-protokoll` stores how each compaction pass went, including the time of every step, under this customType. */
export const PROTOKOLL_COMPACT_ENTRY = 'protokoll-compact';
const PROTOCOL_SECTION_ORDER = ["result", "decision", "files", "open", "rule", "revoke", "index", "tags", "other"];
const PROTOCOL_MAX_SECTIONS = 24;
const PROTOCOL_MAX_ITEMS = 20;
const PROTOCOL_MAX_ITEM_CHARS = 4000;
const COMPACT_MAX_STEPS = 40;
const COMPACT_MAX_NOTES = 12;
const COMPACT_MAX_CHARS = 500;

/** A branch-local marker also covers cancellation during tool execution. */
export function sessionPaused(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.type === 'custom_message' && entry.customType === RESUME_MESSAGE) return false;
    if (entry.type === 'custom' && entry.customType === PAUSED_ENTRY) return true;
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') return false;
    if (entry.message.role === 'assistant') {
      if (entry.message.stopReason === 'aborted') return true;
      if (entry.message.stopReason === 'stop' || entry.message.stopReason === 'length' || entry.message.stopReason === 'error') return false;
    }
  }
  return false;
}

export function projectPluginEntries(entries: readonly SessionEntry[], pluginIds: readonly string[]): PluginEntry[] {
  const projected: PluginEntry[] = [];
  let afterMessageId: string | undefined;
  for (const entry of entries) {
    if (entry.type === "message") afterMessageId = entry.id;
    if (entry.type !== "custom") continue;
    const pluginId = pluginIds.find((id) => entry.customType.startsWith(`${id}/`));
    if (!pluginId) continue;
    try {
      if (JSON.stringify(entry.data).length > 128 * 1024) continue;
    } catch { continue; }
    projected.push({ id: entry.id, pluginId, kind: entry.customType, data: entry.data, timestamp: entry.timestamp, ...(afterMessageId ? { afterMessageId } : {}) });
  }
  return projected;
}

type ContentPart =
  | { type: "text"; text: string }
  | { type: "thinking"; thinking: string }
  | { type: "image" }
  | { type: "toolCall"; id: string; name: string; arguments: unknown };

export function contentBlocks(content: string | readonly ContentPart[]): ViewBlock[] {
  if (typeof content === "string") return [{ kind: "text", text: content }];
  return content.flatMap((part): ViewBlock[] => {
    if (part.type === "text") return [{ kind: "text", text: part.text }];
    if (part.type === "thinking") {
      return [{ kind: "thinking", text: part.thinking }];
    }
    if (part.type === "image") return [{ kind: "image", text: "图片附件" }];
    if (part.type === "toolCall") {
      return [{ kind: "toolCall", text: JSON.stringify(part.arguments ?? {}), toolName: part.name, toolCallId: part.id }];
    }
    return [];
  });
}

/** Protocol entries stay display-only: unknown, missing or extra fields degrade to fewer sections. */
export function projectProtocolEntry(data: unknown): ViewProtocol | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const entry = data as Record<string, unknown>;
  const fields = typeof entry.fields === "object" && entry.fields !== null && !Array.isArray(entry.fields)
    ? entry.fields as Record<string, unknown> : {};
  const keys = [...PROTOCOL_SECTION_ORDER.filter(key => key in fields), ...Object.keys(fields).filter(key => !PROTOCOL_SECTION_ORDER.includes(key))];
  const sections: ViewProtocolSection[] = [];
  for (const key of keys) {
    if (sections.length >= PROTOCOL_MAX_SECTIONS) break;
    const value = fields[key];
    const items = (Array.isArray(value) ? value : typeof value === "string" ? [value] : [])
      .filter((item): item is string => typeof item === "string")
      .map(item => item.trim()).filter(Boolean).slice(0, PROTOCOL_MAX_ITEMS)
      .map(item => item.length > PROTOCOL_MAX_ITEM_CHARS ? `${item.slice(0, PROTOCOL_MAX_ITEM_CHARS)}…` : item);
    if (!items.length) continue;
    sections.push({ key, items });
  }
  return {
    turn: Number.isSafeInteger(entry.turn) && (entry.turn as number) >= 0 ? entry.turn as number : null,
    source: typeof entry.source === "string" ? entry.source.slice(0, 40) : null,
    sections,
  };
}

/** A duration or a count; anything else stays null so the card says "unknown" instead of guessing. */
function compactNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function compactText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.length > COMPACT_MAX_CHARS ? `${value.slice(0, COMPACT_MAX_CHARS - 1)}…` : value;
}

/** The compaction status entry of `pi-protokoll`: missing, unknown or oversized fields degrade to null or fewer steps. */
export function projectCompactEntry(data: unknown): ViewCompact | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const entry = data as Record<string, unknown>;
  const steps: ViewCompactStep[] = Array.isArray(entry.steps) ? entry.steps.slice(0, COMPACT_MAX_STEPS).map(step => {
    const value = (typeof step === "object" && step !== null ? step : {}) as Record<string, unknown>;
    return {
      label: compactText(value.label) ?? "",
      state: value.state === "ok" ? "ok" as const : value.state === "fail" ? "fail" as const : "skipped" as const,
      ms: compactNumber(value.ms),
      note: compactText(value.note),
    };
  }).filter(step => step.label !== "") : [];
  return {
    outcome: compactText(entry.outcome),
    startedAt: compactText(entry.startedAt),
    durationMs: compactNumber(entry.durationMs),
    steps,
    notes: Array.isArray(entry.notes)
      ? entry.notes.map(compactText).filter((note): note is string => note !== null).slice(0, COMPACT_MAX_NOTES)
      : [],
    condensedTurns: compactNumber(entry.condensedTurns),
    detailTurns: compactNumber(entry.detailTurns),
    keptTurns: compactNumber(entry.keptTurns),
    missingTurns: compactNumber(entry.missingTurns),
    backfilled: compactNumber(entry.backfilled),
    newlyFolded: compactNumber(entry.newlyFolded),
    pending: compactNumber(entry.pending),
    error: compactText(entry.error),
  };
}

export function projectEntry(entry: SessionEntry): ViewMessage | null {
  if (entry.type === "custom") {
    // The compaction status entry becomes its own card; every other custom entry keeps its old behaviour.
    if (entry.customType === PROTOKOLL_COMPACT_ENTRY) {
      const compact = projectCompactEntry(entry.data);
      if (!compact) return null;
      return { id: entry.id, role: "compact", timestamp: entry.timestamp, blocks: [], compact };
    }
    // Only the protocol entries become cards; every other custom entry keeps its old behaviour.
    if (entry.customType !== PROTOKOLL_ENTRY) return null;
    const protocol = projectProtocolEntry(entry.data);
    if (!protocol) return null;
    return { id: entry.id, role: "protocol", timestamp: entry.timestamp, blocks: [], protocol };
  }
  if (entry.type === "custom_message") {
    if (!entry.display) return null;
    return {
      id: entry.id,
      role: "notice",
      timestamp: entry.timestamp,
      blocks: contentBlocks(entry.content),
    };
  }
  if (entry.type !== "message") return null;
  const { message } = entry;
  if (message.role === "user" || message.role === "assistant") {
    return {
      id: entry.id,
      role: message.role,
      timestamp: entry.timestamp,
      blocks: contentBlocks(message.content),
      ...(message.role === "assistant" ? { ...(message.stopReason === "error" && message.errorMessage ? { error: message.errorMessage } : {}), usage: {
        input: message.usage.input,
        output: message.usage.output,
        cacheRead: message.usage.cacheRead,
        cacheWrite: message.usage.cacheWrite,
        ...(message.usage.reasoning === undefined ? {} : { reasoning: message.usage.reasoning }),
        totalTokens: message.usage.totalTokens,
        cost: message.usage.cost.total,
      }, model: `${message.provider}/${message.model}` } : {}),
    };
  }
  if (message.role === "toolResult") {
    return {
      id: entry.id,
      role: "tool",
      timestamp: entry.timestamp,
      blocks: contentBlocks(message.content),
      isError: message.isError,
      toolCallId: message.toolCallId,
      toolName: message.toolName,
    };
  }
  return null;
}

export function sessionTitle(name: string | undefined, messages: ViewMessage[]): string {
  const explicit = name?.trim();
  if (explicit) return explicit;
  const firstUser = messages.find((message) => message.role === "user");
  const text = displayUserMessage(firstUser?.blocks.find((block) => block.kind === "text")?.text ?? "").text.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 50) : "当前会话";
}

export function projectSession(ctx: ExtensionContext, name?: string, pluginIds: readonly string[] = []): SessionView {
  const messages = ctx.sessionManager.getBranch().flatMap((entry) => {
    const message = projectEntry(entry);
    return message ? [message] : [];
  });
  return {
    schemaVersion: 1,
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
    name: sessionTitle(name, messages),
    model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : null,
    thinkingLevel: ctx.thinkingLevel ?? null,
    thinkingLevels: ctx.model ? getSupportedThinkingLevels(ctx.model) : ["off"],
    idle: ctx.isIdle(),
    paused: sessionPaused(ctx.sessionManager.getBranch()),
    contextUsage: ctx.getContextUsage() ?? null,
    messages,
    pluginEntries: projectPluginEntries(ctx.sessionManager.getBranch(), pluginIds),
  };
}
