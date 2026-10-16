/**
 * Redeem an Intentbios Discord-link pairing code from a Discord message.
 *
 * This is the bot's half of the pairing (the app's half is `POST
 * /api/auth/link-discord/start`). It runs as a deterministic typed hook
 * (`before_dispatch`), not as a prompt instruction: the person's message is
 * claimed before ordinary model dispatch, and the Discord user id comes off the
 * event metadata — never parsed out of the message text.
 *
 * Invariants:
 * - the Discord user id is the event's `senderId`, never a display name and
 *   never read from the body;
 * - a message that is not a link attempt is left alone (no claim);
 * - the pairing code is never logged and never echoed back;
 * - success is only claimed when the server confirmed it (no optimistic reply).
 */

/** Discord user ids are numeric snowflakes. */
const DISCORD_ID_RE = /^(?:discord:)?(\d{5,25})$/;

/**
 * A pairing code is `randomBytes(32).toString("base64url")` (43 chars) and the
 * server refuses anything shorter than 20. Matching that exact shape is what
 * keeps a bare pasted code from swallowing an ordinary chat message.
 */
const LINK_CODE_RE = /^[A-Za-z0-9_-]{20,64}$/;

/** Strip one or more leading Discord mentions so a guild message still parses. */
function stripLeadingMentions(text) {
  return String(text || "")
    .replace(/^(?:\s*<@!?\d+>)+\s*/, "")
    .trim();
}

/**
 * The pairing code a person sent, or null when the message is not a link attempt.
 * Deterministic: the slash form `/link <code>` is explicit, and a bare message is
 * accepted only when it is exactly a pairing code (no words, no spaces).
 */
export function parseLinkCommand(content) {
  const text = stripLeadingMentions(content);
  if (!text) return null;
  const slash = /^\/link\b\s*(.*)$/is.exec(text);
  if (slash) {
    const code = slash[1].trim();
    return { code, viaCommand: true };
  }
  if (LINK_CODE_RE.test(text)) return { code: text, viaCommand: false };
  return null;
}

/** The numeric Discord user id a hook event identifies, or null. */
export function discordUserIdFromSender(senderId) {
  const match = DISCORD_ID_RE.exec(String(senderId || "").trim());
  return match ? match[1] : null;
}

function replyForOutcome(outcome) {
  const value = outcome && typeof outcome === "object" ? outcome : {};
  if (value.success) {
    return value.alreadyLinked
      ? "Already connected — this Discord account is linked to your Intentbios account."
      : "Connected. This Discord account is now linked to your Intentbios account.";
  }
  const reason = String(value.reason || "").trim();
  return reason ? `Not linked: ${reason}` : "Not linked: the Intentbios server did not confirm the pairing.";
}

/**
 * Build the `before_dispatch` handler.
 *
 * @param {object} options
 * @param {(input: {code: string, discordUserId: string}) => Promise<object>} options.redeem
 *   Calls `POST /api/auth/link-discord/redeem`. Rejecting is treated as an
 *   unreachable server, never as success.
 * @param {(level: string, message: string) => void} [options.log]
 *   Called with code-free messages only.
 */
export function createDiscordLinkHandler({ redeem, log } = {}) {
  const say = (level, message) => {
    try {
      log?.(level, message);
    } catch {
      // A logger failure must never change the redeem outcome.
    }
  };

  return async function handleDiscordLink(event, ctx) {
    const content = event?.content ?? event?.body ?? "";
    const attempt = parseLinkCommand(content);
    if (!attempt) return undefined;

    const channel = String(event?.channel || ctx?.channelId || "").toLowerCase();
    if (channel && channel !== "discord") return undefined;

    const discordUserId = discordUserIdFromSender(ctx?.senderId ?? event?.senderId);
    if (!discordUserId) {
      say("info", "discord-link: no Discord user id on the event; not linked");
      return {
        handled: true,
        text: "I could not read your Discord user id from that message, so nothing was linked.",
      };
    }

    if (typeof redeem !== "function") {
      say("error", "discord-link: no redeem client configured");
      return {
        handled: true,
        text: "Not linked: Discord linking is not configured on this bot.",
      };
    }

    let outcome;
    try {
      outcome = await redeem({ code: attempt.code, discordUserId });
    } catch {
      say("warn", "discord-link: redeem call failed");
      outcome = { success: false, reason: "the Intentbios server could not be reached." };
    }

    say("info", `discord-link: redeem ${outcome?.success ? "linked" : "refused"}`);
    return { handled: true, text: replyForOutcome(outcome) };
  };
}

/**
 * `POST /api/auth/link-discord/redeem` with the bot credential.
 * Fails closed when the key is missing, and never puts the code or the key in
 * an error or a log line.
 */
export async function redeemDiscordLink({
  code,
  discordUserId,
  baseUrl,
  apiKey,
  fetchImpl = globalThis.fetch,
} = {}) {
  const key = String(apiKey || "").trim();
  if (!key) return { success: false, reason: "Discord linking is not configured on this bot." };
  const base = String(baseUrl || "").trim().replace(/\/$/, "");
  if (!base) return { success: false, reason: "Discord linking is not configured on this bot." };

  const res = await fetchImpl(`${base}/api/auth/link-discord/redeem`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({ code: String(code || ""), discordUserId: String(discordUserId || "") }),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  let json = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (json?.success) {
    return { success: true, linked: Boolean(json.linked), alreadyLinked: Boolean(json.alreadyLinked) };
  }
  return {
    success: false,
    reason: String(json?.reason || `the Intentbios server refused the pairing (HTTP ${res.status}).`),
  };
}
