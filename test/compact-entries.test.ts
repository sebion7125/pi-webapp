import assert from "node:assert/strict";
import test from "node:test";
import { PROTOKOLL_COMPACT_ENTRY, projectCompactProgress, projectEntry, projectPluginEntries } from "../src/host/server/sessions/view.ts";
import { conversationTurns } from "../src/host/client/conversation-turns.ts";
import { parseBridgeEvent } from "../src/contracts/bridge-events.ts";
import type { BridgeEvent } from "../src/contracts/bridge-contract.ts";
import type { ViewCompact, ViewMessage } from "../src/host/client/pi-bridge.ts";

type Entry = Parameters<typeof projectEntry>[0];
const entry = (value: Record<string, unknown>) => value as unknown as Entry;

// Shape written by pi-protokoll 0.9.2: a `custom` session entry next to the compaction it produced.
const compactEntry = (id: string, data: Record<string, unknown> = {}) => entry({
  id, type: "custom", customType: PROTOKOLL_COMPACT_ENTRY, parentId: "protocol-1", timestamp: "2026-01-01T00:00:05Z",
  data: {
    version: 1, outcome: "protocol", startedAt: "2026-01-01T00:00:00.000Z", durationMs: 45_000,
    steps: [
      { label: "turn 2: write missing protocol", state: "ok", ms: 1200 },
      { label: "review rules", state: "ok", ms: 900, note: "3 rules kept" },
      { label: "fold backlog", state: "skipped", ms: 0, note: "skipped" },
    ],
    notes: ["3 turns condensed – 2 in detail, 3 kept in full"],
    tokensBefore: 9000, condensedTurns: 3, detailTurns: 2, keptTurns: 3, missingTurns: 0,
    backfilled: 1, newlyFolded: 0, pending: 0, dropped: [],
    ...data,
  },
});

test("a compaction status entry becomes its own compact message with the time of every step", () => {
  const message = projectEntry(compactEntry("compact-1"));
  assert.equal(message?.role, "compact");
  assert.equal(message?.id, "compact-1");
  assert.deepEqual(message?.blocks, []);
  assert.equal(message?.compact?.outcome, "protocol");
  assert.equal(message?.compact?.durationMs, 45_000);
  assert.equal(message?.compact?.condensedTurns, 3);
  assert.equal(message?.compact?.missingTurns, 0, "zero stays zero instead of vanishing");
  assert.deepEqual(message?.compact?.steps[1], { label: "review rules", state: "ok", ms: 900, note: "3 rules kept" });
  assert.deepEqual(message?.compact?.steps[2], { label: "fold backlog", state: "skipped", ms: 0, note: "skipped" });
});

test("missing, odd and oversized compaction fields degrade instead of failing", () => {
  const bare = projectEntry(compactEntry("compact-bare", {}));
  assert.equal(bare?.role, "compact");
  assert.deepEqual(bare?.compact?.steps.length, 3);

  const odd = projectEntry(compactEntry("compact-odd", {
    outcome: 7, startedAt: null, durationMs: "45", condensedTurns: -2, keptTurns: 2,
    steps: [{ state: "weird" }, { label: "", state: "ok", ms: 5 }, { label: "ran", state: "fail", ms: 40 }, "step"],
    notes: [null, 7, " kept ", "Pi summarizes itself"],
    error: "provider timeout",
  }));
  assert.deepEqual(odd?.compact, {
    outcome: null, startedAt: null, durationMs: null,
    steps: [{ label: "ran", state: "fail", ms: 40, note: null }],
    notes: [" kept ", "Pi summarizes itself"],
    condensedTurns: null, detailTurns: 2, keptTurns: 2, missingTurns: 0,
    backfilled: 1, newlyFolded: 0, pending: 0, error: "provider timeout",
  });

  const empty = projectEntry(entry({ id: "compact-empty", type: "custom", customType: PROTOKOLL_COMPACT_ENTRY, parentId: null, timestamp: "2026-01-01T00:00:05Z", data: {} }));
  assert.deepEqual(empty?.compact, {
    outcome: null, startedAt: null, durationMs: null, steps: [], notes: [],
    condensedTurns: null, detailTurns: null, keptTurns: null, missingTurns: null,
    backfilled: null, newlyFolded: null, pending: null, error: null,
  });
  for (const data of [undefined, null, "compact", []]) {
    assert.equal(projectEntry(entry({ id: "compact-shape", type: "custom", customType: PROTOKOLL_COMPACT_ENTRY, parentId: null, timestamp: "2026-01-01T00:00:05Z", data })), null, `${JSON.stringify(data)} stays out of the transcript`);
  }

  const huge = projectEntry(compactEntry("compact-huge", {
    steps: Array.from({ length: 300 }, (_value, index) => ({ label: `step ${index}`, state: "ok", ms: index })),
    notes: Array.from({ length: 100 }, (_value, index) => `note ${index}`),
    error: "x".repeat(9000),
  }));
  assert.equal(huge?.compact?.steps.length, 40);
  assert.equal(huge?.compact?.notes.length, 12);
  assert.ok((huge?.compact?.error?.length ?? 0) <= 500);
});

