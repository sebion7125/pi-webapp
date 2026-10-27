import assert from "node:assert/strict";
import test from "node:test";
import { PROTOKOLL_ENTRY, projectEntry, projectPluginEntries, sessionPaused } from "../src/host/server/sessions/view.ts";
import { conversationTurns } from "../src/host/client/conversation-turns.ts";
import { parseBridgeEvent } from "../src/contracts/bridge-events.ts";
import type { BridgeEvent } from "../src/contracts/bridge-contract.ts";
import type { ViewMessage, ViewProtocol } from "../src/host/client/pi-bridge.ts";

type Entry = Parameters<typeof projectEntry>[0];
const entry = (value: Record<string, unknown>) => value as unknown as Entry;

// Shape written by pi-protokoll: a `custom` session entry, never a `custom_message`.
const protocolEntry = (id: string, turn: number, data: Record<string, unknown> = {}) => entry({
  id, type: "custom", customType: PROTOKOLL_ENTRY, parentId: "assistant-1", timestamp: "2026-01-01T00:00:02Z",
  data: { version: 1, userEntryId: "user-1", turn, source: "inline", ...data },
});

test("a protocol entry becomes its own protocol message with sections in display order", () => {
  const message = projectEntry(protocolEntry("protocol-1", 3, { fields: {
    open: ["push the branch"], result: ["Added the card"], decision: ["Project the entry read-only"],
    files: ["src/host/server/sessions/view.ts"], rule: [], revoke: [], index: ["protocol card"], tags: ["protocol, view"], other: [],
  } }));
  assert.equal(message?.role, "protocol");
  assert.equal(message?.id, "protocol-1");
  assert.deepEqual(message?.blocks, []);
  assert.deepEqual(message?.protocol, { turn: 3, source: "inline", sections: [
    { key: "result", items: ["Added the card"] },
    { key: "decision", items: ["Project the entry read-only"] },
    { key: "files", items: ["src/host/server/sessions/view.ts"] },
    { key: "open", items: ["push the branch"] },
    { key: "index", items: ["protocol card"] },
    { key: "tags", items: ["protocol, view"] },
  ] });
});

test("missing, empty and unknown protocol fields degrade instead of failing", () => {
  const bare = projectEntry(protocolEntry("protocol-bare", 4, { source: "missing" }));
  assert.equal(bare?.role, "protocol");
  assert.deepEqual(bare?.protocol, { turn: 4, source: "missing", sections: [] });

  const legacy = projectEntry(protocolEntry("protocol-legacy", 2, { fields: {
    result: ["older entry"], decision: [], files: "one plain string", open: [null, 7, "  kept  "], future_key: ["unknown field"],
  } }));
  assert.deepEqual(legacy?.protocol?.sections, [
    { key: "result", items: ["older entry"] },
    { key: "files", items: ["one plain string"] },
    { key: "open", items: ["kept"] },
    { key: "future_key", items: ["unknown field"] },
  ]);

  for (const data of [undefined, null, "protocol", []]) {
    assert.equal(projectEntry(entry({ id: "protocol-shape", type: "custom", customType: PROTOKOLL_ENTRY, parentId: null, timestamp: "2026-01-01T00:00:02Z", data })), null, `${JSON.stringify(data)} stays out of the transcript`);
  }
  const empty = projectEntry(entry({ id: "protocol-empty", type: "custom", customType: PROTOKOLL_ENTRY, parentId: null, timestamp: "2026-01-01T00:00:02Z", data: {} }));
  assert.deepEqual(empty?.protocol, { turn: null, source: null, sections: [] });
  const odd = projectEntry(entry({ id: "protocol-odd", type: "custom", customType: PROTOKOLL_ENTRY, parentId: null, timestamp: "2026-01-01T00:00:02Z", data: { turn: "three", source: 7, fields: { result: "kept" } } }));
  assert.deepEqual(odd?.protocol, { turn: null, source: null, sections: [{ key: "result", items: ["kept"] }] });

  const huge = projectEntry(protocolEntry("protocol-huge", 5, { fields: {
    result: Array.from({ length: 500 }, (_value, index) => `line ${index}`),
    decision: ["x".repeat(9000)],
  } }));
  assert.equal(huge?.protocol?.sections[0]?.items.length, 20);
  assert.ok((huge?.protocol?.sections[1]?.items[0]?.length ?? 0) <= 4001);
});

test("only protocol entries join the transcript; other custom entries keep their behaviour", () => {
  for (const customType of ["protokoll-pin", "protokoll-state", "protokoll-rebuild", "protokoll-ergaenzung", "pi-webapp/paused", "plan/state"]) {
    assert.equal(projectEntry(entry({ id: `custom-${customType}`, type: "custom", customType, parentId: null, timestamp: "2026-01-01T00:00:02Z", data: { turn: 1 } })), null, customType);
  }
  // A protocol entry is not a plugin entry, so it never reaches a plugin view as well.
  assert.deepEqual(projectPluginEntries([protocolEntry("protocol-1", 1)], ["plan", "pi-webapp"]), []);
  const pluginEntry = entry({ id: "plugin-1", type: "custom", customType: "plan/state", parentId: null, timestamp: "2026-01-01T00:00:02Z", data: { enabled: true } });
  assert.equal(projectPluginEntries([pluginEntry], ["plan"])[0]?.kind, "plan/state");
  // The pause marker keeps pausing the view even though custom entries are now partly projected.
  assert.equal(sessionPaused([entry({ id: "paused", type: "custom", customType: "pi-webapp/paused", parentId: null, timestamp: "2026-01-01T00:00:02Z" })]), true);
});

