# Where the OpenClaw agent prompts live

| Agent | Model / tier (src/model-tiering-config.mjs) | Prompt sources |
| --- | --- | --- |
| `main` (Discord #dev, #intents, DMs) | `AGENT_TIERS.main` | Workspace `AGENTS.md` (OpenClaw default) plus the managed Intentbios block from `plugins/main-knowledge/INTENTBIOS.md`, written on every boot by `writeKnowledge` (`src/discord-coding-config.mjs`); coding skills from `writeCodingSkills`; per-channel `systemPrompt`: `INTENTS_PROMPT` for #intents (`src/discord-coding-config.mjs`). |
| `planner` | `AGENT_TIERS.planner` | Shares main's workspace (same `AGENTS.md` + Intentbios block). Entry, tools and deny list: `mergeModelTiering` (`src/model-tiering-config.mjs`). |
| `intentbios-coach` | `AGENT_TIERS["intentbios-coach"]` | `plugins/intentbios/workspace/{AGENTS,IDENTITY,SOUL,TOOLS,USER}.md`; agent entry and tool allowlist: `src/intentbios-coach-config.mjs`; tool descriptions: `plugins/intentbios/index.js`. |

Live copies (after boot merges) are on the OpenClaw volume: `/data/.openclaw/openclaw.json`
(`agents.list`, `channels.discord.guilds.*.channels.*.systemPrompt`) and each agent's workspace
files. Read them with `openclaw config get agents` / `openclaw agents list --json` or the setup
page; tokens are env references, never inline.

The Intentbios app's own model calls (skill graph planner, lesson draft/repair/pro, figure spec,
coach turns, introduction/autostart) are shown per intent in the app: Debug tab → **Agent prompts**
(system + user prompt, model, thinking, latency, tokens, raw output, check result; last 50 per
intent, in memory, redacted).
