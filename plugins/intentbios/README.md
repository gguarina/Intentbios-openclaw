# Intentbios OpenClaw plugin

OpenClaw plugin `intentbios` registers five coach tools that call the Intentbios HTTP API:

| Tool | Request |
| --- | --- |
| `intent_create` | `POST /api/intents` |
| `journey_message` | `POST /api/intents/:intentId/messages` (`kind: "ask"`) |
| `intent_execute` | `POST /api/intents/:intentId/execute` |
| `state_snapshot` | `GET /api/intents/:intentId/state` |
| `lesson_status` | `GET /api/intents/:intentId/lessons/status` |

Every call sends `agentId` (default `intentbios-coach`). Sophia is not this plugin. Lesson text is not hard-coded here; `lesson_status` returns the Intentbios payload.

Plugin config (`plugins.entries.intentbios.config`):

- `apiUrl` — Intentbios base URL, no trailing path.
- `defaultUserId` — optional user id when a tool call omits `userId`.

The Railway wrapper merges that config on boot. See `src/intentbios-coach-config.mjs`.

## Tests

From the repository root:

```bash
node --test plugins/intentbios/client.test.mjs
node --test src/intentbios-coach-config.test.mjs
npm test
```

`npm test` runs `node --test` on `src/*.test.mjs` and `plugins/intentbios/*.test.mjs`.
