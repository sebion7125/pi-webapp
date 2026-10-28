import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { userExtensionPaths } from "../src/host/server/sessions/workspace-sessions.ts";

const ownRoot = realpathSync(join(import.meta.dirname, ".."));

/** A throwaway agent dir and workspace: one plain extension package, one web plugin package, and pi-webapp itself installed. */
function fixture() {
  const agentDir = mkdtempSync(join(tmpdir(), "pi-hosted-ext-agent-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-hosted-ext-cwd-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const pkg = (name: string, extra: Record<string, unknown> = {}) => {
    const root = join(agentDir, "packages", name);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name, version: "1.0.0", pi: { extensions: ["index.ts"] }, ...extra }));
    writeFileSync(join(root, "index.ts"), "export default function () {}\n");
    return root;
  };
  const plain = pkg("user-extension");
  const plugin = pkg("user-plugin", { piWebapp: { client: "index.ts" } });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [plain, plugin, ownRoot] }));
  // an extension in the agent dir itself is enabled the same way a terminal session sees it
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "extensions", "agent-ext.ts"), "export default function () {}\n");
  return { cwd, agentDir, plain, plugin };
}

test("a hosted session sees the user's extensions but never pi-webapp itself", async () => {
  const { cwd, plain, plugin } = fixture();
  const paths = await userExtensionPaths(cwd, false, []);
  assert.ok(paths.some(path => path.startsWith(join(plain, "index.ts")) || path === join(plain, "index.ts")), "the user's own extension is available in a hosted session");
  assert.ok(paths.some(path => path.includes("agent-ext.ts")), "extensions from the agent dir are available too");
  assert.ok(!paths.some(path => path.startsWith(ownRoot + "/")), "pi-webapp's own extension stays out, otherwise a second bridge starts");
  assert.ok(paths.some(path => path.includes("user-plugin")), "a plugin package is still resolved by the caller");
  const withoutPlugins = await userExtensionPaths(cwd, false, [realpathSync(plugin)]);
  assert.ok(!withoutPlugins.some(path => path.includes("user-plugin")), "a package that comes in as a web plugin is not loaded twice");
});
