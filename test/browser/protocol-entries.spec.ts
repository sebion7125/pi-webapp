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

/** One pi-protokoll `custom` session entry, projected exactly as the host does. */
function protocolMessage(id: string, turn: number, result: string): ViewMessage {
  return projectEntry(entry({
    id, type: "custom", customType: "protokoll", parentId: "assistant-1", timestamp: "2026-01-01T00:00:02Z",
    data: {
      version: 1, userEntryId: "user-1", turn, source: turn === 1 ? "inline" : "backfill", fields: {
        result: [result], decision: [`Decision for turn ${turn}`], files: ["src/host/server/sessions/view.ts"],
        open: ["none"], rule: [], revoke: [], index: [], tags: ["protocol, browser"], other: [],
      },
    },
  }))!;
}

test("protocol entries render as collapsible cards, historically and live", async ({ page }) => {
  const cwd = await mkdtemp(join(tmpdir(), "pi-protocol-browser-"));
  const text = (id: string, role: "user" | "assistant", content: string): ViewMessage => ({
    id, role, timestamp: "2026-01-01T00:00:00Z", blocks: [{ kind: "text", text: content }],
  });
  const messages = [
    text("user-1", "user", "Add the protocol card"),
    text("assistant-1", "assistant", "The card is rendered in the chat."),
    protocolMessage("protocol-1", 1, "Implemented the collapsible card."),
  ];
  let session: SessionView = {
    schemaVersion: 1, sessionId: "protocol-session", cwd, name: "Protocol chat", model: "example/model",
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
    // The existing transcript still works.
    await expect(page.locator('[data-message-role="user"]')).toHaveCount(1);
    await expect(page.locator(".pi-message[data-message-role='assistant']")).toContainText("The card is rendered in the chat.");

    // Loaded history: the protocol entry is a collapsed card, not raw text in the answer.
    const card = page.locator("[data-protocol-card]");
    await expect(card).toHaveCount(1);
    await expect(card).toHaveAttribute("data-protocol-turn", "1");
    await expect(card).toContainText("Session protocol turn 1");
    await expect(card).toContainText("Implemented the collapsible card.");
    await expect(card.locator("[data-protocol-section]")).toHaveCount(0);

    // Expand: every section of the entry becomes readable.
    await card.locator("[data-disclosure-row]").click();
    await expect(card).toHaveAttribute("data-expanded", "true");
    await expect(card.locator("[data-protocol-section]")).toHaveCount(5);
    await expect(card.locator('[data-protocol-section="decision"]')).toContainText("Decision for turn 1");
    await expect(card.locator('[data-protocol-section="files"]')).toContainText("src/host/server/sessions/view.ts");
    await expect(card.locator('[data-protocol-section="open"]')).toContainText("none");
    // Collapse again.
    await card.locator("[data-disclosure-row]").click();
    await expect(card).not.toHaveAttribute("data-expanded");
    await expect(card.locator("[data-protocol-section]")).toHaveCount(0);

    // Live: a new entry appears in the running session, and repeating the snapshot adds no duplicate.
    session = { ...session, messages: [...messages, protocolMessage("protocol-2", 2, "Protocol written during the run.")] };
    bridge.publish({ type: "snapshot", session });
    await expect(card).toHaveCount(2);
    bridge.publish({ type: "snapshot", session });
    bridge.publish({ type: "snapshot", session });
    await expect(card).toHaveCount(2);
    await expect(page.locator('[data-protocol-card][data-protocol-turn="2"]')).toContainText("Protocol written during the run.");
    await expect(page.locator('[data-protocol-card][data-protocol-turn="2"]')).toHaveAttribute("data-protocol-source", "backfill");

    // A reload shows both cards again.
    await page.reload();
    await expect(card).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    await bridge.close();
    await rm(cwd, { recursive: true, force: true });
  }
});
