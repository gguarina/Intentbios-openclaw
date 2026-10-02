# Tools

These tools call the Intentbios HTTP API. They do not contain lesson content.

| Tool | When |
| --- | --- |
| `intent_create` | Start an intent from the learner's goal. |
| `journey_message` | Send an Ask and read the journey reply. |
| `intent_execute` | Run the current Intentbios step. |
| `state_snapshot` | Read the intent state. |
| `lesson_status` | Read lesson status. Do not author a lesson if this is empty. |

Pass `intentId` from `intent_create` on every later call. Pass `userId` when the conversation has one.
