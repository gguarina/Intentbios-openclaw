# Intentbios OpenClaw plugin

OpenClaw plugin `intentbios` registers coach tools against the Intentbios HTTP API and MCP. Every request sends `x-user-id`. User id comes from the tool `userId`, a `sessionKey` containing `intentbios-user:<id>`, or `INTENTBIOS_DEFAULT_USER_ID` / plugin `defaultUserId`.

| Tool | Aliases | Request |
| --- | --- | --- |
| `intent_create` | `intent.create` | `POST /api/intents` body `{ rawInput }` |
| `journey_message` | `journey.message`, `journey.ask`, `ask` | `POST /api/intents/:id/journey/message` body `{ message, userId }` |
| `intent_execute` | `intent.execute` | `POST /api/intents/:id/execute` body `{ actionTarget, payload, userId }` |
| `state_snapshot` | `state.snapshot` | `GET /api/intents/:id/journey-graphs` |
| `lesson_status` | `lesson.status` | `GET /api/intents/:id`, then `GET /api/goals/:goalId` and `GET /api/goals/:goalId/status` |
| `apartment_pick` | — | MCP `apartment_pick` (`intentId`, optional `rowIds`, `indexes`, `message`) |
| `apartment_draft` | — | MCP `apartment_draft` (`intentId`, optional `rowId`, `index`, `kind`, `message`) |

`intent_execute` requires `actionTarget`. Aliases: `clarify` → `clarifyIntent`, `lock` → `lockDecision`.

`apartment_pick` and `apartment_draft` require `INTENTBIOS_MCP_API_KEY` and call `POST /mcp` with `tools/call`.

`journey_message` and `intent_create` forward `coachCard` when Intentbios sends one. The card is `summary`, `deepLink`, and `suggestedReplies` only, beside the short reply. A missing card is left out. Lesson body, uiSchema, and raw HTML are not added.

Lesson text is not hard-coded here. Sophia stays proposal-only inside Intentbios.

Plugin config (`plugins.entries.intentbios.config`):

- `apiUrl` — Intentbios base URL, no trailing path.
- `defaultUserId` — optional user id when a tool call and the session key omit `userId`.

The Railway wrapper merges that config on boot. See `src/intentbios-coach-config.mjs`.

## Tests

From the repository root:

```bash
node --test plugins/intentbios/client.test.mjs
node --test src/intentbios-coach-config.test.mjs
npm test
```

`npm test` runs `node --test` on `src/*.test.mjs` and `plugins/intentbios/*.test.mjs`.