test("messages, custom notices, compaction and tool traffic project unchanged", () => {
  const notice = projectEntry(entry({ id: "notice", type: "custom_message", customType: "pi-web/resume", parentId: null, timestamp: "2026-01-01T00:00:02Z", content: "resumed", display: true }));
  assert.equal(notice?.role, "notice");
  assert.equal(projectEntry(entry({ id: "hidden-notice", type: "custom_message", customType: "pi-web/resume", parentId: null, timestamp: "2026-01-01T00:00:02Z", content: "hidden", display: false })), null);
  assert.equal(projectEntry(entry({ id: "compaction", type: "compaction", parentId: null, timestamp: "2026-01-01T00:00:02Z", summary: "earlier turns", firstKeptEntryId: "user-1" })), null);
  const call = projectEntry(entry({ id: "assistant-1", type: "message", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: {
    role: "assistant", timestamp: 0, content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } }],
    usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    api: "test", provider: "test", model: "test", stopReason: "toolUse" } }));
  assert.equal(call?.blocks[0]?.kind, "toolCall");
  const result = projectEntry(entry({ id: "tool-1", type: "message", parentId: "assistant-1", timestamp: "2026-01-01T00:00:01Z", message: {
    role: "toolResult", timestamp: 1, toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "/tmp" }] } }));
  assert.equal(result?.role, "tool");
});

test("protocol messages cross the bridge and malformed protocol payloads are rejected", () => {
  const message = projectEntry(protocolEntry("protocol-1", 3, { fields: { result: ["Added the card"], open: ["none"] } }))!;
  const session = {
    schemaVersion: 1, sessionId: "session-1", cwd: "/workspace", name: "Chat", model: null, thinkingLevel: null,
    thinkingLevels: [], idle: true, contextUsage: null, pluginEntries: [],
    messages: [
      { id: "user-1", role: "user", timestamp: "2026-01-01T00:00:00Z", blocks: [{ kind: "text", text: "Do it" }] },
      { ...message, role: "protocol" as const },
    ],
  };
  const snapshot = parseBridgeEvent({ type: "snapshot", session }) as Extract<BridgeEvent, { type: "snapshot" }>;
  assert.deepEqual(snapshot.session.messages[1]?.protocol, {
    turn: 3, source: "inline", sections: [{ key: "result", items: ["Added the card"] }, { key: "open", items: ["none"] }],
  });
  const invalid: Record<string, unknown>[] = [
    { protocol: null }, { protocol: "protocol" }, { protocol: {} },
    { protocol: { turn: "3", sections: [] } }, { protocol: { turn: {}, sections: [] } },
    { protocol: { source: 7, sections: [] } }, { protocol: { sections: [{}] } }, { protocol: { sections: [{ key: "result", items: "kept" }] } },
  ];
  for (const fields of invalid) {
    assert.throws(() => parseBridgeEvent({ type: "snapshot", session: { ...session, messages: [{ id: "protocol-1", role: "protocol", timestamp: "2026-01-01T00:00:02Z", blocks: [], ...fields }] } }), /Invalid session snapshot/, JSON.stringify(fields));
  }
});

test("protocol entries join the turn they describe and repeated snapshots stay one card each", () => {
  const branch = [
    entry({ id: "user-1", type: "message", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", timestamp: 0, content: [{ type: "text", text: "Do it" }] } }),
    entry({ id: "assistant-1", type: "message", parentId: "user-1", timestamp: "2026-01-01T00:00:01Z", message: {
      role: "assistant", timestamp: 1, content: [{ type: "text", text: "Done" }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      api: "test", provider: "test", model: "test", stopReason: "stop" } }),
    protocolEntry("protocol-1", 1, { fields: { result: ["Done"] } }),
    entry({ id: "user-2", type: "message", parentId: "protocol-1", timestamp: "2026-01-01T00:00:05Z", message: { role: "user", timestamp: 5, content: [{ type: "text", text: "Next" }] } }),
  ];
  const project = () => branch.flatMap(item => { const message = projectEntry(item); return message ? [message] : []; });
  const first = project(), again = project();
  assert.deepEqual(again, first, "a repeated live snapshot projects the same cards");
  assert.equal(new Set(first.map(message => message.id)).size, first.length);
  const turns = conversationTurns(first);
  assert.equal(turns.length, 2);
  assert.deepEqual(turns[0]!.messages.map(message => message.id), ["user-1", "assistant-1", "protocol-1"]);
  assert.equal((turns[0]!.messages.at(-1) as ViewMessage & { protocol?: ViewProtocol }).protocol?.turn, 1);
  assert.equal(turns[1]!.messages.map(message => message.role).join(","), "user");
});