test("only the compaction status entry joins the transcript; other custom entries keep their behaviour", () => {
  for (const customType of ["protokoll", "protokoll-pin", "protokoll-state", "protokoll-rebuild", "protokoll-ergaenzung", "pi-webapp/paused", "plan/state"]) {
    const message = projectEntry(entry({ id: `custom-${customType}`, type: "custom", customType, parentId: null, timestamp: "2026-01-01T00:00:05Z", data: { outcome: "protocol", durationMs: 10 } }));
    assert.notEqual(message?.role, "compact", customType);
  }
  // Pi's own compaction entry stays out, as before: only the status entry carries the times.
  assert.equal(projectEntry(entry({ id: "compaction", type: "compaction", parentId: null, timestamp: "2026-01-01T00:00:05Z", summary: "earlier turns", firstKeptEntryId: "user-1" })), null);
  // The status entry is not a plugin entry, so it never reaches a plugin view as well.
  assert.deepEqual(projectPluginEntries([compactEntry("compact-1")], ["plan", "pi-webapp"]), []);
});

test("compaction messages cross the bridge and malformed compact payloads are rejected", () => {
  const message = projectEntry(compactEntry("compact-1"))!;
  const session = {
    schemaVersion: 1, sessionId: "session-1", cwd: "/workspace", name: "Chat", model: null, thinkingLevel: null,
    thinkingLevels: [], idle: true, contextUsage: null, pluginEntries: [],
    messages: [
      { id: "user-1", role: "user", timestamp: "2026-01-01T00:00:00Z", blocks: [{ kind: "text", text: "Do it" }] },
      { ...message, role: "compact" as const },
    ],
  };
  const snapshot = parseBridgeEvent({ type: "snapshot", session }) as Extract<BridgeEvent, { type: "snapshot" }>;
  assert.equal((snapshot.session.messages[1] as ViewMessage & { compact: ViewCompact }).compact.durationMs, 45_000);
  const invalid: Record<string, unknown>[] = [
    { compact: null }, { compact: "compact" }, { compact: {} },
    { compact: { durationMs: "45", steps: [], notes: [] } }, { compact: { durationMs: 45 } },
    { compact: { steps: [{ state: "ok" }], notes: [] } }, { compact: { steps: [{ label: "a", state: "weird" }], notes: [] } },
    { compact: { steps: [{ label: "a", state: "ok", ms: "5" }], notes: [] } }, { compact: { steps: [], notes: "kept" } },
    { compact: { steps: [], notes: [], keptTurns: "3" } },
  ];
  for (const fields of invalid) {
    assert.throws(() => parseBridgeEvent({ type: "snapshot", session: { ...session, messages: [{ id: "compact-1", role: "compact", timestamp: "2026-01-01T00:00:05Z", blocks: [], ...fields }] } }), /Invalid session snapshot/, JSON.stringify(fields));
  }
});

