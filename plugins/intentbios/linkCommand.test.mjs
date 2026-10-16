import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  createDiscordLinkHandler,
  discordUserIdFromSender,
  parseLinkCommand,
  redeemDiscordLink,
} from "./linkCommand.mjs";

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

const CODE = "Zx9_kQ2aBcDeFgHiJkLmNoPqRsTuVwXyZ01234567";
const DISCORD_ID = "424242424242424242";

test("parses only a real link attempt, never ordinary text", () => {
  assert.deepEqual(parseLinkCommand(`/link ${CODE}`), { code: CODE, viaCommand: true });
  assert.deepEqual(parseLinkCommand(`  /LINK ${CODE}  `), { code: CODE, viaCommand: true });
  assert.deepEqual(parseLinkCommand(`<@123456789012345678> /link ${CODE}`), {
    code: CODE,
    viaCommand: true,
  });
  assert.deepEqual(parseLinkCommand(CODE), { code: CODE, viaCommand: false });
  assert.deepEqual(parseLinkCommand(`<@42> ${CODE}`), { code: CODE, viaCommand: false });

  // Not a link attempt: ordinary messages pass through untouched.
  assert.equal(parseLinkCommand("link the listing to me"), null);
  assert.equal(parseLinkCommand("/links please"), null);
  assert.equal(parseLinkCommand(""), null);
  assert.equal(parseLinkCommand("hello there"), null);
  assert.equal(parseLinkCommand("short"), null);
  assert.equal(parseLinkCommand("a code with spaces inside it"), null);
});

test("takes the Discord user id off the event metadata, not the message", () => {
  assert.equal(discordUserIdFromSender(DISCORD_ID), DISCORD_ID);
  assert.equal(discordUserIdFromSender(`discord:${DISCORD_ID}`), DISCORD_ID);
  assert.equal(discordUserIdFromSender("Gustavo"), null);
  assert.equal(discordUserIdFromSender(""), null);
});

test("a successful redeem calls the endpoint once with the event's user id", async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
    });
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, linked: true, accountId: "gustavo-test" }));
  });
  try {
    const handler = createDiscordLinkHandler({
      redeem: (input) =>
        redeemDiscordLink({ ...input, baseUrl: server.baseUrl, apiKey: "test-bot-key" }),
    });

    const result = await handler(
      { channel: "discord", senderId: DISCORD_ID, content: `/link ${CODE}` },
      { senderId: DISCORD_ID },
    );

    assert.equal(seen.length, 1, "endpoint called exactly once");
    assert.equal(seen[0].method, "POST");
    assert.equal(seen[0].url, "/api/auth/link-discord/redeem");
    assert.equal(seen[0].auth, "Bearer test-bot-key");
    // The id is the event's, never one spelled in the message.
    assert.equal(seen[0].body.discordUserId, DISCORD_ID);
    assert.equal(seen[0].body.code, CODE);
    assert.equal(result.handled, true);
    assert.match(result.text, /Connected/);
    assert.doesNotMatch(result.text, new RegExp(CODE));
  } finally {
    await server.close();
  }
});

test("the user id comes from the event even when the body carries another number", async () => {
  const seen = [];
  const server = await listen(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    res.setHeader("Content-Type", "application/json");
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, linked: true }));
  });
  try {
    const handler = createDiscordLinkHandler({
      redeem: (input) =>
        redeemDiscordLink({ ...input, baseUrl: server.baseUrl, apiKey: "test-bot-key" }),
    });
    // A different numeric id sits in the event only; the body has no id.
    await handler(
      { channel: "discord", senderId: "111111111111111111", content: CODE },
      { senderId: "111111111111111111" },
    );
    assert.equal(seen[0].discordUserId, "111111111111111111");
    assert.equal(seen[0].code, CODE);
  } finally {
    await server.close();
  }
});

test("a failed redeem surfaces the server's reason and never claims success", async () => {
  const server = await listen(async (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(400);
    res.end(
      JSON.stringify({ success: false, reason: "That pairing code is invalid or has expired." }),
    );
  });
  try {
    const handler = createDiscordLinkHandler({
      redeem: (input) =>
        redeemDiscordLink({ ...input, baseUrl: server.baseUrl, apiKey: "test-bot-key" }),
    });
    const result = await handler(
      { channel: "discord", senderId: DISCORD_ID, content: `/link ${CODE}` },
      { senderId: DISCORD_ID },
    );
    assert.equal(result.handled, true);
    assert.match(result.text, /invalid or has expired/);
    assert.doesNotMatch(result.text, /Connected/);
    assert.doesNotMatch(result.text, new RegExp(CODE));
  } finally {
    await server.close();
  }
});

