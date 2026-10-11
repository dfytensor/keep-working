import assert from "node:assert/strict"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
const pluginPath = join(here, "..", "plugins", "keep-working.ts")
const mod = await import(pathToFileURL(pluginPath).href)

assert.equal(typeof mod.KeepWorking, "function", "KeepWorking must be exported as a function")
for (const [name, value] of Object.entries(mod)) {
  assert.equal(typeof value, "function", `export ${name} must be a function (opencode getLegacyPlugins contract)`)
}

function makeProject(config) {
  const dir = mkdtempSync(join(tmpdir(), "kw-"))
  mkdirSync(join(dir, ".opencode"), { recursive: true })
  writeFileSync(join(dir, ".opencode", "keep-working.json"), JSON.stringify(config))
  return dir
}

function assistant(id, extra = {}) {
  return {
    info: { id, role: "assistant", agent: "build", providerID: "prov", modelID: "model", ...extra },
    parts: [{ type: "text", text: "working..." }],
  }
}

function user(id, text) {
  return { info: { id, role: "user", agent: "build" }, parts: [{ type: "text", text }] }
}

function makeState(opts = {}) {
  return {
    todos: opts.todos ?? [],
    messages: opts.messages ?? [],
    session: opts.session ?? { id: "ses_test" },
    status: opts.status ?? {},
    raw: opts.raw === true,
    failGet: opts.failGet === true,
  }
}

function makeCtx(state, dir) {
  const calls = { promptAsync: [], prompt: [], logs: [] }
  const client = {
    app: { log: async (x) => { calls.logs.push(x); return { data: true } } },
    session: {
      get: async () => {
        if (state.failGet) throw new Error("boom")
        return { data: state.session }
      },
      messages: async () => (state.raw ? state.messages : { data: state.messages }),
      todo: async () => (state.raw ? state.todos : { data: state.todos }),
      status: async () => ({ data: state.status }),
      promptAsync: async (payload) => {
        calls.promptAsync.push(payload)
        return { data: undefined }
      },
      prompt: async (payload) => {
        calls.prompt.push(payload)
        return { data: undefined }
      },
    },
  }
  const ctx = {
    client,
    directory: dir,
    worktree: dir,
    project: {},
    serverUrl: new URL("http://localhost:1"),
    $: undefined,
  }
  return { ctx, calls }
}

async function fireIdle(hooks, sessionID = "ses_test") {
  await hooks.event({ event: { id: "evt", type: "session.idle", properties: { sessionID } } })
}

