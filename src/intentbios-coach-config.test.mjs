import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  COACH_AGENT_ID,
  COACH_TOOL_NAMES,
  SOPHIA_AGENT_ID,
  configDeepEqual,
  mergeIntentbiosCoachConfig,
  writeCoachWorkspace,
} from "./intentbios-coach-config.mjs";

const pluginPath = "/app/plugins/intentbios";
const workspaceDir = "/data/.openclaw/workspaces/intentbios-coach";

function merge(config, extra = {}) {
  return mergeIntentbiosCoachConfig(config, {
    apiUrl: "https://coachapp-production-0a92.up.railway.app",
    pluginPath,
    workspaceDir,
    ...extra,
  });
}

test("enables the coach agent, plugin, and chat completions", () => {
  const merged = merge({
    gateway: { auth: { mode: "token" }, http: { endpoints: { responses: { enabled: false } } } },
    agents: { defaults: { workspace: "/data/workspace" } },
  });

  assert.equal(merged.gateway.auth.mode, "token");
  assert.equal(merged.gateway.http.endpoints.responses.enabled, false);
  assert.equal(merged.gateway.http.endpoints.chatCompletions.enabled, true);
  assert.equal(merged.plugins.enabled, true);
  assert.deepEqual(merged.plugins.load.paths, [pluginPath]);
  assert.equal(merged.plugins.entries.intentbios.enabled, true);
  assert.equal(
    merged.plugins.entries.intentbios.config.apiUrl,
    "https://coachapp-production-0a92.up.railway.app",
  );
  assert.deepEqual(merged.agents.entries[COACH_AGENT_ID].tools.allow, [...COACH_TOOL_NAMES]);
  assert.equal(merged.agents.entries[COACH_AGENT_ID].workspace, workspaceDir);
  assert.equal(merged.agents.entries.main.default, true);
  assert.equal(merged.agents.entries.main.workspace, "/data/workspace");
});

test("leaves intentbios-sophia unchanged and keeps an existing default", () => {
  const sophia = {
    name: "Sophia",
    workspace: "/data/sophia",
    tools: { allow: ["proposal_only"] },
  };
  const merged = merge({
    agents: {
      entries: {
        main: { default: true, workspace: "/data/workspace" },
        [SOPHIA_AGENT_ID]: sophia,
      },
    },
  });
  assert.equal(merged.agents.entries[SOPHIA_AGENT_ID], sophia);
  assert.deepEqual(merged.agents.entries[SOPHIA_AGENT_ID], sophia);
  assert.equal(merged.agents.entries.main.default, true);
  assert.equal(merged.agents.ownership, undefined);
  assert.equal(merged.agents.entries[COACH_AGENT_ID].name, "Intentbios Coach");
});

test("sets explicit ownership when the roster has no default", () => {
  const merged = merge({
    agents: {
      entries: {
        [SOPHIA_AGENT_ID]: { name: "Sophia" },
      },
    },
  });
  assert.equal(merged.agents.ownership, "explicit");
  assert.equal(merged.agents.entries[SOPHIA_AGENT_ID].name, "Sophia");
});

test("unions tool allow lists and drops alsoAllow", () => {
  const merged = merge({
    tools: { allow: ["web_search"], deny: ["intent_create", "exec"] },
    plugins: { allow: ["brave"], deny: ["intentbios", "other"] },
    agents: {
      entries: {
        [COACH_AGENT_ID]: {
          name: "Custom Coach",
          tools: { alsoAllow: ["message"], deny: ["lesson_status", "cron"] },
        },
      },
    },
  });
  assert.deepEqual(merged.tools.allow, ["web_search", ...COACH_TOOL_NAMES]);
  assert.deepEqual(merged.tools.deny, ["exec"]);
  assert.deepEqual(merged.plugins.allow, ["brave", "intentbios"]);
  assert.deepEqual(merged.plugins.deny, ["other"]);
  assert.deepEqual(merged.agents.entries[COACH_AGENT_ID].tools.allow, [
    "message",
    ...COACH_TOOL_NAMES,
  ]);
  assert.equal(merged.agents.entries[COACH_AGENT_ID].tools.alsoAllow, undefined);
  assert.deepEqual(merged.agents.entries[COACH_AGENT_ID].tools.deny, ["cron"]);
  assert.equal(merged.agents.entries[COACH_AGENT_ID].name, "Custom Coach");
});

test("is a no-op without apiUrl and idempotent after a merge", () => {
  const original = { gateway: { port: 18789 } };
  assert.equal(
    mergeIntentbiosCoachConfig(original, { pluginPath, workspaceDir }),
    original,
  );
  const once = merge(original, { defaultUserId: " user-7 " });
  const twice = merge(once, { defaultUserId: "user-7" });
  assert.equal(once.plugins.entries.intentbios.config.defaultUserId, "user-7");
  assert.equal(configDeepEqual(once, twice), true);
});

test("does not create a global tools allowlist", () => {
  const merged = merge({ agents: { entries: { main: { default: true } } } });
  assert.equal(merged.tools, undefined);
  assert.equal(merged.plugins.allow, undefined);
});

test("preserves chat completion image settings", () => {
  const merged = merge({
    gateway: {
      http: {
        endpoints: {
          chatCompletions: { enabled: false, images: { allowUrl: true } },
        },
      },
    },
  });
  assert.deepEqual(merged.gateway.http.endpoints.chatCompletions, {
    enabled: true,
    images: { allowUrl: true },
  });
});

test("writeCoachWorkspace copies templates and does not add lesson content", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intentbios-coach-"));
  writeCoachWorkspace(dir);
  const agents = fs.readFileSync(path.join(dir, "AGENTS.md"), "utf8");
  assert.match(agents, /intentbios-coach/);
  assert.match(agents, /Do not invent, outline, or paste a lesson/);
  assert.equal(fs.existsSync(path.join(dir, "lesson.md")), false);
  const names = fs.readdirSync(dir).sort();
  assert.deepEqual(names, ["AGENTS.md", "IDENTITY.md", "SOUL.md", "TOOLS.md", "USER.md"]);
});

test("manifest tools match the coach tool list", () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      path.resolve("plugins/intentbios/openclaw.plugin.json"),
      "utf8",
    ),
  );
  assert.deepEqual(manifest.contracts.tools, [...COACH_TOOL_NAMES]);
  assert.equal(manifest.id, "intentbios");
});
