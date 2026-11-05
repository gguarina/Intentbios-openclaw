import assert from "node:assert/strict";
import childProcess from "node:child_process";
import test from "node:test";

import {
  MAIN_AGENT_ID,
  MODEL_AUTH_PASTE_BY_ENV,
  PROVIDER_ENV_KEYS,
  agentIdsFromConfig,
  buildDeepseekPastePlans,
  buildProviderEnvFile,
  deepseekApiKeyProfileIdsFromConfig,
  deepseekAuthListArgs,
  deliverSpawnInput,
  formatCommandLog,
  parseDeepseekAuthList,
} from "./provider-env-sync.mjs";

const KEY = "sk-test-deepseek-placeholder";

test("writes only non-empty provider env lines", () => {
  const file = buildProviderEnvFile({
    BRAVE_API_KEY: " brave ",
    DEEPSEEK_API_KEY: KEY,
    DISCORD_BOT_TOKEN: "",
    ASH_DISCORD_BOT_TOKEN: "   ",
    BOOK_RUNNER_TOKEN: "runner",
  });
  assert.equal(file, `BRAVE_API_KEY=brave\nDEEPSEEK_API_KEY=${KEY}\nBOOK_RUNNER_TOKEN=runner\n`);
});

test("empty provider env produces no dotenv body", () => {
  assert.equal(buildProviderEnvFile({}), "");
});

test("only DeepSeek has a models auth paste path", () => {
  assert.deepEqual(MODEL_AUTH_PASTE_BY_ENV, { DEEPSEEK_API_KEY: "deepseek" });
  for (const key of PROVIDER_ENV_KEYS) {
    if (key === "DEEPSEEK_API_KEY") continue;
    assert.equal(MODEL_AUTH_PASTE_BY_ENV[key], undefined);
  }
});

test("parses deepseek api_key profile ids and skips other types", () => {
  const stdout = [
    "\u001b[32mnote\u001b[0m",
    JSON.stringify({
      profiles: [
        { id: "deepseek:default", provider: "deepseek", type: "api_key" },
        { id: "deepseek:oauth", provider: "deepseek", type: "oauth" },
        { id: "openai:default", provider: "openai", type: "api_key" },
        { id: "not a profile", provider: "deepseek", type: "api_key" },
      ],
    }),
  ].join("\n");
  assert.deepEqual(parseDeepseekAuthList(stdout), { ok: true, ids: ["deepseek:default"] });
});

test("treats a non-json auth list as unreadable", () => {
  assert.deepEqual(parseDeepseekAuthList("Profiles: (none)"), { ok: false, ids: [] });
});

test("reads api_key deepseek profiles from config", () => {
  assert.deepEqual(
    deepseekApiKeyProfileIdsFromConfig({
      auth: {
        profiles: {
          "deepseek:default": { provider: "deepseek", mode: "api_key" },
          "deepseek:token": { provider: "deepseek", mode: "token" },
          "openai:default": { provider: "openai", mode: "api_key" },
        },
      },
    }),
    ["deepseek:default"],
  );
});

test("lists main first and keeps the live agent roster", () => {
  assert.deepEqual(
    agentIdsFromConfig({
      agents: {
        entries: {
          "ash-editor": {},
          main: {},
          "intentbios-coach": {},
          planner: {},
          "ash-coldreader": {},
          "ash-continuity": {},
        },
        list: [{ id: "planner" }, "intentbios-sophia"],
      },
    }),
    ["main", "ash-editor", "intentbios-coach", "planner", "ash-coldreader", "ash-continuity", "intentbios-sophia"],
  );
  assert.deepEqual(agentIdsFromConfig({}), [MAIN_AGENT_ID]);
  assert.deepEqual(agentIdsFromConfig({ agents: { entries: { "bad id": {}, "": {} } } }), ["main"]);
});