let passed = 0
let failed = 0
async function test(name, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS ${name}`)
  } catch (error) {
    failed++
    console.error(`FAIL ${name}: ${error.message}`)
    process.exitCode = 1
  }
}

const UNFINISHED = [
  { id: "t1", content: "do a thing", status: "in_progress", priority: "high" },
  { id: "t2", content: "do another", status: "pending", priority: "medium" },
]
const DONE = [
  { id: "t1", content: "do a thing", status: "completed", priority: "high" },
  { id: "t2", content: "do another", status: "cancelled", priority: "medium" },
]

async function withHooks(config, state, fn) {
  const dir = makeProject({ cooldown_ms: 0, ...config })
  state.session = state.session ?? { id: "ses_test" }
  const { ctx, calls } = makeCtx(state, dir)
  const hooks = await mod.KeepWorking(ctx)
  try {
    await fn({ hooks, calls, state, dir })
  } finally {
    await hooks.dispose()
  }
}

await test("injects continuation while todos unfinished", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "build me a thing"), assistant("a1")] })
  await withHooks({ max_consecutive: 5 }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
    const payload = calls.promptAsync[0]
    assert.equal(payload.path.id, "ses_test")
    assert.equal(payload.body.agent, "build")
    assert.deepEqual(payload.body.model, { providerID: "prov", modelID: "model" })
    const text = payload.body.parts[0].text
    assert.ok(text.startsWith("continue"))
    assert.ok(text.includes("[in_progress] do a thing"))
    assert.ok(text.includes("[pending] do another"))
  })
})

await test("does not inject when all todos are finished", async () => {
  const state = makeState({ todos: DONE, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 0)
  })
})

await test("does not inject when there are no todos", async () => {
  const state = makeState({ todos: [], messages: [user("m1", "question"), assistant("a1")] })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 0)
  })
})

await test("does not inject after an aborted/errored turn", async () => {
  const state = makeState({
    todos: UNFINISHED,
    messages: [user("m1", "task"), assistant("a1", { error: { name: "MessageAbortedError", data: { message: "stopped" } } })],
  })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 0)
  })
})

await test("does not inject while status is not idle", async () => {
  const state = makeState({
    todos: UNFINISHED,
    status: { ses_test: { type: "busy" } },
    messages: [user("m1", "task"), assistant("a1")],
  })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 0)
  })
})

await test("does not double-inject for the same assistant message", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    await fireIdle(hooks)
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
  })
})

await test("respects max_consecutive and resets on real user message", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({ max_consecutive: 2 }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
    const injected1 = calls.promptAsync[0].body.parts[0].text

    state.messages = [user("m1", "task"), assistant("a1"), user("m2", injected1), assistant("a2")]
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 2, "second injection expected (cap 2, count 1)")
    const injected2 = calls.promptAsync[1].body.parts[0].text

    state.messages = [
      user("m1", "task"), assistant("a1"),
      user("m2", injected1), assistant("a2"),
      user("m3", injected2), assistant("a3"),
    ]
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 2, "cap reached, no injection expected")

    state.messages = [
      user("m1", "task"), assistant("a1"),
      user("m2", injected1), assistant("a2"),
      user("m3", injected2), assistant("a3"),
      user("m4", "human here, please keep going"), assistant("a4"),
    ]
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 3, "counter should reset after real user message")
  })
})

await test("skips child sessions", async () => {
  const state = makeState({
    todos: UNFINISHED,
    session: { id: "ses_test", parentID: "ses_parent" },
    messages: [user("m1", "task"), assistant("a1")],
  })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 0)
  })
})

await test("includes child sessions when configured", async () => {
  const state = makeState({
    todos: UNFINISHED,
    session: { id: "ses_test", parentID: "ses_parent" },
    messages: [user("m1", "task"), assistant("a1")],
  })
  await withHooks({ include_child_sessions: true }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
  })
})

await test("mode always injects without todos", async () => {
  const state = makeState({ todos: [], messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({ mode: "always", max_consecutive: 3 }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
    assert.equal(calls.promptAsync[0].body.parts[0].text, "continue")
  })
})

await test("handles raw (non-wrapped) api responses", async () => {
  const state = makeState({ raw: true, todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
  })
})

await test("survives a failing session.get", async () => {
  const state = makeState({ failGet: true, todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({}, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
  })
})

await test("cooldown defers the injection", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({ cooldown_ms: 120, max_consecutive: 5 }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
    const injected1 = calls.promptAsync[0].body.parts[0].text

    state.messages = [user("m1", "task"), assistant("a1"), user("m2", injected1), assistant("a2")]
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1, "cooldown should defer")
    await new Promise((r) => setTimeout(r, 300))
    assert.equal(calls.promptAsync.length, 2, "deferred injection should fire after cooldown")
  })
})

await test("counter resets when the todo set makes progress", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({ max_consecutive: 1 }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1)
    const injected = calls.promptAsync[0].body.parts[0].text

    state.messages = [user("m1", "task"), assistant("a1"), user("m2", injected), assistant("a2")]
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 1, "same todo set: cap reached")

    state.todos = [
      { id: "t1", content: "do a thing", status: "completed", priority: "high" },
      { id: "t2", content: "do another", status: "pending", priority: "medium" },
    ]
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 2, "progress should reset the counter")
  })
})

await test("disabled config means no injection", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({ enabled: false }, state, async ({ hooks, calls }) => {
    await fireIdle(hooks)
    assert.equal(calls.promptAsync.length, 0)
  })
})

await test("session.deleted cleans up state", async () => {
  const state = makeState({ todos: UNFINISHED, messages: [user("m1", "task"), assistant("a1")] })
  await withHooks({}, state, async ({ hooks }) => {
    await fireIdle(hooks)
    await hooks.event({ event: { id: "evt2", type: "session.deleted", properties: { info: { id: "ses_test" } } } })
  })
})

console.log(`\n${passed}/${passed + failed} tests passed`)