test("the compaction card joins the turn it happened in and repeated snapshots stay one card each", () => {
  const branch = [
    entry({ id: "user-1", type: "message", parentId: null, timestamp: "2026-01-01T00:00:00Z", message: { role: "user", timestamp: 0, content: [{ type: "text", text: "Do it" }] } }),
    entry({ id: "assistant-1", type: "message", parentId: "user-1", timestamp: "2026-01-01T00:00:01Z", message: {
      role: "assistant", timestamp: 1, content: [{ type: "text", text: "Done" }],
      usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      api: "test", provider: "test", model: "test", stopReason: "stop" } }),
    entry({ id: "protocol-1", type: "custom", customType: "protokoll", parentId: "assistant-1", timestamp: "2026-01-01T00:00:02Z", data: { version: 1, userEntryId: "user-1", turn: 1, source: "inline", fields: { result: ["Done"] } } }),
    compactEntry("compact-1"),
    entry({ id: "user-2", type: "message", parentId: "compact-1", timestamp: "2026-01-01T00:00:09Z", message: { role: "user", timestamp: 9, content: [{ type: "text", text: "Next" }] } }),
  ];
  const project = () => branch.flatMap(item => { const message = projectEntry(item); return message ? [message] : []; });
  const first = project(), again = project();
  assert.deepEqual(again, first, "a repeated live snapshot projects the same cards");
  assert.equal(new Set(first.map(message => message.id)).size, first.length);
  const turns = conversationTurns(first);
  assert.deepEqual(turns[0]!.messages.map(message => message.id), ["user-1", "assistant-1", "protocol-1", "compact-1"]);
  assert.equal((turns[0]!.messages.at(-1) as ViewMessage & { compact?: ViewCompact }).compact?.durationMs, 45_000);
  assert.deepEqual(turns[1]!.messages.map(message => message.role), ["user"]);
});

// pi-protokoll 0.9.3 reports the steps of a running pass over Pi's shared extension bus: the line
// is shown while the pass runs and never stored, unlike the status entry above.
const progressLine = (data: Record<string, unknown> = {}) => ({
  version: 1, session: "s1", run: "compaction", title: "protokoll compaction", step: 2, steps: 5,
  label: "fold backlog", state: "run", ms: 4200, closed: false,
  lines: [
    { label: "collect protocols", state: "ok", ms: 1200, chars: 0, thinking: false },
    { label: "fold backlog", state: "run", ms: 3000, chars: 1400, thinking: true },
    { label: "write the summary", state: "wait", ms: null, chars: 0, thinking: false, note: "skipped" },
    { label: "bogus", state: "maybe", chars: -5 },
  ],
  ...data,
});

const progressLines = [
  { label: "collect protocols", state: "ok", ms: 1200, chars: 0, thinking: false, note: null },
  { label: "fold backlog", state: "run", ms: 3000, chars: 1400, thinking: true, note: null },
  { label: "write the summary", state: "wait", ms: null, chars: 0, thinking: false, note: "skipped" },
  // an unknown state, a negative count and a missing time degrade instead of guessing
  { label: "bogus", state: "wait", ms: null, chars: null, thinking: false, note: null },
];

test("a live progress line carries every step of the pass, and an unusable payload carries nothing", () => {
  assert.deepEqual(projectCompactProgress(progressLine()), {
    session: "s1", run: "compaction", title: "protokoll compaction", step: 2, steps: 5,
    label: "fold backlog", state: "run", ms: 4200, closed: false, lines: progressLines,
  });
  assert.equal(projectCompactProgress(progressLine({ closed: true }))?.closed, true);
  for (const bad of [undefined, null, [], "x", progressLine({ version: 2 }), progressLine({ state: "maybe" }), progressLine({ ms: -1 }), progressLine({ session: 7 })]) {
    assert.equal(projectCompactProgress(bad), null, `${JSON.stringify(bad)} is not a progress line`);
  }
  // a broken counter degrades to 0, which the row reads as "no step counter" instead of guessing
  assert.equal(projectCompactProgress(progressLine({ step: 1.5 }))?.step, 0);
});

test("the wire accepts a projected progress status and rejects a broken one", () => {
  const view = {
    schemaVersion: 1, sessionId: "s1", cwd: "/tmp/x", name: "x", model: null, thinkingLevel: null,
    thinkingLevels: [], idle: false, contextUsage: null, messages: [], pluginEntries: [],
    compactProgress: projectCompactProgress(progressLine()),
  };
  assert.equal(parseBridgeEvent({ type: "snapshot", session: view }).type, "snapshot");
  assert.throws(() => parseBridgeEvent({ type: "snapshot", session: { ...view, compactProgress: { ...progressLine(), state: "maybe" } } }));
  assert.throws(() => parseBridgeEvent({ type: "snapshot", session: { ...view, compactProgress: { ...progressLine(), lines: [{ label: "x", state: "maybe" }] } } }));
});