test("a 401 from the endpoint is refusal, not success", async () => {
  const server = await listen(async (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.writeHead(401);
    res.end(JSON.stringify({ success: false, reason: "Unauthorized" }));
  });
  try {
    const handler = createDiscordLinkHandler({
      redeem: (input) =>
        redeemDiscordLink({ ...input, baseUrl: server.baseUrl, apiKey: "test-bot-key" }),
    });
    const result = await handler(
      { channel: "discord", senderId: DISCORD_ID, content: CODE },
      { senderId: DISCORD_ID },
    );
    assert.match(result.text, /Not linked/);
  } finally {
    await server.close();
  }
});

test("an unreachable server is refusal, not success", async () => {
  const handler = createDiscordLinkHandler({
    redeem: async () => {
      throw new Error("boom");
    },
  });
  const result = await handler(
    { channel: "discord", senderId: DISCORD_ID, content: `/link ${CODE}` },
    { senderId: DISCORD_ID },
  );
  assert.match(result.text, /Not linked/);
  assert.doesNotMatch(result.text, new RegExp(CODE));
});

test("no bot key means the redeem fails closed", async () => {
  let called = 0;
  const server = await listen(async (_req, res) => {
    called += 1;
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, linked: true }));
  });
  try {
    const handler = createDiscordLinkHandler({
      redeem: (input) => redeemDiscordLink({ ...input, baseUrl: server.baseUrl, apiKey: "" }),
    });
    const result = await handler(
      { channel: "discord", senderId: DISCORD_ID, content: `/link ${CODE}` },
      { senderId: DISCORD_ID },
    );
    assert.equal(called, 0);
    assert.match(result.text, /not configured/i);
  } finally {
    await server.close();
  }
});

test("the code is never logged", async () => {
  const lines = [];
  const server = await listen(async (_req, res) => {
    res.writeHead(400);
    res.end(JSON.stringify({ success: false, reason: "That pairing code is invalid or has expired." }));
  });
  try {
    const handler = createDiscordLinkHandler({
      redeem: (input) =>
        redeemDiscordLink({ ...input, baseUrl: server.baseUrl, apiKey: "test-bot-key" }),
      log: (level, message) => lines.push(`${level}:${message}`),
    });
    await handler(
      { channel: "discord", senderId: DISCORD_ID, content: `/link ${CODE}` },
      { senderId: DISCORD_ID },
    );
    assert.ok(lines.length > 0, "the handler logs its decision");
    for (const line of lines) {
      assert.doesNotMatch(line, new RegExp(CODE));
      assert.doesNotMatch(line, /test-bot-key/);
    }
  } finally {
    await server.close();
  }
});

test("nothing else is claimed: other channels, other messages, no id", async () => {
  let redeemCalls = 0;
  const handler = createDiscordLinkHandler({
    redeem: async () => {
      redeemCalls += 1;
      return { success: true, linked: true };
    },
  });

  // An ordinary message is not a link attempt.
  assert.equal(
    await handler({ channel: "discord", senderId: DISCORD_ID, content: "how do I rent in Berlin?" }, {
      senderId: DISCORD_ID,
    }),
    undefined,
  );
  // A link attempt on a non-Discord surface is left to the normal path.
  assert.equal(
    await handler({ channel: "webchat", senderId: "web-1", content: `/link ${CODE}` }, {
      senderId: "web-1",
    }),
    undefined,
  );
  assert.equal(redeemCalls, 0);

  // Discord, but no usable Discord user id: honest refusal, no redeem call.
  const noId = await handler(
    { channel: "discord", senderId: "Gustavo", content: `/link ${CODE}` },
    { senderId: "Gustavo" },
  );
  assert.equal(redeemCalls, 0);
  assert.match(noId.text, /could not read your Discord user id/);
});

test("an already-linked pair is reported as already connected", async () => {
  const handler = createDiscordLinkHandler({
    redeem: async () => ({ success: true, linked: true, alreadyLinked: true }),
  });
  const result = await handler(
    { channel: "discord", senderId: DISCORD_ID, content: `/link ${CODE}` },
    { senderId: DISCORD_ID },
  );
  assert.match(result.text, /Already connected/);
});
