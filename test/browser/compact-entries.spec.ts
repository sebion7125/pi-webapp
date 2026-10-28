import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startBridge, type BridgeHost } from "../../src/host/server/transport/bridge.ts";
import { NodeTelemetry } from "../../src/platform/telemetry/telemetry.ts";
import { projectEntry } from "../../src/host/server/sessions/view.ts";
import type { SessionView, ViewMessage } from "../../src/host/server/sessions/view.ts";

const entry = (value: Record<string, unknown>) => value as unknown as Parameters<typeof projectEntry>[0];

/** One pi-protokoll compaction status entry, projected exactly as the host writes it into a snapshot. */
function compactMessage(id: string, durationMs: number, outcome: string): ViewMessage {
  return projectEntry(entry({
    id, type: "custom", customType: "protokoll-compact", parentId: "protocol-1", timestamp: "2026-01-01T00:00:05Z",
    data: {
      version: 1, outcome, startedAt: "2026-01-01T00:00:00.000Z", durationMs,
      steps: [
        { label: "turn 2: write missing protocol", state: "ok", ms: 1200 },
        { label: "review rules", state: "ok", ms: 900, note: "3 rules kept" },
        { label: "fold backlog", state: "skipped", ms: 0, note: "skipped" },
      ],
      notes: ["3 turns condensed – 2 in detail, 3 kept in full"],
      tokensBefore: 9000, condensedTurns: 3, detailTurns: 2, keptTurns: 3, missingTurns: 0,
      backfilled: 1, newlyFolded: 0, pending: 0,
    },
  }))!;
}

test("compaction status entries render as a card with duration and step times", async ({ page }) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-compact-browser-"));
  const text = (id: string, role: "user" | "assistant", content: string): ViewMessage => ({
    id, role, timestamp: "2026-01-01T00:00:00Z", blocks: [{ kind: "text", text: content }],
  });
  const messages = [
    text("user-1", "user", "Compact the session"),
    text("assistant-1", "assistant", "The compaction is recorded."),
    compactMessage("compact-1", 45_000, "protocol"),
  ];
  let session: SessionView = {
    schemaVersion: 1, sessionId: "compact-session", cwd, name: "Compaction chat", model: "example/model",
    thinkingLevel: "off", thinkingLevels: ["off"], idle: true, contextUsage: null, messages, pluginEntries: [], streaming: null,
  };
  const host: BridgeHost = {
    snapshot: () => session, models: () => [{ provider: "example", id: "model", name: "Example" }], commands: () => [],
    hosted: {
      inventory: async () => ({ plugins: [] }), manage: async () => { throw new Error("no fixtures"); },
      action: async () => { throw new Error("no fixtures"); }, views: async () => { throw new Error("no fixtures"); },
      asset: async () => null,
    },
    async send() {}, abort() {}, async newSession() {}, async setModel() {}, async setThinkingLevel() {},
    config: () => ({ projectTrusted: false, global: { packages: [], extensions: [], skills: [] }, project: { packages: [], extensions: [], skills: [] }, installed: { packages: [], extensions: [], skills: [] } }),
    async updateConfig() { return this.config(); },
    async workspaces() { return { items: [], activeId: null, sessions: [] }; },
    async addWorkspace() {}, async selectWorkspace() {}, async newSessionInWorkspace() {}, async removeWorkspace() {}, async selectSession() {},
  };
  const bridge = await startBridge(host, fileURLToPath(new URL("../../web/dist/", import.meta.url)), new NodeTelemetry({ env: { PI_WEB_SENTRY_ENABLED: "false" }, monitor: false }));
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.addInitScript(() => { localStorage.setItem("pi-web-locale", "en"); localStorage.setItem("pi-web-theme", "dark"); });
  await page.setViewportSize({ width: 1280, height: 900 });
  try {
    await page.goto(bridge.url);
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await expect(page.locator(".pi-message[data-message-role='assistant']")).toContainText("The compaction is recorded.");

    // History: one collapsed card showing how long the pass took.
    const card = page.locator("[data-compact-card]");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-compact-outcome", "protocol");
    await expect(card).toHaveAttribute("data-compact-duration-ms", "45000");
    await expect(card).toContainText("Compaction");
    await expect(card).toContainText("45 s");
    await expect(card).toContainText("3 turns condensed, 2 in detail, 3 kept in full, 1 written afterwards");
    await expect(card).not.toContainText("0 without protocol");
    await expect(card.locator("[data-compact-section]")).toHaveCount(0);

    // Expand: duration, counts, the steps with their own times and the notes.
    await card.locator("[data-disclosure-row]").click();
    await expect(card).toHaveAttribute("data-expanded", "true");
    await expect(card.locator('[data-compact-section="duration"]')).toContainText("45 s");
    await expect(card.locator('[data-compact-section="duration"]')).toContainText("2026-01-01T00:00:00.000Z");
    await expect(card.locator('[data-compact-section="counts"]')).toContainText("0 without protocol");
    await expect(card.locator('[data-compact-section="steps"]')).toContainText("turn 2: write missing protocol");
    await expect(card.locator('[data-compact-section="steps"]')).toContainText("1.2 s");
    await expect(card.locator('[data-compact-section="steps"]')).toContainText("3 rules kept");
    await expect(card.locator('[data-compact-step-state="skipped"]')).toContainText("fold backlog");
    await expect(card.locator('[data-compact-section="notes"]')).toContainText("3 turns condensed – 2 in detail, 3 kept in full");
    // Collapse again.
    await card.locator("[data-disclosure-row]").click();
    await expect(card).not.toHaveAttribute("data-expanded");
    await expect(card.locator("[data-compact-section]")).toHaveCount(0);

    // Live: the pass of a running session arrives with the next snapshot, without duplicates.
    session = { ...session, messages: [...messages, compactMessage("compact-2", 900, "no_room")] };
    bridge.publish({ type: "snapshot", session });
    await expect(card).toHaveCount(2);
    bridge.publish({ type: "snapshot", session });
    bridge.publish({ type: "snapshot", session });
    await expect(card).toHaveCount(2);
    const second = page.locator('[data-compact-card][data-compact-outcome="no_room"]');
    await expect(second).toContainText("900 ms");
    await expect(second).toContainText("no room – Pi summarized");

    // A reload shows both cards again.
    await page.reload();
    await expect(card).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
