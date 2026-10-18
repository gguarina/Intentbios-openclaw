import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";

import { cleanTurns, createIntentbiosBridgeHandler, listAgentWorkspaces } from "./intentbios-bridge-routes.mjs";
import { recordThread, threadForIntent } from "../plugins/intentbios/discord-bridge.mjs";

async function harness() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "ib-wr-"));
  const workspaceDir = path.join(stateDir, "workspace");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "SOUL.md"), "I am main.\nOPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123\nleaked supersecretvalue1");
  fs.writeFileSync(path.join(workspaceDir, "AGENTS.md"), "intro\n<!-- intentbios-knowledge:begin -->\nK\n<!-- intentbios-knowledge:end -->\nend");
  const coach = path.join(stateDir, "workspaces", "intentbios-coach");
  fs.mkdirSync(coach, { recursive: true });
  fs.writeFileSync(path.join(coach, "IDENTITY.md"), "Coach");
  const configFile = path.join(stateDir, "openclaw.json");
  fs.writeFileSync(configFile, JSON.stringify({ agents: { entries: { main: {}, "ash-editor": { name: "Ash Editor", workspace: path.join(stateDir, "workspaces", "ash-editor") } } } }));
  const posts = [];
  const threads = [];
  const handler = createIntentbiosBridgeHandler({
    isAuthorized: (req) => req.headers.authorization === "Bearer good",
    stateDir, workspaceDir, configFile,
    intentsChannelId: "1560230058268827713",
    token: () => "tok",
    secrets: () => ["supersecretvalue1"],
    post: async (_t, channelId, body) => { posts.push({ channelId, body }); return { id: "m" }; },
    newThread: async (_t, parent, name) => { threads.push({ parent, name }); return { id: "9999999999999999999", guild_id: "1111111111111111111" }; },
  });
  const app = http.createServer((req, res) => handler(req, res, () => { res.statusCode = 404; res.end("{}"); }));
  const server = await new Promise((resolve) => { app.listen(0, "127.0.0.1", () => resolve(app)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = (method, route, body, auth = "Bearer good") => fetch(`${base}${route}`, {
    method, headers: { "Content-Type": "application/json", ...(auth ? { Authorization: auth } : {}) }, body: body ? JSON.stringify(body) : undefined,
  }).then(async (r) => ({ status: r.status, json: await r.json() }));
  return { stateDir, posts, threads, call, close: () => new Promise((d) => server.close(d)) };
}

const turns = [
  { id: "u1", role: "user", text: "What is sin 30°?" },
  { id: "c1", role: "coach", text: "sin(30°) = 1/2", figures: [{ title: "Unit circle", pngUrl: "https://a.example/f.png" }], equations: [{ pngUrl: "http://bad/e.png" }] },
];

test("every route needs the gateway bearer", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("POST", "/intentbios/discord/mirror", { intentId: "intent_a" }, null)).status, 401);
    assert.equal((await h.call("POST", "/intentbios/discord/thread", { intentId: "intent_a" }, "Bearer bad")).status, 401);
    assert.equal((await h.call("GET", "/intentbios/souls", null, null)).status, 401);
  } finally { await h.close(); }
});

test("mirror: unmapped intents cost nothing; mapped ones post once, marked from Ask", async () => {
  const h = await harness();
  try {
    assert.deepEqual((await h.call("POST", "/intentbios/discord/mirror", { intentId: "intent_a", turns })).json, { ok: true, mapped: false, mirrored: 0 });
    assert.equal(h.posts.length, 0);
    recordThread(h.stateDir, "intent_a", "2222222222222222222");
    const first = await h.call("POST", "/intentbios/discord/mirror", { intentId: "intent_a", turns });
    assert.equal(first.json.mirrored, 2);
    assert.equal(h.posts.length, 1);
    assert.equal(h.posts[0].channelId, "2222222222222222222");
    assert.match(h.posts[0].body.content, /^📱 \*\*from Ask\*\*\n\*\*You:\*\* What is sin 30°\?/);
    assert.deepEqual(h.posts[0].body.embeds, [{ title: "Unit circle", image: { url: "https://a.example/f.png" } }]);
    const again = await h.call("POST", "/intentbios/discord/mirror", { intentId: "intent_a", turns });
    assert.equal(again.json.mirrored, 0);
    assert.equal(h.posts.length, 1);
  } finally { await h.close(); }
});

