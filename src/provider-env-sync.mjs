/**
 * Boot sync of Railway provider secrets into OpenClaw state.
 *
 * DeepSeek model calls prefer a stored auth profile over DEEPSEEK_API_KEY
 * (OpenClaw resolveApiKeyForProvider keeps the profile ahead of env).
 * On OpenClaw 2026.9.4, `openclaw models auth paste-api-key --provider deepseek`
 * writes only `deepseek:manual` unless `--profile-id` is set. Onboarding stores
 * `deepseek:default`, and a 401 on that profile does not fail over to another
 * key. Refresh every saved api_key profile, and those two ids, from the env key.
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
const ONBOARD_DEEPSEEK_PROFILE_ID = "deepseek:default";
const PASTE_DEFAULT_DEEPSEEK_PROFILE_ID = "deepseek:manual";
export const ENV_SYNC_STDERR_MAX = 400;

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

function uniqueIds(ids) {
  const out = [];
  for (const id of ids) {
    if (typeof id !== "string" || !DEEPSEEK_PROFILE_ID.test(id)) continue;
    if (!out.includes(id)) out.push(id);
  }
  return out;
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
 * Profile ids to overwrite with the current DEEPSEEK_API_KEY.
 * A failed list still uses config ids. The onboard id and the paste default
 * are always covered so a stale winner cannot keep the previous key.
 */
export function buildDeepseekPastePlans({ secret, list, configProfileIds = [] }) {
  const trimmed = String(secret ?? "").trim();
  if (!trimmed) return [];
  const stdin = `${trimmed}\n`;
  const discovered = list?.ok
    ? uniqueIds([...(list.ids || []), ...configProfileIds])
    : uniqueIds(configProfileIds);
  const ids = discovered.includes(ONBOARD_DEEPSEEK_PROFILE_ID)
    ? discovered
    : [...discovered, ONBOARD_DEEPSEEK_PROFILE_ID];
  const plans = ids.map((profileId) => ({
    profileId,
    args: ["models", "auth", "paste-api-key", "--provider", "deepseek", "--profile-id", profileId],
    stdin,
    logLabel: `models auth paste-api-key --provider deepseek --profile-id ${profileId}`,
  }));
  if (!ids.includes(PASTE_DEFAULT_DEEPSEEK_PROFILE_ID)) {
    plans.push({
      profileId: PASTE_DEFAULT_DEEPSEEK_PROFILE_ID,
      args: ["models", "auth", "paste-api-key", "--provider", "deepseek"],
      stdin,
      logLabel: "models auth paste-api-key --provider deepseek",
    });
  }
  return plans;
}

export function formatCommandLog({ label, code, stderr, secrets = [] }) {
  let text = stripAnsi(String(stderr ?? "")).replace(/\s+/g, " ").trim();
  for (const secret of secrets) {
    const value = String(secret ?? "");
    if (value) text = text.split(value).join("[redacted]");
  }
  if (text.length > ENV_SYNC_STDERR_MAX) text = text.slice(-ENV_SYNC_STDERR_MAX);
  return text ? `${label} exit=${code} stderr=${text}` : `${label} exit=${code}`;
}

/** Write `input` to a child stdin and close it. Swallows EPIPE. */
export function deliverSpawnInput(stdin, input) {
  if (input == null || !stdin || typeof stdin.end !== "function") return false;
  if (typeof stdin.on === "function") stdin.on("error", () => {});
  stdin.end(String(input));
  return true;
}
