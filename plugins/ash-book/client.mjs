// HTTP client for book-runner plus Discord upload for #ash-builds.
// Secrets come from env (BOOK_RUNNER_TOKEN, ASH_DISCORD_BOT_TOKEN) and are never returned or logged.

export const ASH_TOOL_NAMES = [
  "book_status",
  "book_locks",
  "book_build",
  "book_file",
  "book_chapters",
  "book_chapter",
  "book_grep",
];

const VOLUME_TITLES = { 1: "The Ash", 2: "The Bands", 3: "The Pattern" };

function scrub(text, env = process.env) {
  let out = String(text ?? "");
  for (const key of ["BOOK_RUNNER_TOKEN", "ASH_DISCORD_BOT_TOKEN"]) {
    const v = String(env[key] || "").trim();
    if (v) out = out.split(v).join("***");
  }
  return out;
}

async function runner(settings, method, pathAndQuery, body, { raw = false, timeoutMs = 600_000 } = {}) {
  const token = String(process.env.BOOK_RUNNER_TOKEN || "").trim();
  if (!settings.runnerUrl) throw new Error("ash-book: runnerUrl is not configured");
  if (!token) throw new Error("ash-book: BOOK_RUNNER_TOKEN is not set");
  const res = await fetch(settings.runnerUrl.replace(/\/$/, "") + pathAndQuery, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (raw) {
    if (!res.ok) throw Object.assign(new Error(`book-runner ${res.status}`), { status: res.status });
    return res;
  }
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { text };
  }
  if (!res.ok) throw Object.assign(new Error(scrub(data.error || `book-runner ${res.status}`)), { status: res.status });
  return data;
}

function clip(s, n) {
  s = String(s ?? "");
  return s.length > n ? s.slice(0, n) + `\n…[${s.length - n} more chars]` : s;
}

export async function postToDiscord(channelId, content, files = []) {
  const token = String(process.env.ASH_DISCORD_BOT_TOKEN || "").trim();
  if (!token) throw new Error("ASH_DISCORD_BOT_TOKEN is not set");
  if (!/^\d{5,30}$/.test(String(channelId || ""))) throw new Error("buildsChannelId is not configured");
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ content: clip(content, 1900), allowed_mentions: { parse: [] }, attachments: files.map((f, i) => ({ id: i, filename: f.name })) }),
  );
  files.forEach((f, i) => form.append(`files[${i}]`, new Blob([f.bytes], { type: "application/pdf" }), f.name));
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}` },
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`discord post failed: ${res.status} ${scrub(data.message || "")}`);
  return { messageId: data.id, channelId };
}

export async function executeAshTool(name, params, settings) {
  const branch = String(params.branch || settings.defaultBranch || "rewrite");
  const q = (o) => "?" + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  switch (name) {
    case "book_status":
      return runner(settings, "GET", "/status");
    case "book_file": {
      const res = await runner(settings, "GET", "/file" + q({ branch, path: params.path }), null, { raw: true });
      return { branch, path: params.path, text: clip(await res.text(), Number(params.maxChars) || 60_000) };
    }
    case "book_chapters":
      return runner(settings, "GET", "/chapters" + q({ branch }));
    case "book_chapter": {
      const d = await runner(settings, "GET", "/chapter" + q({ branch, vol: params.volume, ch: params.chapter }));
      return { ...d, text: clip(d.text, Number(params.maxChars) || 80_000) };
    }
    case "book_grep":
      return runner(settings, "GET", "/grep" + q({ branch, pattern: params.pattern, vol: params.volume }));
    case "book_locks": {
      const d = await runner(settings, "POST", "/locks", { branch });
      const result = { branch: d.branch, sha: d.sha, ok: d.ok, exit: d.exit, output: clip(d.output, 6000) };
      if (params.post === true && settings.buildsChannelId) {
        const head = `**Locks ${d.ok ? "PASS ✅" : "FAIL ❌"}** on \`${d.branch}\` @ \`${String(d.sha).slice(0, 7)}\``;
        const tail = d.ok ? "" : "\n```\n" + clip(String(d.output).split("LOCKS: FAIL").pop(), 1500) + "\n```";
        result.posted = await postToDiscord(settings.buildsChannelId, head + tail);
      }
      return result;
    }
    case "book_build": {
      const volumes = Array.isArray(params.volumes) && params.volumes.length ? params.volumes : [1, 2, 3];
      const d = await runner(settings, "POST", "/build", { branch, volumes });
      const result = {
        branch: d.branch,
        sha: d.sha,
        ok: d.ok,
        volumes: (d.volumes || []).map((v) => ({ volume: v.volume, ok: v.ok, seconds: v.seconds, bytes: v.bytes, path: v.path, log_tail: v.log_tail ? clip(v.log_tail, 1500) : undefined })),
      };
      if (params.post !== false && settings.buildsChannelId) {
        let locksLine = "";
        if (params.withLocks !== false) {
          try {
            const l = await runner(settings, "POST", "/locks", { branch });
            locksLine = `\nLocks: ${l.ok ? "PASS ✅" : "FAIL ❌"}`;
            result.locksOk = l.ok;
          } catch (err) {
            locksLine = `\nLocks: error (${scrub(err.message)})`;
          }
        }
        const files = [];
        for (const v of d.volumes || []) {
          if (!v.ok || !v.path) continue;
          const res = await runner(settings, "GET", v.path, null, { raw: true, timeoutMs: 120_000 });
          files.push({ name: v.path.split("/").pop(), bytes: new Uint8Array(await res.arrayBuffer()) });
        }
        const lines = (d.volumes || []).map((v) => `• Book ${v.volume}${VOLUME_TITLES[v.volume] ? ` (${VOLUME_TITLES[v.volume]})` : ""}: ${v.ok ? `ok, ${Math.round((v.bytes || 0) / 1024)} KB` : "FAILED"}`);
        const content = `**Build ${d.ok ? "OK ✅" : "FAILED ❌"}** — \`${d.branch}\` @ \`${String(d.sha).slice(0, 7)}\`${locksLine}\n${lines.join("\n")}`;
        result.posted = await postToDiscord(settings.buildsChannelId, content, files);
      }
      return result;
    }
    default:
      throw new Error(`unknown ash-book tool ${name}`);
  }
}