test("thread: opens one thread in #intents, posts the conversation, records the mapping", async () => {
  const h = await harness();
  try {
    const opened = await h.call("POST", "/intentbios/discord/thread", { intentId: "intent_t", title: "Learn trig", turns });
    assert.equal(opened.status, 200);
    assert.equal(opened.json.url, "https://discord.com/channels/1111111111111111111/9999999999999999999");
    assert.deepEqual(h.threads, [{ parent: "1560230058268827713", name: "Learn trig" }]);
    assert.match(h.posts[0].body.content, /intent `intent_t`/);
    assert.match(h.posts[1].body.content, /conversation so far/);
    assert.equal(threadForIntent(h.stateDir, "intent_t").threadId, "9999999999999999999");
    const repeat = await h.call("POST", "/intentbios/discord/thread", { intentId: "intent_t", title: "Learn trig", turns });
    assert.equal(repeat.json.existing, true);
    assert.equal(h.threads.length, 1);
    // Turns already posted in the thread are not mirrored again.
    assert.equal((await h.call("POST", "/intentbios/discord/mirror", { intentId: "intent_t", turns })).json.mirrored, 0);
  } finally { await h.close(); }
});

test("thread: named with Intentbios' threadName when sent", async () => {
  const h = await harness();
  try {
    const threadName = "Learn trigonometry · intent_named";
    const opened = await h.call("POST", "/intentbios/discord/thread", { intentId: "intent_named", title: "Learn trigonometry", threadName, turns });
    assert.equal(opened.status, 200);
    assert.deepEqual(h.threads, [{ parent: "1560230058268827713", name: threadName }]);
    assert.match(h.posts[0].body.content, /\*\*Learn trigonometry\*\* · intent `intent_named`/);
  } finally { await h.close(); }
});

test("souls: persona files per agent, knowledge block first, secrets redacted", async () => {
  const h = await harness();
  try {
    const { status, json } = await h.call("GET", "/intentbios/souls");
    assert.equal(status, 200);
    const ids = json.agents.map((a) => a.id);
    assert.deepEqual(ids, ["main", "planner", "intentbios-coach", "ash-editor"]);
    const main = json.agents[0];
    const soul = main.files.find((f) => f.name === "SOUL.md").content;
    assert.ok(soul.includes("I am main."));
    assert.ok(!soul.includes("sk-abcdefghij"));
    assert.ok(!soul.includes("supersecretvalue1"));
    assert.ok(main.files.find((f) => f.name === "AGENTS.md").content.startsWith("<!-- intentbios-knowledge:begin -->"));
    assert.equal(json.agents[1].sharedWith, "main");
    assert.equal(json.agents[2].files.find((f) => f.name === "IDENTITY.md").content, "Coach");
    assert.equal(json.agents[3].files[0].missing, true);
  } finally { await h.close(); }
});

test("other paths fall through", async () => {
  const h = await harness();
  try {
    assert.equal((await h.call("GET", "/intentbios/other")).status, 404);
  } finally { await h.close(); }
});

test("cleanTurns drops malformed turns and insecure links", () => {
  const out = cleanTurns([...turns, { role: "user", text: "no id" }, { id: "x", text: " " }]);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1].equations, []);
  assert.equal(listAgentWorkspaces({ configFile: "/nope", stateDir: "/s", workspaceDir: "/w" })[0].workspace, "/w");
});
