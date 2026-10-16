import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import plugin from "./index.js";
import { COACH_TOOL_NAMES } from "./client.mjs";

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function fakeApi(config = {}) {
  const hooks = [];
  const tools = [];
  return {
    hooks,
    tools,
    pluginConfig: config,
    on: (name, handler, opts) => hooks.push({ name, handler, opts }),
    registerTool: (factory, opts) => tools.push(opts?.name),
  };
}

test("register wires the before_dispatch redeem hook and the coach tools", () => {
  const api = fakeApi({ apiUrl: "https://coachapp.example" });
  plugin.register(api);

  assert.equal(api.hooks.length, 1);
  assert.equal(api.hooks[0].name, "before_dispatch");
  assert.equal(typeof api.hooks[0].handler, "function");
  assert.deepEqual(api.tools.sort(), [...COACH_TOOL_NAMES].sort());
});

test("register does not throw when the host exposes no hook API", () => {
  const api = { pluginConfig: { apiUrl: "https://coachapp.example" }, registerTool() {} };
  plugin.register(api);
});

test("the wired hook redeems against the configured URL with the bot key", async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, linked: true }));
  });
  const previous = process.env.INTENTBIOS_MCP_API_KEY;
  process.env.INTENTBIOS_MCP_API_KEY = "test-bot-key";
  try {
    const api = fakeApi({ apiUrl: server.baseUrl });
    plugin.register(api);
    const result = await api.hooks[0].handler(
      { channel: "discord", senderId: "777888999000111222", content: "/link CODE_abcdefghijklmnopqrstuvwx" },
      { senderId: "777888999000111222" },
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].url, "/api/auth/link-discord/redeem");
    assert.equal(seen[0].auth, "Bearer test-bot-key");
    assert.equal(seen[0].body.discordUserId, "777888999000111222");
    assert.equal(seen[0].body.code, "CODE_abcdefghijklmnopqrstuvwx");
    assert.equal(result.handled, true);
  } finally {
    await server.close();
    if (previous === undefined) delete process.env.INTENTBIOS_MCP_API_KEY;
    else process.env.INTENTBIOS_MCP_API_KEY = previous;
  }
});

test("the wired hook leaves an ordinary message alone", async () => {
  const api = fakeApi({ apiUrl: "https://coachapp.example" });
  plugin.register(api);
  assert.equal(
    await api.hooks[0].handler(
      { channel: "discord", senderId: "123456789012345678", content: "how do I rent in Berlin?" },
      { senderId: "123456789012345678" },
    ),
    undefined,
  );
});
