import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import plugin, { resolveIntentbiosMcpConnection } from "./index.js";
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
  const resolvers = [];
  return {
    hooks,
    tools,
    resolvers,
    pluginConfig: config,
    on: (name, handler, opts) => hooks.push({ name, handler, opts }),
    registerTool: (factory, opts) => tools.push(opts?.name),
    registerMcpServerConnectionResolver: (resolver) => resolvers.push(resolver),
  };
}

/** Run fn with a temporary process.env, restoring every touched key after. */
async function withEnv(overrides, fn) {
  const keys = ["INTENTBIOS_MCP_URL", "INTENTBIOS_MCP_API_KEY", "INTENTBIOS_MCP_USER_ID"];
  const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  for (const key of keys) delete process.env[key];
  Object.assign(process.env, overrides);
  try {
    return await fn();
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
}

test("register wires the before_dispatch redeem hook and the coach tools", () => {
  const api = fakeApi({ apiUrl: "https://coachapp.example" });
  plugin.register(api);

  assert.deepEqual(api.hooks.map((h) => h.name), [
    "before_dispatch",
    "after_tool_call",
    "message_sent",
    "after_tool_call",
    "reply_payload_sending",
    "message_sent",
    "before_dispatch",
    "message_received",
  ]);
  assert.equal(api.hooks[0].name, "before_dispatch");
  assert.equal(typeof api.hooks[0].handler, "function");
  assert.deepEqual(api.tools.sort(), [...COACH_TOOL_NAMES].sort());
});

test("register does not throw when the host exposes no hook API", () => {
  const api = { pluginConfig: { apiUrl: "https://coachapp.example" }, registerTool() {} };
  plugin.register(api);
});

test("register binds the intentbios MCP transport to the requester", () => {
  const api = fakeApi({ apiUrl: "https://coachapp.example" });
  plugin.register(api);
  assert.equal(api.resolvers.length, 1);
  assert.equal(api.resolvers[0].serverName, "intentbios");
  assert.equal(typeof api.resolvers[0].resolve, "function");
});

test("resolver writes as the Discord sender's discord:<id> identity", async () => {
  await withEnv({}, () => {
    const connection = resolveIntentbiosMcpConnection(
      { messageChannel: "discord", requesterSenderId: "1560179504196886610" },
      { baseUrl: "https://coachapp.example" },
    );
    assert.equal(connection.url, "https://coachapp.example/mcp");
    assert.equal(connection.headers["x-user-id"], "discord:1560179504196886610");
  });
});

test("resolver normalizes an already-prefixed Discord sender id", async () => {
  await withEnv({}, () => {
    const connection = resolveIntentbiosMcpConnection(
      { messageChannel: "discord", requesterSenderId: "discord:1560179504196886610" },
      { baseUrl: "https://coachapp.example" },
    );
    assert.equal(connection.headers["x-user-id"], "discord:1560179504196886610");
  });
});

test("resolver keeps the static identity on a non-Discord channel", async () => {
  await withEnv({}, () => {
    const connection = resolveIntentbiosMcpConnection(
      { messageChannel: "webchat", requesterSenderId: "web-1" },
      { baseUrl: "https://coachapp.example" },
    );
    assert.equal(connection.headers["x-user-id"], "gustavo");
  });
});

test("resolver ignores a non-snowflake Discord sender and falls back", async () => {
  await withEnv({}, () => {
    const connection = resolveIntentbiosMcpConnection(
      { messageChannel: "discord", requesterSenderId: "Gustavo" },
      { baseUrl: "https://coachapp.example" },
    );
    assert.equal(connection.headers["x-user-id"], "gustavo");
  });
});

test("resolver sends the bot key as a bearer header when configured", async () => {
  await withEnv({ INTENTBIOS_MCP_API_KEY: "test-bot-key" }, () => {
    const connection = resolveIntentbiosMcpConnection(
      { messageChannel: "discord", requesterSenderId: "1560179504196886610" },
      { baseUrl: "https://coachapp.example" },
    );
    assert.equal(connection.headers.Authorization, "Bearer test-bot-key");
  });
  await withEnv({}, () => {
    const without = resolveIntentbiosMcpConnection(
      { messageChannel: "discord", requesterSenderId: "1560179504196886610" },
      { baseUrl: "https://coachapp.example" },
    );
    assert.equal(without.headers.Authorization, undefined);
  });
});

test("resolver honors INTENTBIOS_MCP_URL and the configured default user", async () => {
  await withEnv({ INTENTBIOS_MCP_URL: "https://mcp.example/mcp" }, () => {
    const connection = resolveIntentbiosMcpConnection({ messageChannel: "webchat", requesterSenderId: "w" }, {});
    assert.equal(connection.url, "https://mcp.example/mcp");
  });
  await withEnv({}, () => {
    const configured = resolveIntentbiosMcpConnection(
      { messageChannel: "webchat", requesterSenderId: "w" },
      { baseUrl: "https://coachapp.example", defaultUserId: "someone" },
    );
    assert.equal(configured.headers["x-user-id"], "someone");
  });
});

test("resolver returns null with no base URL so the run omits the server", async () => {
  await withEnv({}, () => {
    assert.equal(resolveIntentbiosMcpConnection({ messageChannel: "discord", requesterSenderId: "1" }, {}), null);
  });
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
