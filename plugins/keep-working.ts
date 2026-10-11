// keep-working — OpenCode plugin: auto-continue until the work is complete.
//
// When a session goes idle while it still has unfinished todos (pending or
// in_progress), the plugin injects a continuation message so the agent keeps
// working. When every todo is completed/cancelled it stays silent.
//
// Install:  ~/.config/opencode/plugins/keep-working.ts        (global, all projects)
//           <project>/.opencode/plugins/keep-working.ts       (single project)
//
// Config:   ~/.config/opencode/keep-working.json              (global)
//           <project>/.opencode/keep-working.json             (project override)
//
// Options (all optional):
//   enabled                 true       master switch
//   mode                    "todos"    "todos": continue only while unfinished todos exist
//                                      "always": continue whenever idle (bounded by max_consecutive)
//   message                 "continue" base text of the injected message
//   include_todos           true       append the list of unfinished todos
//   cooldown_ms             5000       minimum gap between two injections in one session
//   max_consecutive         25         max consecutive injections with no todo progress
//                                      (counter resets whenever the user replies or the
//                                      unfinished-todo set changes: completion or new items)
//   include_child_sessions  false      also auto-continue child (subagent) sessions

import { existsSync, readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULTS = {
  enabled: true,
  mode: "todos",
  message: "continue",
  include_todos: true,
  cooldown_ms: 5000,
  max_consecutive: 25,
  include_child_sessions: false,
}

function readJson(path) {
  try {
    if (!existsSync(path)) return null
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

export const KeepWorking = async (ctx) => {
  const client = ctx.client
  const directory = ctx.directory
  const pluginDir = dirname(fileURLToPath(import.meta.url))
  const globalConfigPath = join(dirname(pluginDir), "keep-working.json")
  const projectConfigPath = join(directory, ".opencode", "keep-working.json")
  const states = new Map()

  function loadConfig() {
    const cfg = { ...DEFAULTS }
    for (const file of [globalConfigPath, projectConfigPath]) {
      const parsed = readJson(file)
      if (parsed) Object.assign(cfg, parsed)
    }
    if (!Number.isFinite(cfg.cooldown_ms) || cfg.cooldown_ms < 0) cfg.cooldown_ms = DEFAULTS.cooldown_ms
    if (!Number.isFinite(cfg.max_consecutive) || cfg.max_consecutive < 0) cfg.max_consecutive = DEFAULTS.max_consecutive
    if (cfg.mode !== "always") cfg.mode = "todos"
    if (typeof cfg.message !== "string" || !cfg.message.trim()) cfg.message = DEFAULTS.message
    cfg.enabled = cfg.enabled !== false
    cfg.include_todos = cfg.include_todos !== false
    cfg.include_child_sessions = cfg.include_child_sessions === true
    return cfg
  }

  function stateFor(sessionID) {
    let state = states.get(sessionID)
    if (!state) {
      state = {
        consecutive: 0,
        lastInjectedAt: 0,
        lastInjectedText: "",
        respondedToMessageID: "",
        inFlight: false,
        timer: null,
      }
      states.set(sessionID, state)
    }
    return state
  }

  async function call(promise) {
    try {
      const res = await promise
      if (res && typeof res === "object" && "error" in res && res.error) return { ok: false, error: res.error }
      const data = res && typeof res === "object" && "data" in res ? res.data : res
      return { ok: true, data }
    } catch (error) {
      return { ok: false, error }
    }
  }

  function log(level, message, extra) {
    try {
      const result = client.app && typeof client.app.log === "function"
        ? client.app.log({ body: { service: "keep-working", level, message, ...(extra ? { extra } : {}) } })
        : null
      if (result && typeof result.catch === "function") result.catch(() => {})
    } catch {}
  }

  function textOf(entry) {
    if (!entry || !Array.isArray(entry.parts)) return ""
    return entry.parts
      .filter((part) => part && part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("")
  }

  async function onIdle(sessionID) {
    const cfg = loadConfig()
    if (!cfg.enabled) return
    const state = stateFor(sessionID)
    if (state.inFlight) return

    const now = Date.now()
    const wait = state.lastInjectedAt + cfg.cooldown_ms - now
    if (state.lastInjectedAt && wait > 0) {
      if (!state.timer) {
        state.timer = setTimeout(() => {
          state.timer = null
          onIdle(sessionID).catch(() => {})
        }, wait)
      }
      return
    }

    state.inFlight = true
    try {
      if (!cfg.include_child_sessions && client.session && typeof client.session.get === "function") {
        const info = await call(client.session.get({ path: { id: sessionID } }))
        if (info.ok && info.data && info.data.parentID) return
      }

      if (!client.session || typeof client.session.messages !== "function") return
      const messages = await call(client.session.messages({ path: { id: sessionID } }))
      if (!messages.ok || !Array.isArray(messages.data) || messages.data.length === 0) return

      const list = messages.data
      let lastAssistant = null
      let lastUser = null
      for (let i = list.length - 1; i >= 0; i--) {
        const entry = list[i]
        if (!lastAssistant && entry && entry.info && entry.info.role === "assistant") lastAssistant = entry
        if (!lastUser && entry && entry.info && entry.info.role === "user") lastUser = entry
        if (lastAssistant && lastUser) break
      }
      if (!lastAssistant || !lastAssistant.info) return
      if (lastAssistant.info.error) return
      if (lastAssistant.info.summary === true) return
      if (state.respondedToMessageID && lastAssistant.info.id === state.respondedToMessageID) return

      const lastUserText = textOf(lastUser).trim()
      if (lastUserText && lastUserText !== state.lastInjectedText) state.consecutive = 0

      if (typeof client.session.todo !== "function") return
      const todosRes = await call(client.session.todo({ path: { id: sessionID } }))
      const todos = todosRes.ok && Array.isArray(todosRes.data) ? todosRes.data : []
      const unfinished = todos.filter((t) => t && (t.status === "pending" || t.status === "in_progress"))
      if (cfg.mode !== "always" && unfinished.length === 0) {
        state.consecutive = 0
        state.todoSignature = ""
        return
      }

      const todoSignature = JSON.stringify(unfinished.map((t) => [t.id, t.status]))
      if (state.todoSignature && todoSignature !== state.todoSignature) state.consecutive = 0
      state.todoSignature = todoSignature
      if (state.consecutive >= cfg.max_consecutive) return

      if (client.session && typeof client.session.status === "function") {
        const statusRes = await call(client.session.status({}))
        if (statusRes.ok && statusRes.data && typeof statusRes.data === "object") {
          const entry = statusRes.data[sessionID]
          if (entry && entry.type && entry.type !== "idle") return
        }
      }

      let text = cfg.message.trim()
      if (cfg.include_todos && unfinished.length > 0) {
        const lines = unfinished
          .slice(0, 30)
          .map((t) => `- [${t.status}] ${String(t.content || "").replace(/\s+/g, " ").trim().slice(0, 200)}`)
        text += `\n\nUnfinished todos:\n${lines.join("\n")}\n\nKeep working until all todos are completed.`
      }

      const body = { parts: [{ type: "text", text }] }
      const info = lastAssistant.info
      const agent = info.agent || (lastUser && lastUser.info ? lastUser.info.agent : undefined)
      if (typeof agent === "string" && agent) body.agent = agent
      const providerID = info.providerID || (info.model && info.model.providerID)
      const modelID = info.modelID || (info.model && info.model.modelID)
      if (typeof providerID === "string" && typeof modelID === "string" && providerID && modelID) {
        body.model = { providerID, modelID }
      }
      if (typeof info.variant === "string" && info.variant) body.variant = info.variant

      const payload = { path: { id: sessionID }, body, query: { directory } }
      const sent = typeof client.session.promptAsync === "function"
        ? await call(client.session.promptAsync(payload))
        : await call(client.session.prompt(payload))
      if (!sent.ok) {
        log("warn", "failed to inject continuation", { sessionID, error: String((sent.error && sent.error.message) || sent.error) })
        return
      }

      state.respondedToMessageID = info.id || state.respondedToMessageID
      state.consecutive += 1
      state.lastInjectedAt = Date.now()
      state.lastInjectedText = text.trim()
      log("debug", "injected continuation", { sessionID, count: state.consecutive, unfinished: unfinished.length })
    } catch (error) {
      log("error", "keep-working idle handler failed", { sessionID, error: String((error && error.message) || error) })
    } finally {
      state.inFlight = false
    }
  }

  return {
    event: async ({ event }) => {
      try {
        if (!event || typeof event.type !== "string") return
        if (event.type === "session.deleted") {
          const props = event.properties || {}
          const id = (props.info && props.info.id) || props.sessionID
          if (id && states.has(id)) {
            const state = states.get(id)
            if (state.timer) clearTimeout(state.timer)
            states.delete(id)
          }
          return
        }
        if (event.type !== "session.idle") return
        const sessionID = event.properties && event.properties.sessionID
        if (typeof sessionID !== "string" || !sessionID) return
        await onIdle(sessionID)
      } catch {}
    },
    dispose: async () => {
      for (const state of states.values()) {
        if (state.timer) clearTimeout(state.timer)
      }
      states.clear()
    },
  }
}
