# keep-working

An [OpenCode](https://opencode.ai) plugin that **keeps the agent working until the job is done**.

When a session goes idle while it still has unfinished todos (`pending` / `in_progress`), the plugin automatically injects a continuation message with the remaining todo list, so the agent picks the work back up instead of stopping halfway. When every todo is completed/cancelled, the plugin stays silent — no interference, no token burn.

```
agent: [finishes a turn, 3 of 7 todos still pending]  →  session.idle
plugin: "continue — Unfinished todos: ... Keep working until all todos are completed."
agent: [keeps working ...]
```

## Features

- **Todo-driven stopping condition** — continues only while the session's todo list has unfinished items; stops silently once everything is done.
- **Never fights an abort** — turns that ended in an error or an aborted message (`MessageAbortedError`, i.e. the user pressed Stop) are never auto-continued.
- **Progress-aware budget** — after `max_consecutive` injections with *no todo progress* it gives up, but the counter resets whenever a todo changes state or the user sends a real message.
- **Cooldown** — configurable minimum gap between injections; deferred, not dropped, when racing an active turn.
- **Skips subagent sessions** by default (child sessions created by the `task` tool).
- **Single self-contained TypeScript file** — no dependencies, no build step.

## Install

Copy `plugins/keep-working.ts` into one of OpenCode's plugin directories:

| Scope   | Path                                                                                              |
| ------- | ------------------------------------------------------------------------------------------------- |
| Global  | `~/.config/opencode/plugins/keep-working.ts` (on Windows: `C:\Users\<you>\.config\opencode\plugins\keep-working.ts`) |
| Project | `<project>/.opencode/plugins/keep-working.ts`                                                      |

The plugin is auto-discovered — no config entry needed. Then **restart OpenCode** (config and plugins load at startup).

Optionally copy `keep-working.example.json` to `~/.config/opencode/keep-working.json` (or `<project>/.opencode/keep-working.json`) to tune it. Without a config file the defaults below apply.

Verify your install with the bundled test suite (Node 22.6+):

```
node --experimental-strip-types test/keep-working.test.mjs
```

(On Node 24+ type stripping is on by default, so plain `node test/keep-working.test.mjs` works.)

## Configuration

The plugin reads JSON from two places, later wins:

1. `~/.config/opencode/keep-working.json` — global
2. `<project>/.opencode/keep-working.json` — project override

| Option                   | Default      | Description                                                                                                            |
| ------------------------ | ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `enabled`                | `true`       | Master switch.                                                                                                          |
| `mode`                   | `"todos"`    | `"todos"`: continue only while unfinished todos exist. `"always"`: continue whenever idle (capped by `max_consecutive`). |
| `message`                | `"continue"` | Base text of the injected message.                                                                                      |
| `include_todos`          | `true`       | Append the unfinished todo list to the injected message.                                                                |
| `cooldown_ms`            | `5000`       | Minimum milliseconds between two injections in one session.                                                             |
| `max_consecutive`        | `25`         | Max consecutive injections with no todo progress. Resets on user reply or todo progress.                                |
| `include_child_sessions` | `false`      | Also auto-continue child (subagent) sessions.                                                                           |

Example — keep going aggressively while a task runs:

```json
{
  "mode": "todos",
  "cooldown_ms": 2000,
  "max_consecutive": 50,
  "message": "continue"
}
```

## How it works

The plugin registers an `event` hook and listens for `session.idle`. On each idle it:

1. Skips child sessions (unless `include_child_sessions`).
2. Loads the session messages; finds the last assistant and last user message.
3. Refuses to continue if the last assistant turn has an `error` or is a compaction summary.
4. Deduplicates per assistant message — one injection per completed turn.
5. Resets the consecutive counter if the user sent a real message (i.e. the last user message isn't the plugin's own continuation).
6. Fetches the session's todo list. If there are no unfinished todos (and mode is `todos`), it stops.
7. Resets the counter when the unfinished-todo set changed (progress was made).
8. Stops when `max_consecutive` is exceeded.
9. Re-checks that the session is still idle (avoids racing a newly started turn).
10. Sends the continuation with the same agent/model/variant as the last assistant turn via `session.promptAsync`.

All API calls are wrapped defensively: any failure is swallowed (and best-effort logged via the plugin log service) rather than breaking the host.

## Requirements

- OpenCode with plugin support (developed and end-to-end tested against OpenCode Desktop 1.18.35; works in the CLI too).
- Runtime with native TypeScript stripping (Node ≥ 22.6 with `--experimental-strip-types`, Node ≥ 23.6 by default, or Bun). The desktop app bundles Node 24 and loads the `.ts` plugin directly.

## Troubleshooting

- **Nothing happens.** The config/plugins are loaded only at OpenCode startup — fully restart the app. Note the desktop app keeps one instance per project directory; restart the whole app, not just the session.
- **It keeps injecting but nothing gets done.** The agent is not making todo progress; after `max_consecutive` strikes (default 25) it stops. Mark todos completed/cancelled or cancel the run to stop it immediately.
- **It stopped early.** A real user message or an errored/aborted turn resets/skips auto-continue by design; `max_consecutive` may also have been reached. Raise it in the config if needed.
- **Disable it.** Set `"enabled": false` in `keep-working.json`, or delete the plugin file.

## License

MIT — see [LICENSE](LICENSE).
