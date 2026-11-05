import assert from "node:assert/strict";
import childProcess from "node:child_process";
import test from "node:test";

import {
  MODEL_AUTH_PASTE_BY_ENV,
  PROVIDER_ENV_KEYS,
  buildDeepseekPastePlans,
  buildProviderEnvFile,
  deepseekApiKeyProfileIdsFromConfig,
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

test("refreshes the onboard profile and pipes the key on stdin", () => {
  const plans = buildDeepseekPastePlans({
    secret: `  ${KEY}\n`,
    list: { ok: true, ids: ["deepseek:default"] },
    configProfileIds: ["deepseek:default"],
  });
  assert.equal(plans.length, 2);
  assert.deepEqual(plans[0].args, [
    "models",
    "auth",
    "paste-api-key",
    "--provider",
    "deepseek",
    "--profile-id",
    "deepseek:default",
  ]);
  assert.equal(plans[0].stdin, `${KEY}\n`);
  assert.equal(plans[1].logLabel, "models auth paste-api-key --provider deepseek");
  assert.deepEqual(plans[1].args, ["models", "auth", "paste-api-key", "--provider", "deepseek"]);
  for (const plan of plans) {
    assert.equal(plan.args.includes(KEY), false);
    assert.equal(plan.logLabel.includes(KEY), false);
  }
});

test("updates a custom profile id and still covers default and manual", () => {
  const plans = buildDeepseekPastePlans({
    secret: KEY,
    list: { ok: false, ids: [] },
    configProfileIds: ["deepseek:work"],
  });
  assert.deepEqual(
    plans.map((plan) => plan.profileId),
    ["deepseek:work", "deepseek:default", "deepseek:manual"],
  );
  assert.deepEqual(plans[2].args, ["models", "auth", "paste-api-key", "--provider", "deepseek"]);
});

test("does not paste when the DeepSeek key is missing", () => {
  assert.deepEqual(buildDeepseekPastePlans({ secret: "  ", list: { ok: true, ids: ["deepseek:default"] } }), []);
});

test("log line keeps exit code and truncated stderr, and drops the key", () => {
  const stderr = `${"x".repeat(500)} rejected ${KEY} unauthorized`;
  const line = formatCommandLog({
    label: "models auth paste-api-key --provider deepseek",
    code: 1,
    stderr: `\u001b[31m${stderr}\u001b[0m`,
    secrets: [KEY],
  });
  assert.match(line, /^models auth paste-api-key --provider deepseek exit=1 stderr=/);
  assert.equal(line.includes(KEY), false);
  assert.match(line, /\[redacted\] unauthorized$/);
  assert.ok(line.length < 500);
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
