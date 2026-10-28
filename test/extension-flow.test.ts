import { createEventBus } from "@earendil-works/pi-coding-agent";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import piWeb from "../src/host/server/bootstrap/pi-host.ts";
import { PROTOKOLL_PROGRESS_CHANNEL } from "../src/host/server/sessions/view.ts";
import type { Bridge } from "../src/host/server/transport/bridge.ts";
import type { WorkspaceRegistry } from "../src/host/server/workspaces/workspaces.ts";
import type { WorkspaceSessions } from "../src/host/server/sessions/workspace-sessions.ts";
import { controlledReply } from "./helpers/controlled-reply.ts";
import { ExtensionHandlers } from "./helpers/extension-handlers.ts";

test("web keeps a fresh Pi sender after creating a session", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-web-flow-"));
  const canonicalTemporary = await realpath(temporary);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(temporary, "agent");
  const handlers = new ExtensionHandlers();
  const progressBus = createEventBus();
  const delivered: string[] = [];
  const deliveryOptions: unknown[] = [];
  let busy = false;
  const openedPages: string[] = [];
  const notices: Array<"info" | "warning" | "error" | undefined> = [];
  let failToOpen = false;
  let command: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
  let pageUrl = "";
  let oldRuntimeStale = false;
  const context = (id: string) => ({
    cwd: temporary,
    model: undefined,
    thinkingLevel: "medium",
    sessionManager: {
      getSessionId: () => id,
      getSessionName: () => undefined,
      getBranch: () => [],
    },
    isIdle: () => !busy,
    getContextUsage: () => undefined,
    ui: {
      notify(message: string, type?: "info" | "warning" | "error") {
        pageUrl = message.slice("pi-webapp: ".length);
        notices.push(type);
      },
      setStatus() {},
    },
  });
  const fresh = {
    ...context("new"),
    async sendUserMessage(text: string, options?: unknown) { delivered.push(text); deliveryOptions.push(options); },
  } as unknown as ExtensionCommandContext;
  const initial = {
    ...context("old"),
    async newSession(options?: { withSession?: (ctx: ExtensionCommandContext) => Promise<void> }) {
      oldRuntimeStale = true;
      await handlers.get("session_shutdown")?.({ reason: "new" }, initial);
      await options?.withSession?.(fresh);
      await handlers.get("session_start")?.({ type: "session_start" }, fresh);
      return { cancelled: false };
    },
  } as unknown as ExtensionCommandContext;
  piWeb({
    events: progressBus,
    registerTool() {},
    on(event: string, handler: (event: unknown, ctx: unknown) => void) { return handlers.set(event, handler); },
    getActiveTools: () => [], setActiveTools() {}, getAllTools: () => [],
    registerCommand(name: string, definition: { handler: typeof command }) { if (name === "web") command = definition.handler; },
    getSessionName() { if (oldRuntimeStale) throw new Error("stale Pi API"); return undefined; },
    sendUserMessage() { if (oldRuntimeStale) throw new Error("stale Pi API"); },
  } as unknown as ExtensionAPI, async (url) => {
    openedPages.push(url);
    if (failToOpen) throw new Error("no browser available");
    return true;
  });
  assert.ok(command);
  await command("", initial);
  const url = new URL(pageUrl);
  assert.deepEqual(openedPages, [pageUrl]);
  await command("", initial);
  assert.deepEqual(openedPages, [pageUrl, pageUrl]);
  failToOpen = true;
  await command("", initial);
  assert.deepEqual(openedPages, [pageUrl, pageUrl, pageUrl]);
  assert.deepEqual(notices, ["info", "info", "warning"]);
  const headers = { Authorization: `Bearer ${url.hash.slice(1)}`, "Content-Type": "application/json", Origin: url.origin };
  const shared = (globalThis as Record<symbol, { bridge: Bridge | null; workspaceSessions: unknown; selected: "tui" | "sdk" }>)[Symbol.for(`pi-web.bridge-state:${new URL("../src/host/server/bootstrap/pi-host.ts", import.meta.url).href}`)];
  try {
    const created = await fetch(`${url.origin}/api/new-session`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "old" }),
    });
    assert.equal(created.status, 202);
    const snapshot = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal((await snapshot.json()).sessionId, "new");
    const sent = await fetch(`${url.origin}/api/message`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "new", text: "hello" }),
    });
    assert.equal(sent.status, 202);
    assert.deepEqual(delivered, ["hello"]);
    busy = true;
    for (const delivery of ["steer", "followUp"]) {
      const appended = await fetch(`${url.origin}/api/message`, {
        method: "POST", headers, body: JSON.stringify({ sessionId: "new", text: delivery, delivery }),
      });
      assert.equal(appended.status, 202);
    }
    assert.deepEqual(delivered, ["hello", "steer"], "a web follow-up stays editable rather than entering Pi immediately");
    const pending = async () => (await (await fetch(`${url.origin}/api/session`, { headers })).json()).queuedPrompts as Array<{ id: string; revision: number; text: string }>;
    const update = async (item: { id: string; revision: number }, action: object) => fetch(`${url.origin}/api/prompt-queue`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "new", id: item.id, revision: item.revision, action }),
    });
    const row = (await pending())[0]!;
    assert.equal((await update(row, { kind: "edit", text: "edited follow-up" })).status, 202);
    assert.equal((await update(row, { kind: "remove" })).status, 409, "stale edits cannot delete a changed TUI row");
    const edited = (await pending())[0]!;
    assert.equal((await update(edited, { kind: "steer" })).status, 202);
    assert.deepEqual(delivered, ["hello", "steer", "edited follow-up"]);
    assert.deepEqual(deliveryOptions.slice(1), [
      { expandPromptTemplates: true, deliverAs: "steer" }, { expandPromptTemplates: true, deliverAs: "steer" },
    ], "the replacement TUI context receives steering, not the stale Pi API");
    for (const text of ["delete this", "automatic next"]) await fetch(`${url.origin}/api/message`, { method: "POST", headers, body: JSON.stringify({ sessionId: "new", text, delivery: "followUp" }) });
    assert.equal((await update((await pending())[0]!, { kind: "remove" })).status, 202);
    busy = false;
    await handlers.get("agent_settled")?.({ type: "agent_settled" }, fresh);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(delivered, ["hello", "steer", "edited follow-up", "automatic next"]);
    assert.equal((await pending()).length, 0);
    // A deleted workspace must not turn unrelated list refreshes into Sentry errors.
    const registry = (shared as unknown as { workspaces: WorkspaceRegistry }).workspaces;
    const stalePath = join(temporary, "removed-worktree");
    const stale = await registry.add(stalePath, true);
    const savedSession = SessionManager.create(stale.path);
    savedSession.appendMessage({ role: "user", content: "saved before removal", timestamp: Date.now() });
    savedSession.appendMessage({ role: "assistant", content: [{ type: "text", text: "saved" }], timestamp: Date.now() } as Parameters<SessionManager["appendMessage"]>[0]);
    await rm(stalePath, { recursive: true });
    const workspaceErrors: unknown[] = [];
    const originalReport = shared.bridge!.reportError;
    shared.bridge!.reportError = (cause) => { workspaceErrors.push(cause); return "event"; };
    try {
      for (let refresh = 0; refresh < 2; refresh++) {
        const listing = await (await fetch(`${url.origin}/api/workspaces`, { headers })).json();
        assert.equal(listing.items.find((item: { id: string }) => item.id === stale.id).available, false);
        assert.ok(listing.sessions.some((item: { id: string }) => item.id === "new"));
        assert.ok(!listing.sessions.some((item: { workspaceId: string }) => item.workspaceId === stale.id));
      }
      const healthy = registry.list().find((item) => item.path === canonicalTemporary)!;
      const selected = await fetch(`${url.origin}/api/session/select`, {
        method: "POST", headers, body: JSON.stringify({ sessionId: "new", workspaceId: healthy.id, id: "new", path: "" }),
      });
      assert.equal(selected.status, 202);
      assert.deepEqual(workspaceErrors, []);
      for (const route of ["/api/workspace/select", "/api/workspace/new-session", "/api/session/select"]) {
        const response = await fetch(`${url.origin}${route}`, {
          method: "POST", headers,
          body: JSON.stringify({ sessionId: "new", id: stale.id, workspaceId: stale.id, path: "stale-session.jsonl" }),
        });
        const body = await response.json();
        assert.equal(body.error, "工作区目录不可用，请恢复目录或从列表移除后重新添加");
        assert.equal(body.errorCode, "validation_error");
        assert.equal((await (await fetch(`${url.origin}/api/session`, { headers })).json()).sessionId, "new");
      }
      await mkdir(stalePath);
      const restored = await (await fetch(`${url.origin}/api/workspaces`, { headers })).json();
      assert.notEqual(restored.items.find((item: { id: string }) => item.id === stale.id).available, false);
      assert.ok(restored.sessions.some((item: { id: string }) => item.id === savedSession.getSessionId()));
      await rm(stalePath, { recursive: true });
      const removed = await fetch(`${url.origin}/api/workspace/remove`, {
        method: "POST", headers, body: JSON.stringify({ sessionId: "new", id: stale.id }),
      });
      assert.equal(removed.status, 202);
      assert.deepEqual(workspaceErrors, []);
    } finally {
      shared.bridge!.reportError = originalReport;
    }
    // TUI events use the same observer, including start-time correlation and end/message deduplication.
    const instrumented = shared as unknown as { telemetry: { enabled: boolean; session(value: string): string }; operation?: { requestId: string; operationId: string }; bridge: Bridge };
    const previousTelemetry = instrumented.telemetry;
    const report = instrumented.bridge.reportError;
    const diagnostic: Record<string, unknown>[] = [];
    instrumented.telemetry = { enabled: true, session: () => "anonymous" };
    instrumented.bridge.reportError = (_cause, context = {}) => { diagnostic.push(context); return "event"; };
    try {
      instrumented.operation = { requestId: "request-start", operationId: "operation-start" };
      handlers.get("tool_execution_start")?.({ toolCallId: "private-call", toolName: "bash", args: { command: "private command" } }, fresh);
      instrumented.operation = { requestId: "request-new", operationId: "operation-new" };
      const content = [{ type: "text", text: "private output\n\nCommand exited with code 7" }];
      handlers.get("tool_execution_end")?.({ toolCallId: "private-call", toolName: "bash", isError: true, result: { content } }, fresh);
      handlers.get("message_end")?.({ message: { role: "toolResult", toolCallId: "private-call", toolName: "bash", isError: true, content } }, fresh);
      assert.equal(diagnostic.length, 1);
      assert.equal(diagnostic[0]?.operationId, "operation-start");
      assert.equal(diagnostic[0]?.exitCode, 7);
      assert.equal(diagnostic[0]?.level, "warning");
      assert.ok(!JSON.stringify(diagnostic).includes("private"));
    } finally {
      instrumented.telemetry = previousTelemetry; instrumented.bridge.reportError = report; instrumented.operation = undefined;
    }
    const nextDirectory = join(temporary, "another-project");
    const added = await fetch(`${url.origin}/api/workspace/add`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "new", path: nextDirectory, create: true }),
    });
    assert.equal(added.status, 202, await added.text());
    const changed = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal((await changed.json()).cwd, await realpath(nextDirectory));
    const workspaces = await fetch(`${url.origin}/api/workspaces`, { headers });
    const listed = await workspaces.json();
    assert.equal(listed.items.length, 2);
    const initialWorkspace = listed.items.find((item: { path: string }) => item.path === canonicalTemporary);
    const selected = await fetch(`${url.origin}/api/workspace/select`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: (await (await fetch(`${url.origin}/api/session`, { headers })).json()).sessionId, id: initialWorkspace.id }),
    });
    assert.equal(selected.status, 202, await selected.text());
    const back = await fetch(`${url.origin}/api/session`, { headers });
    assert.equal((await back.json()).cwd, temporary);
    const otherDirectory = await realpath(nextDirectory);
    const other = SessionManager.create(otherDirectory);
    other.appendMessage({ role: "user", content: "other workspace", timestamp: Date.now() });
    other.appendMessage({ role: "assistant", content: [{ type: "text", text: "ready" }], timestamp: Date.now(), provider: "test", model: "model", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } } } as Parameters<SessionManager["appendMessage"]>[0]);
    const all = await (await fetch(`${url.origin}/api/workspaces`, { headers })).json();
    const otherWorkspace = all.items.find((item: { path: string }) => item.path === otherDirectory);
    const otherSession = all.sessions.find((item: { id: string }) => item.id === other.getSessionId());
    assert.equal(otherSession.workspaceId, otherWorkspace.id);
    const switched = await fetch(`${url.origin}/api/session/select`, {
      method: "POST", headers,
      body: JSON.stringify({ sessionId: "new", workspaceId: otherWorkspace.id, id: otherSession.id, path: otherSession.path }),
    });
    assert.equal(switched.status, 202, await switched.text());
    assert.equal((await (await fetch(`${url.origin}/api/session`, { headers })).json()).sessionId, other.getSessionId());
    const sessions = shared.workspaceSessions as WorkspaceSessions;
    const running = sessions.session!;
    const reply = await controlledReply(running, "Background reply completed");
    await sessions.send("Continue in the background"); await reply.ready;
    handlers.get("message_update")?.({ message: { role: "assistant", timestamp: Date.now(), content: [{ type: "text", text: "TUI partial progress" }] } }, fresh);
    const selectTui = await fetch(`${url.origin}/api/session/select`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: other.getSessionId(), workspaceId: initialWorkspace.id, id: "new", path: "" }),
    });
    assert.equal(selectTui.status, 202, await selectTui.text());
    assert.ok(JSON.stringify((await (await fetch(`${url.origin}/api/session`, { headers })).json()).streaming).includes("TUI partial progress"));
    handlers.get("message_end")?.({ message: { role: "assistant", content: [] } }, fresh);
    assert.equal(running.isIdle, false, "switching to the TUI must not stop SDK work");
    const freshChat = await fetch(`${url.origin}/api/workspace/new-session`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: "new", id: initialWorkspace.id }),
    });
    assert.equal(freshChat.status, 202, await freshChat.text());
    const emptyId = sessions.snapshot().sessionId;
    const emptyFile = sessions.session!.sessionManager.getSessionFile();
    const returnToRunning = () => fetch(`${url.origin}/api/session/select`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: sessions.snapshot().sessionId, workspaceId: otherWorkspace.id, id: other.getSessionId(), path: "" }),
    });
    assert.equal((await returnToRunning()).status, 202, "cached sessions can be selected without a saved path");
    assert.equal(sessions.session, running);
    const withBackground = await (await fetch(`${url.origin}/api/workspaces`, { headers })).json();
    assert.ok(withBackground.sessions.some((item: { id: string }) => item.id === emptyId), "unsaved background chats stay in the sidebar");
    assert.ok(withBackground.sessions.some((item: { id: string }) => item.id === "new"), "the TUI stays reachable while in the background");
    const returnToEmpty = await fetch(`${url.origin}/api/session/select`, {
      method: "POST", headers, body: JSON.stringify({ sessionId: other.getSessionId(), workspaceId: initialWorkspace.id, id: emptyId, path: emptyFile ?? "" }),
    });
    assert.equal(returnToEmpty.status, 202, await returnToEmpty.text());
    reply.finish(); await running.waitForIdle();
    assert.equal((await (await fetch(`${url.origin}/api/session`, { headers })).json()).sessionId, emptyId);
    assert.equal((await returnToRunning()).status, 202);
    assert.ok(JSON.stringify(sessions.snapshot().messages).includes("Background reply completed"));
    const retired = shared.bridge!;
    const sdkSessions = shared.workspaceSessions;
    // Simulate /reload retaining a bridge from a different production build.
    (retired as { buildId: string }).buildId = "prior-build";
    await command("", fresh);
    assert.notEqual(shared.bridge, retired);
    assert.equal(shared.workspaceSessions, sdkSessions);
    const reopened = new URL(pageUrl);
    const retained = await fetch(`${reopened.origin}/api/session`, { headers: { Authorization: `Bearer ${reopened.hash.slice(1)}` } });
    assert.equal((await retained.json()).sessionId, other.getSessionId());
    // Old bridges can survive /reload until /web upgrades them.
    const oldBridge = shared.bridge!;
    (oldBridge as unknown as { breadcrumb?: unknown }).breadcrumb = undefined;
    (oldBridge as unknown as { reportError?: unknown }).reportError = undefined;
    assert.doesNotThrow(() => handlers.get("agent_start")?.({}, fresh));
    assert.doesNotThrow(() => handlers.get("agent_settled")?.({}, fresh));
    // A pre-Sentry SDK class must be recreated without losing its session manager.
    const legacy = shared.workspaceSessions as { telemetryVersion?: number };
    Object.defineProperty(legacy, "telemetryVersion", { value: undefined, configurable: true });
    await command("", fresh);
    assert.notEqual(shared.workspaceSessions, legacy);
    assert.equal((shared.workspaceSessions as { telemetryVersion: number }).telemetryVersion, 2);
    const upgraded = new URL(pageUrl);
    const migrated = await fetch(`${upgraded.origin}/api/session`, { headers: { Authorization: `Bearer ${upgraded.hash.slice(1)}` } });
    assert.equal((await migrated.json()).sessionId, other.getSessionId());
    // A legacy host used only through the TUI has no active SDK session.
    const inactive = shared.workspaceSessions as { dispose(): Promise<void> };
    await inactive.dispose();
    shared.selected = "tui";
    Object.defineProperty(inactive, "telemetryVersion", { value: undefined, configurable: true });
    (shared.bridge as unknown as { reportError?: unknown }).reportError = undefined;
    await command("", fresh);
    assert.notEqual(shared.workspaceSessions, inactive);
    assert.equal((shared.workspaceSessions as { session: unknown }).session, null);
    const tuiBridge = new URL(pageUrl);
    const tuiSession = await fetch(`${tuiBridge.origin}/api/session`, { headers: { Authorization: `Bearer ${tuiBridge.hash.slice(1)}` } });
    assert.equal((await tuiSession.json()).sessionId, "new");
    // Compaction runs outside the message flow: the browser needs the pass to start the working
    // state and Pi only clears that flag after session_compact returns, so it must be ended again.
    const observedBridge = shared.bridge!;
    const realPublish = observedBridge.publish.bind(observedBridge);
    const published: boolean[] = [];
    const liveLines: Array<string | null> = [];
    observedBridge.publish = (event) => { if (event.type === "snapshot") { published.push(event.session.idle); liveLines.push(event.session.compactProgress?.label ?? null); } realPublish(event); };
    busy = true;
    await handlers.get("session_before_compact")?.({}, fresh);
    await handlers.get("session_compact")?.({}, fresh);
    assert.deepEqual(published, [false, false], "both edges of the pass reach the browser while Pi is compacting");
    busy = false;
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(published.at(-1), true, "a finished compaction must stop the browser's working timer");
    // the steps of a running pass reach the browser over the shared bus, without being stored
    progressBus.emit(PROTOKOLL_PROGRESS_CHANNEL, { version: 1, session: "new", run: "compaction", title: "protokoll compaction", step: 2, steps: 5, label: "older turns into the state of work", state: "run", ms: 4200, closed: false, lines: [{ label: "collect protocols", state: "ok", ms: 1200, chars: 0, thinking: false }, { label: "older turns into the state of work", state: "run", ms: 3000, chars: 1400, thinking: true }] });
    assert.equal(liveLines.at(-1), "older turns into the state of work", "a bus line publishes the current step");
    const live = await (await fetch(`${tuiBridge.origin}/api/session`, { headers: { Authorization: `Bearer ${tuiBridge.hash.slice(1)}` } })).json();
    assert.equal(live.compactProgress?.steps, 5);
    assert.equal(live.compactProgress?.ms, 4200);
    assert.equal(live.compactProgress?.lines?.[1]?.chars, 1400, "the browser sees how much the model has already written");
    assert.equal(live.compactProgress?.lines?.[1]?.thinking, true);
    progressBus.emit(PROTOKOLL_PROGRESS_CHANNEL, { version: 1, session: "other", run: "compaction", title: "t", step: 1, steps: 1, label: "another session", state: "run", ms: 1, closed: false });
    assert.equal(liveLines.at(-1), "older turns into the state of work", "another session's pass never shows up here");
    progressBus.emit(PROTOKOLL_PROGRESS_CHANNEL, { version: 1, session: "new", run: "compaction", title: "protokoll compaction", step: 5, steps: 5, label: "", state: "ok", ms: 9000, closed: true });
    assert.equal(liveLines.at(-1), null, "the last line of the pass takes the live row away again");
    const settled = await (await fetch(`${tuiBridge.origin}/api/session`, { headers: { Authorization: `Bearer ${tuiBridge.hash.slice(1)}` } })).json();
    assert.equal(settled.compactProgress ?? null, null, "a finished pass leaves nothing behind");
    observedBridge.publish = realPublish;
  } finally {
    await (shared.workspaceSessions as { dispose(): Promise<void> } | null)?.dispose();
    shared.workspaceSessions = null;
    await shared.bridge?.close();
    shared.bridge = null;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(temporary, { recursive: true, force: true });
  }
});
