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
  "book_branches",
];

export const ASH_REPORT_TOOL = "post_report";

export const ASH_WRITE_TOOL_NAMES = [
  "work_start",
  "work_edit",
  "work_write",
  "work_diff",
  "work_discard",
  "work_commit",
  "work_pr",
  "work_merge",
];

const VOLUME_TITLES = { 1: "The Ash", 2: "The Bands", 3: "The Pattern" };

const DISCORD_API = "https://discord.com/api/v10";

function ashChannelIds(env = process.env) {
  return String(env.ASH_DISCORD_CHANNELS || "")
    .split(/[\s,]+/)
    .map((p) => p.split(/[:=]/)[1])
    .filter((v) => /^\d{5,30}$/.test(v || ""));
}

/** Resolve the target: explicit id or the current conversation; must be an Ash channel or a thread under one. */
export async function resolveReportChannel(requested, currentId, fetchImpl = fetch, env = process.env) {
  const id = String(requested || currentId || "").replace(/^(discord:|channel:)/, "").trim();
  if (!/^\d{5,30}$/.test(id)) throw new Error("no Discord channel: pass channel or call from a Discord conversation");
  const allowed = ashChannelIds(env);
  if (allowed.includes(id)) return id;
  const token = String(env.ASH_DISCORD_BOT_TOKEN || "").trim();
  const res = await fetchImpl(`${DISCORD_API}/channels/${id}`, { headers: { Authorization: `Bot ${token}` }, signal: AbortSignal.timeout(15_000) });
  const ch = await res.json().catch(() => ({}));
  if (res.ok && ch.parent_id && allowed.includes(String(ch.parent_id))) return id; // thread in an Ash channel
  if (res.ok && ch.type === 1) return id; // DM with the Ash bot (allowlisted users only)
  throw new Error("post_report only posts to the Ash channels, their threads, or the Ash DM");
}

export async function postReport(params, ctx = {}) {
  const md = String(params.markdown || "");
  if (!md.trim()) throw new Error("markdown is required");
  const bytes = new TextEncoder().encode(md);
  if (bytes.length > 1_000_000) throw new Error(`report too large (${bytes.length} bytes; max 1 MB) — split it`);
  let name = String(params.filename || "report.md").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "report.md";
  if (!/\.(md|txt)$/i.test(name)) name += ".md";
  const channelId = await resolveReportChannel(params.channel, ctx.nativeChannelId);
  const summary = String(params.summary || "").trim() || `📄 ${name}`;
  const token = String(process.env.ASH_DISCORD_BOT_TOKEN || "").trim();
  if (!token) throw new Error("ASH_DISCORD_BOT_TOKEN is not set");
  const form = new FormData();
  form.append("payload_json", JSON.stringify({ content: clip(summary, 1800), allowed_mentions: { parse: [] }, attachments: [{ id: 0, filename: name }] }));
  form.append("files[0]", new Blob([bytes], { type: "text/markdown; charset=utf-8" }), name);
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, { method: "POST", headers: { Authorization: `Bot ${token}` }, body: form, signal: AbortSignal.timeout(60_000) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`discord upload failed: ${res.status} ${scrub(data.message || "")}`);
  const guild = data.guild_id || String(process.env.ASH_DISCORD_GUILD_ID || "").trim();
  return {
    posted: true,
    channelId,
    filename: name,
    bytes: bytes.length,
    chars: md.length,
    messageId: data.id,
    jumpUrl: guild ? `https://discord.com/channels/${guild}/${channelId}/${data.id}` : undefined,
    fileUrl: data.attachments?.[0]?.url,
    note: "The file and summary are already posted; reply with at most one short line (or nothing extra).",
  };
}

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
  return { messageId: data.id, channelId, jumpUrl: data.guild_id || process.env.ASH_DISCORD_GUILD_ID ? `https://discord.com/channels/${data.guild_id || String(process.env.ASH_DISCORD_GUILD_ID).trim()}/${channelId}/${data.id}` : undefined };
}

export async function executeAshTool(name, params, settings) {
  const branch = String(params.branch || settings.defaultBranch || "rewrite");
  const q = (o) => "?" + new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();
  switch (name) {
    case "book_branches":
      return runner(settings, "GET", "/branches");
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
    case "work_start":
      return runner(settings, "POST", "/work/start", { slug: params.slug });
    case "work_edit":
      return runner(settings, "POST", "/work/edit", { slug: params.slug, file: params.file, old: params.old, new: params.new ?? "" });
    case "work_write":
      return runner(settings, "POST", "/work/write", { slug: params.slug, file: params.file, content: params.content, mode: params.mode || "append" });
    case "work_diff":
      return runner(settings, "POST", "/work/diff", { slug: params.slug });
    case "work_discard":
      return runner(settings, "POST", "/work/discard", { slug: params.slug });
    case "work_commit": {
      const d = await runner(settings, "POST", "/work/commit", { slug: params.slug, message: params.message, volumes: params.volumes });
      if (!d.committed) return { ...d, patch: clip(d.patch, 3000), locks_output: clip(d.locks_output, 3000) };
      const result = { branch: d.branch, sha: d.sha, committed: true, locks: d.locks, pushed: true, stat: d.stat, patch: clip(d.patch, 3000), build_ok: d.build?.ok };
      if (settings.buildsChannelId) {
        const files = [];
        for (const v of d.build?.volumes || []) {
          if (!v.ok || !v.path) continue;
          const res = await runner(settings, "GET", v.path, null, { raw: true, timeoutMs: 120_000 });
          files.push({ name: v.path.split("/").pop(), bytes: new Uint8Array(await res.arrayBuffer()) });
        }
        const lines = (d.build?.volumes || []).map((v) => `• Book ${v.volume}${VOLUME_TITLES[v.volume] ? ` (${VOLUME_TITLES[v.volume]})` : ""}: ${v.ok ? "ok" : "FAILED"}`);
        const content = `**Work build ${d.build?.ok ? "OK ✅" : "FAILED ❌"}** — \`${d.branch}\` @ \`${String(d.sha).slice(0, 7)}\` (locks PASS)\n${lines.join("\n")}`;
        result.pdfs = await postToDiscord(settings.buildsChannelId, content, files);
      }
      return result;
    }
    case "work_pr":
      return runner(settings, "POST", "/work/pr", { slug: params.slug, title: params.title, body: params.body });
    case "work_merge":
      if (params.confirm !== "merge") throw new Error('work_merge needs confirm="merge", and only after Gustavo typed "merge" for this branch');
      return runner(settings, "POST", "/work/merge", { slug: params.slug, confirm: "merge" }, { timeoutMs: 600_000 });
    default:
      throw new Error(`unknown ash-book tool ${name}`);
  }
}
