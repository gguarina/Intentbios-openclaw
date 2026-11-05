/**
 * Boot sync of Railway provider secrets into OpenClaw state.
 *
 * DeepSeek model calls prefer a stored auth profile over DEEPSEEK_API_KEY
 * (OpenClaw resolveApiKeyForProvider keeps the profile ahead of env).
 * On OpenClaw 2026.9.4, `openclaw models auth paste-api-key --provider deepseek`
 * writes only `deepseek:manual` unless `--profile-id` is set. Onboarding stores
 * `deepseek:default`, and a 401 on that profile does not fail over to another
 * key. With more than one agent configured, both `models auth list` and
 * `paste-api-key` exit 1 unless `--agent <id>` is set. Refresh saved api_key
 * profiles per agent, always including `main`.
 *
 * `openclaw config set env.DEEPSEEK_API_KEY` is not a substitute: the `env`
 * object only allows `shellEnv` and `vars`, so that path is unknown and exits 1.
 * `env.vars` would still lose to the stored profile.
 *
 * BRAVE_API_KEY is applied through tools.web.search / plugins.entries.brave.
 * Discord and book-runner tokens are not model auth profiles.
 */

export const PROVIDER_ENV_KEYS = [
  "BRAVE_API_KEY",
  "DEEPSEEK_API_KEY",
  "DISCORD_BOT_TOKEN",
  "ASH_DISCORD_BOT_TOKEN",
  "BOOK_RUNNER_TOKEN",
];

/** Env keys that have an `openclaw models auth paste-api-key --provider` path. */
export const MODEL_AUTH_PASTE_BY_ENV = {
  DEEPSEEK_API_KEY: "deepseek",
};

const DEEPSEEK_PROFILE_ID = /^deepseek:[A-Za-z0-9._:-]+$/;
const AGENT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,128}$/;
const ONBOARD_DEEPSEEK_PROFILE_ID = "deepseek:default";
const PASTE_DEFAULT_DEEPSEEK_PROFILE_ID = "deepseek:manual";

/** Discord @intentbios is bound to this agent. Every boot pastes its DeepSeek profiles. */
export const MAIN_AGENT_ID = "main";

export function buildProviderEnvFile(env) {
  const lines = [];
  for (const key of PROVIDER_ENV_KEYS) {
    const value = String(env?.[key] ?? "").trim();
    if (value) lines.push(`${key}=${value}`);
  }
  return lines.length ? `${lines.join("\n")}\n` : "";
}

export function stripAnsi(value) {
  return String(value)
    .replace(/\x1b\]8;;.*?\x1b\\|\x1b\]8;;\x1b\\/g, "")
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, "");
}

export function isAgentId(id) {
  return typeof id === "string" && AGENT_ID.test(id);
}

function uniqueIds(ids) {
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !DEEPSEEK_PROFILE_ID.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/**
 * Configured agent ids, `main` first.
 * Reads `agents.entries` and `agents.list` (the same roster boot already merges).
 */
export function agentIdsFromConfig(config) {
  const ids = [];
  const add = (id) => {
    if (!isAgentId(id) || ids.includes(id)) return;
    ids.push(id);
  };
  add(MAIN_AGENT_ID);
  const entries = config?.agents?.entries;
  if (entries && typeof entries === "object" && !Array.isArray(entries)) {
    for (const id of Object.keys(entries)) add(id);
  }
  if (Array.isArray(config?.agents?.list)) {
    for (const entry of config.agents.list) add(typeof entry === "string" ? entry : entry?.id);
  }
  return [MAIN_AGENT_ID, ...ids.filter((id) => id !== MAIN_AGENT_ID)];
}

/** `models auth list` for one agent. Never omits `--agent`. */
export function deepseekAuthListArgs(agentId) {
  if (!isAgentId(agentId)) throw new Error("deepseek auth list requires --agent <id>");
  return ["models", "auth", "list", "--provider", "deepseek", "--agent", agentId, "--json"];
}

/**
 * Parse `openclaw models auth list --provider deepseek --json`.
 * Returns api_key profile ids only. `ok: false` means the stdout was not a profile list.
 */
export function parseDeepseekAuthList(stdout) {
  const text = stripAnsi(String(stdout ?? ""));
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return { ok: false, ids: [] };
  let parsed;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return { ok: false, ids: [] };
  }
  if (!Array.isArray(parsed?.profiles)) return { ok: false, ids: [] };
  const ids = [];
  for (const profile of parsed.profiles) {
    const type = profile?.type;
    if (type && type !== "api_key") continue;
    if (typeof profile?.id !== "string" || !DEEPSEEK_PROFILE_ID.test(profile.id)) continue;
    if (!ids.includes(profile.id)) ids.push(profile.id);
  }
  return { ok: true, ids };
}

/** DeepSeek api_key profile ids named in openclaw.json `auth.profiles`. */
export function deepseekApiKeyProfileIdsFromConfig(config) {
  const profiles = config?.auth?.profiles;
  if (!profiles || typeof profiles !== "object" || Array.isArray(profiles)) return [];
  const ids = [];
  for (const [id, profile] of Object.entries(profiles)) {
    const mode = profile?.mode;
    if (mode && mode !== "api_key") continue;
    if (!DEEPSEEK_PROFILE_ID.test(id)) continue;
    if (!ids.includes(id)) ids.push(id);
  }
  return ids;
}

/**
 * Paste plans for one agent. Every plan includes `--agent`.
 * `main` (`always`) refreshes every discovered api_key profile plus onboard
 * `deepseek:default` and paste `deepseek:manual`. Other agents are pasted only
 * for profile ids their own auth list returns.
 */
export function buildDeepseekPastePlans({ secret, agentId, list, configProfileIds = [], always = false }) {
  const trimmed = String(secret ?? "").trim();
  if (!trimmed || !isAgentId(agentId)) return [];
  const discovered = list?.ok
    ? uniqueIds([...(list.ids || []), ...(always ? configProfileIds : [])])
    : always
      ? uniqueIds(configProfileIds)
      : [];
  if (!always && discovered.length === 0) return [];
  const ids = [...discovered];
  if (always) {
    if (!ids.includes(ONBOARD_DEEPSEEK_PROFILE_ID)) ids.push(ONBOARD_DEEPSEEK_PROFILE_ID);
    if (!ids.includes(PASTE_DEFAULT_DEEPSEEK_PROFILE_ID)) ids.push(PASTE_DEFAULT_DEEPSEEK_PROFILE_ID);
  }
  const stdin = `${trimmed}\n`;
  return ids.map((profileId) => ({
    agentId,
    profileId,
    args: [
      "models",
      "auth",
      "paste-api-key",
      "--provider",
      "deepseek",
      "--agent",
      agentId,
      "--profile-id",
      profileId,
    ],
    stdin,
    logLabel: `models auth paste-api-key --provider deepseek --agent ${agentId} --profile-id ${profileId}`,
  }));
}

/** Exit code only. Stderr is ignored so a key echoed by the CLI cannot reach the log. */
export function formatCommandLog({ label, code }) {
  return `${label} exit=${code}`;
}

/** Write `input` to a child stdin and close it. Swallows EPIPE. */
export function deliverSpawnInput(stdin, input) {
  if (input == null || !stdin || typeof stdin.end !== "function") return false;
  if (typeof stdin.on === "function") stdin.on("error", () => {});
  stdin.end(String(input));
  return true;
}