test("auth list and paste always pass --agent", () => {
  assert.deepEqual(deepseekAuthListArgs("main"), [
    "models",
    "auth",
    "list",
    "--provider",
    "deepseek",
    "--agent",
    "main",
    "--json",
  ]);
  assert.throws(() => deepseekAuthListArgs(""), /--agent/);
  const plans = buildDeepseekPastePlans({
    secret: `  ${KEY}\n`,
    agentId: "main",
    always: true,
    list: { ok: true, ids: ["deepseek:default"] },
    configProfileIds: ["deepseek:default"],
  });
  assert.deepEqual(
    plans.map((plan) => plan.profileId),
    ["deepseek:default", "deepseek:manual"],
  );
  for (const plan of plans) {
    const agentFlag = plan.args.indexOf("--agent");
    assert.equal(plan.args[agentFlag + 1], "main");
    assert.equal(plan.args.includes("--profile-id"), true);
    assert.equal(plan.stdin, `${KEY}\n`);
    assert.equal(plan.args.includes(KEY), false);
    assert.equal(plan.logLabel.includes(KEY), false);
    assert.match(plan.logLabel, /--agent main/);
  }
});

test("pastes other agents only for profiles their list returns", () => {
  const stored = buildDeepseekPastePlans({
    secret: KEY,
    agentId: "ash-editor",
    list: { ok: true, ids: ["deepseek:default"] },
  });
  assert.deepEqual(stored.map((plan) => plan.profileId), ["deepseek:default"]);
  assert.equal(stored[0].args[stored[0].args.indexOf("--agent") + 1], "ash-editor");

  assert.deepEqual(
    buildDeepseekPastePlans({
      secret: KEY,
      agentId: "intentbios-coach",
      list: { ok: true, ids: [] },
    }),
    [],
  );
  assert.deepEqual(
    buildDeepseekPastePlans({
      secret: KEY,
      agentId: "planner",
      list: { ok: false, ids: [] },
      configProfileIds: ["deepseek:default"],
    }),
    [],
  );
});

test("main still pastes default and manual when the list fails", () => {
  const plans = buildDeepseekPastePlans({
    secret: KEY,
    agentId: "main",
    always: true,
    list: { ok: false, ids: [] },
    configProfileIds: ["deepseek:work"],
  });
  assert.deepEqual(
    plans.map((plan) => plan.profileId),
    ["deepseek:work", "deepseek:default", "deepseek:manual"],
  );
  assert.equal(plans.some((plan) => !plan.args.includes("--agent")), false);
});

test("does not paste when the DeepSeek key or agent id is missing", () => {
  assert.deepEqual(
    buildDeepseekPastePlans({ secret: "  ", agentId: "main", always: true, list: { ok: true, ids: ["deepseek:default"] } }),
    [],
  );
  assert.deepEqual(
    buildDeepseekPastePlans({ secret: KEY, agentId: "not an agent", always: true, list: { ok: true, ids: ["deepseek:default"] } }),
    [],
  );
});

test("log line is the exit code and drops stderr", () => {
  const line = formatCommandLog({
    label: "models auth paste-api-key --provider deepseek --agent main --profile-id deepseek:default",
    code: 0,
    stderr: `rejected ${KEY}`,
    secrets: [KEY],
  });
  assert.equal(
    line,
    "models auth paste-api-key --provider deepseek --agent main --profile-id deepseek:default exit=0",
  );
  assert.equal(line.includes(KEY), false);
});

test("deliverSpawnInput ends stdin with the piped secret", () => {
  let ended = null;
  let guarded = false;
  const stdin = {
    on(event, fn) {
      assert.equal(event, "error");
      assert.equal(typeof fn, "function");
      guarded = true;
    },
    end(value) {
      ended = value;
    },
  };
  assert.equal(deliverSpawnInput(stdin, `${KEY}\n`), true);
  assert.equal(guarded, true);
  assert.equal(ended, `${KEY}\n`);
  assert.equal(deliverSpawnInput(null, KEY), false);
  assert.equal(deliverSpawnInput(stdin, null), false);
});

test("a real child reads the piped key from stdin and not from argv", async () => {
  const proc = childProcess.spawn(process.execPath, [
    "-e",
    "let s=''; process.stdin.on('data', (d) => { s += d; }); process.stdin.on('end', () => { if (process.argv.some((arg) => arg.includes(s.trim()))) process.exit(2); process.stdout.write(s); });",
  ]);
  let out = "";
  proc.stdout.on("data", (d) => {
    out += d;
  });
  assert.equal(deliverSpawnInput(proc.stdin, `${KEY}\n`), true);
  let timer;
  const code = await Promise.race([
    new Promise((resolve) => proc.on("close", resolve)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("stdin pipe hung")), 5000);
    }),
  ]);
  clearTimeout(timer);
  assert.equal(code, 0);
  assert.equal(out, `${KEY}\n`);
});
