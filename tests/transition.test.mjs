import assert from "node:assert/strict";
import test from "node:test";
import { sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { TransitionCoordinator } from "../src/transition-coordinator.ts";
import { TRANSITION_ENTRY, latestTransition } from "../src/transition-state.ts";
import { getCodexAccountFingerprint } from "../src/codex-wire.ts";
import { createTransitionCheckpoint, REMOTE_SUMMARY_MARKER } from "../src/remote-compaction.ts";

const token = account => `x.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: account },
})).toString("base64url")}.x`;
const model = id => ({
  id, provider: "openai-codex", api: "openai-codex-responses",
  baseUrl: "https://chatgpt.com/backend-api", contextWindow: 128000, reasoning: false,
  input: ["text"], maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
});
const A = model("model-a"), B = model("model-b");
const details = {
  kind: "pi-codex-compaction", version: 2, provider: "openai-codex", model: A.id,
  endpoint: "https://chatgpt.com/backend-api/codex/responses",
  accountFingerprint: getCodexAccountFingerprint(token("account")), authKind: "oauth",
  encryptedContent: "C1",
};
const user = (id, text = id) => ({ type: "message", id,
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 } });
const system = (id, text = id) => ({ type: "message", id,
  message: { role: "system", content: [{ type: "text", text }], timestamp: 1 } });
const assistant = id => ({ type: "message", id, message: {
  role: "assistant", api: A.api, provider: A.provider, model: A.id, timestamp: 2,
  content: [{ type: "toolCall", id: `${id}|fc_${id}`, name: "fixture", arguments: { x: 1 } }],
  stopReason: "toolUse", usage: { input: 0, output: 0, totalTokens: 0,
    cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
} });
const result = id => ({ type: "message", id: `${id}-result`, message: {
  role: "toolResult", toolCallId: `${id}|fc_${id}`, toolName: "fixture",
  content: [{ type: "text", text: "result" }], isError: false, timestamp: 3,
} });
function fixture(compact) {
  let count = 0;
  const root = { type: "compaction", id: "root", summary: `${REMOTE_SUMMARY_MARKER}\nreadable`,
    details, systemMessage: "Pi-owned compaction system message",
    timestamp: new Date().toISOString(), tokensBefore: 100, firstKeptEntryId: "old" };
  const entries = [root, user("old"), assistant("call"), result("call"), user("incoming")];
  const ctx = {
    model: B, signal: new AbortController().signal, getSystemPrompt: () => "test",
    sessionManager: { getBranch: () => entries, buildContextEntries: () => entries,
      getSessionId: () => "session" },
    modelRegistry: { getApiKeyAndHeaders: async () => ({ ok: true, apiKey: token("account") }),
      isUsingOAuth: () => true },
  };
  const create = () => new TransitionCoordinator(
    (customType, data) => entries.push({ type: "custom", id: `record-${count++}`, customType, data }),
    () => [], () => "off", payload => payload, compact,
  );
  const messages = () => ctx.sessionManager.buildContextEntries().flatMap(sessionEntryToContextMessages);
  const record = () => latestTransition(entries, "session");
  return { entries, ctx, create, messages, record, root };
}
function payload(messages) {
  // Minimal provider shape of a serialized Pi compaction summary.
  const summary = messages[0];
  return { input: [{ type: "message", role: "user", content: [{
    type: "input_text", text: `The conversation history before this point was compacted into the following summary:\n${summary.summary}`,
  }] }, ...messages.slice(1)] };
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
async function transitionedFixture() {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ...details, encryptedContent: "C2" }; });
  const initial = f.create();
  await initial.select({ previousModel: A, model: B }, f.ctx);
  await initial.context(f.messages(), f.ctx);
  assert.equal(f.record().status, "TRANSITIONED");
  // Reproduce against persisted TRANSITIONED state, not an in-flight compaction.
  return { ...f, coordinator: f.create(), calls: () => calls };
}
function pauseAuth(f) {
  const entered = deferred(), auth = deferred();
  f.ctx.modelRegistry.getApiKeyAndHeaders = () => { entered.resolve(); return auth.promise; };
  return { entered: entered.promise, resolve: () => auth.resolve({ ok: true, apiKey: token("account") }) };
}

test("requestPayload cannot inject persisted C2 after invalidation and branch replacement during auth", async () => {
  const f = await transitionedFixture(), c = f.coordinator;
  const virtual = await c.context(f.messages(), f.ctx);
  const original = payload(virtual), before = JSON.stringify(original);
  const auth = pauseAuth(f);
  const running = c.requestPayload(original, f.ctx);
  await auth.entered;
  c.invalidate();
  f.entries.splice(0, f.entries.length, { ...f.root, id: "unrelated-root" }, user("unrelated"));
  auth.resolve();
  assert.equal(await running, undefined);
  assert.equal(c.request, undefined);
  assert.equal(await c.requestPayload(payload(f.messages()), f.ctx), undefined);
  assert.equal(JSON.stringify(original), before);
  assert.equal(f.calls(), 1);
});

test("context cannot repopulate request state after invalidation during auth", async () => {
  const f = await transitionedFixture(), c = f.coordinator;
  const original = f.messages(), before = JSON.stringify(original);
  const auth = pauseAuth(f);
  const running = c.context(original, f.ctx);
  await auth.entered;
  c.invalidate();
  auth.resolve();
  assert.equal(await running, undefined);
  assert.equal(c.request, undefined);
  assert.equal(await c.requestPayload(payload(original), f.ctx), undefined);
  assert.equal(JSON.stringify(original), before);
  assert.equal(f.calls(), 1);
});

test("explicit A→B→A→B transitions are bounded across multiple tool cycles and reconstruction", async () => {
  let calls = 0;
  const f = fixture(async (_ctx, source, previous, messages) => {
    calls++;
    assert.equal(source.id, calls % 2 ? A.id : B.id);
    if (calls === 1) {
      assert.equal(previous.encryptedContent, "C1");
      assert.deepEqual(messages.map(m => m.role), ["user", "assistant", "toolResult"]);
      assert.equal(JSON.stringify(messages).includes("incoming"), false);
    }
    return { ...previous, encryptedContent: `C${calls + 1}` };
  });
  let c = f.create();
  await c.select({ previousModel: A, model: B, source: "set" }, f.ctx);
  assert.equal(f.record().status, "PENDING");
  let messages = await c.context(f.messages(), f.ctx);
  assert.equal(f.record().status, "TRANSITIONED");
  assert.equal(f.record().details.model, B.id);
  assert.equal(f.record().details.encryptedContent, "C2");
  assert.deepEqual(messages.slice(1).map(m => m.role), ["user"]);
  let p = await c.requestPayload(payload(messages), f.ctx);
  assert.equal(p.input[0].encrypted_content, "C2");
  for (let i = 0; i < 3; i++) {
    f.entries.push(assistant(`b-${i}`), result(`b-${i}`));
    messages = await c.context(f.messages(), f.ctx);
    p = await c.requestPayload(payload(messages), f.ctx);
    assert.equal(p.input[0].encrypted_content, "C2");
    assert.equal(calls, 1);
  }
  c = f.create();
  messages = await c.context(f.messages(), f.ctx);
  assert.equal((await c.requestPayload(payload(messages), f.ctx)).input[0].encrypted_content, "C2");
  assert.equal(calls, 1);
  f.ctx.model = A;
  await c.select({ previousModel: B, model: A }, f.ctx);
  f.entries.push(user("second"));
  await c.context(f.messages(), f.ctx);
  assert.equal(f.record().details.encryptedContent, "C3");
  f.ctx.model = B;
  await c.select({ previousModel: A, model: B }, f.ctx);
  f.entries.push(user("third"));
  await c.context(f.messages(), f.ctx);
  assert.equal(calls, 3);
  assert.equal(f.record().details.encryptedContent, "C4");
});

test("model mismatch without selection never initiates compaction", async () => {
  const f = fixture(() => { throw new Error("must not compact"); });
  assert.equal(await f.create().context(f.messages(), f.ctx), undefined);
  assert.equal(f.record(), undefined);
});

test("compaction systemMessage stays outside visible comparisons and transitioned context", async () => {
  let calls = 0;
  const f = fixture(async (_ctx, source, previous, messages) => {
    calls++;
    assert.equal(source.id, A.id);
    assert.deepEqual(messages.map(message => message.role), ["user", "assistant", "toolResult"]);
    return { ...previous, encryptedContent: "system-C2" };
  });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  const originalVisible = f.messages().filter(message => message.role !== "system");
  const virtual = await c.context(originalVisible, f.ctx);
  assert.equal(f.record().status, "TRANSITIONED");
  assert.deepEqual(virtual.map(message => message.role), ["compactionSummary", "user"]);
  assert.equal(JSON.stringify(virtual).includes("Pi-owned compaction system message"), false);
  const request = await c.requestPayload(payload(virtual), f.ctx);
  assert.equal(request.input[0].encrypted_content, "system-C2");

  const reloaded = f.create();
  const visible = f.messages().filter(message => message.role !== "system");
  const reused = await reloaded.context(visible, f.ctx);
  assert.deepEqual(reused.map(message => message.role), ["compactionSummary", "user"]);
  assert.equal(JSON.stringify(reused).includes("Pi-owned compaction system message"), false);
  assert.equal(calls, 1);
});

test("systemMessage normalization still rejects genuinely changed visible context", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return { ...details, encryptedContent: "must-not-run" }; });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  const visible = f.messages().filter(message => message.role !== "system");
  visible.push({ role: "user", content: "unapproved visible edit", timestamp: 5 });
  assert.equal(await c.context(visible, f.ctx), undefined);
  assert.equal(f.record().status, "FALLBACK");
  assert.equal(calls, 0);
});

for (const path of ["context", "requestPayload"]) {
  for (const change of ["invalidate", "branch", "session", "model", "checkpoint", "transition"]) {
    test(`${path}: deferred auth cannot resurrect activation after ${change}`, async () => {
      let calls = 0;
      const f = fixture(async () => { calls++; return { ...details, encryptedContent: "C2" }; });
      const c = f.create();
      await c.select({ previousModel: A, model: B }, f.ctx);
      const virtual = await c.context(f.messages(), f.ctx);
      const entered = deferred(), auth = deferred();
      f.ctx.modelRegistry.getApiKeyAndHeaders = () => {
        entered.resolve();
        return auth.promise;
      };
      const operation = path === "context"
        ? c.context(f.messages(), f.ctx)
        : c.requestPayload(payload(virtual), f.ctx);
      await entered.promise;
      if (change === "invalidate") c.invalidate(); // same branch: generation alone must suffice
      if (change === "branch") {
        c.invalidate();
        f.entries.splice(0, f.entries.length, { ...f.root, id: "unrelated-root" }, user("new-user"));
      }
      if (change === "session") f.ctx.sessionManager.getSessionId = () => "replacement-session";
      if (change === "model") f.ctx.model = A;
      if (change === "checkpoint") f.entries.push({ ...f.root, id: "superseding-root" });
      if (change === "transition") f.entries.push({
        type: "custom", id: "replacement-transition", customType: TRANSITION_ENTRY,
        data: { ...f.record(), details: { ...f.record().details, encryptedContent: "new-checkpoint" } },
      });
      auth.resolve({ ok: true, apiKey: token("account") });
      assert.equal(await operation, undefined);
      assert.equal(await c.requestPayload(payload(virtual), f.ctx), undefined);
      assert.equal(calls, 1, "stale completion must not initiate another transition");
    });
  }
}
test("failure is terminal, leaves original text intact and never retries or replays", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; throw new Error("transport"); });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  const original = f.messages();
  assert.equal(await c.context(original, f.ctx), undefined);
  assert.equal(f.record().status, "FALLBACK");
  for (let i = 0; i < 3; i++) {
    f.entries.push(assistant(`failed-${i}`), result(`failed-${i}`));
    assert.equal(await c.context(f.messages(), f.ctx), undefined);
    assert.equal(await c.requestPayload(payload(original), f.ctx), undefined);
  }
  assert.equal(calls, 1);
  assert.equal(await f.create().context(f.messages(), f.ctx), undefined);
});
test("select cannot persist PENDING after session replacement during auth", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return details; });
  const c = f.create(), entered = deferred(), auth = deferred();
  f.ctx.modelRegistry.getApiKeyAndHeaders = () => { entered.resolve(); return auth.promise; };
  const selecting = c.select({ previousModel: A, model: B }, f.ctx);
  await entered.promise;
  f.ctx.sessionManager.getSessionId = () => "replacement-session";
  auth.resolve({ ok: true, apiKey: token("account") });
  await selecting;
  assert.equal(f.record(), undefined);
  assert.equal(c.pending, undefined);
  assert.equal(calls, 0);
});
test("run cannot persist TRANSITIONED after session replacement during final auth", async () => {
  let calls = 0;
  const entered = deferred(), auth = deferred();
  const f = fixture(async () => {
    calls++;
    f.ctx.modelRegistry.getApiKeyAndHeaders = () => { entered.resolve(); return auth.promise; };
    return { ...details, encryptedContent: "C2" };
  });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  const running = c.context(f.messages(), f.ctx);
  await entered.promise;
  f.ctx.sessionManager.getSessionId = () => "replacement-session";
  auth.resolve({ ok: true, apiKey: token("account") });
  assert.equal(await running, undefined);
  assert.notEqual(f.record()?.status, "TRANSITIONED");
  assert.equal(c.request, undefined);
  assert.equal(calls, 1);
});
for (const dimension of ["account", "auth", "endpoint"]) {
  test(`${dimension} isolation forbids transition`, async () => {
    let calls = 0;
    const f = fixture(async () => { calls++; return details; });
    if (dimension === "account") f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token("other") });
    if (dimension === "auth") f.ctx.modelRegistry.isUsingOAuth = () => false;
    if (dimension === "endpoint") f.ctx.model = { ...B, baseUrl: "https://example.com" };
    const c = f.create();
    await c.select({ previousModel: A, model: f.ctx.model }, f.ctx);
    await c.context(f.messages(), f.ctx);
    assert.equal(f.record().status, "FALLBACK");
    assert.equal(calls, 0);
  });
}
for (const race of ["branch", "selection", "superseded", "cancel"]) {
  test(`${race} race invalidates an in-flight result`, async () => {
    let finish, calls = 0;
    const f = fixture(async () => { calls++; return new Promise(resolve => { finish = resolve; }); });
    const c = f.create();
    await c.select({ previousModel: A, model: B }, f.ctx);
    const running = c.context(f.messages(), f.ctx);
    while (!finish) await new Promise(resolve => setImmediate(resolve));
    if (race === "branch") { c.invalidate(); f.entries.push(user("other-branch")); }
    if (race === "selection") {
      f.ctx.model = A;
      await c.select({ previousModel: B, model: A }, f.ctx);
    }
    if (race === "superseded") f.entries.push({ ...f.root, id: "new-root" });
    if (race === "cancel") f.ctx.signal = AbortSignal.abort();
    // Abort the original captured signal too.
    if (race === "cancel") c.invalidate();
    finish({ ...details, encryptedContent: "stale" });
    await running;
    assert.notEqual(f.record()?.status, "TRANSITIONED");
    assert.equal(calls, 1);
  });
}
test("restart with unfinished state is terminal fallback, not retry", async () => {
  const f = fixture(async () => { throw new Error("must not run"); });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  f.entries.push({ type: "custom", id: "interrupted", customType: TRANSITION_ENTRY,
    data: { ...f.record(), status: "TRANSITIONING" } });
  assert.equal(await f.create().context(f.messages(), f.ctx), undefined);
  assert.equal(f.record().status, "FALLBACK");
});
test("empty post-checkpoint tail preserves incoming user once", async () => {
  let calls = 0;
  const f = fixture(async (_ctx, _model, previous, messages) => {
    calls++;
    assert.deepEqual(messages, []);
    return { ...previous, encryptedContent: "empty-tail-C2" };
  });
  f.entries.splice(1, 3);
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  const messages = await c.context(f.messages(), f.ctx);
  assert.equal(messages.length, 2);
  assert.equal(f.record().boundary, "root");
  assert.equal((await c.requestPayload(payload(messages), f.ctx)).input[0].encrypted_content, "empty-tail-C2");
  assert.equal(calls, 1);
});
test("broken tool pairs and context edits choose text without transport", async () => {
  for (const changed of ["pair", "context"]) {
    let calls = 0;
    const f = fixture(async () => { calls++; return details; });
    if (changed === "pair") f.entries.splice(3, 1);
    const c = f.create();
    await c.select({ previousModel: A, model: B }, f.ctx);
    const messages = f.messages();
    if (changed === "context") messages.push({ role: "user", content: "extension addition", timestamp: 5 });
    assert.equal(await c.context(messages, f.ctx), undefined);
    assert.equal(f.record().status, "FALLBACK");
    assert.equal(calls, 0);
  }
});
test("navigation while pending is terminal fallback without an attempt", async () => {
  let calls = 0;
  const f = fixture(async () => { calls++; return details; });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  c.invalidate();
  await c.context(f.messages(), f.ctx);
  assert.equal(f.record().status, "FALLBACK");
  assert.equal(calls, 0);
});
test("target credentials change during compaction prevents rebinding", async () => {
  let calls = 0;
  const f = fixture(async () => {
    calls++;
    f.ctx.modelRegistry.getApiKeyAndHeaders = async () => ({ ok: true, apiKey: token("other") });
    return { ...details, encryptedContent: "unsafe" };
  });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  assert.equal(await c.context(f.messages(), f.ctx), undefined);
  assert.equal(f.record().status, "FALLBACK");
  assert.equal(calls, 1);
});
test("terminal persistence failure selects fallback and cannot resend or retry", async () => {
  let calls = 0, records = 0;
  const f = fixture(async () => ({ ...details, encryptedContent: "C2" }));
  const c = new TransitionCoordinator(
    (customType, data) => {
      if (data.status === "TRANSITIONED") throw new Error("write failed");
      f.entries.push({ type: "custom", id: `persist-${records++}`, customType, data });
    },
    () => [], () => "off", body => body,
    async () => { calls++; return { ...details, encryptedContent: "C2" }; },
  );
  await c.select({ previousModel: A, model: B }, f.ctx);
  assert.equal(await c.context(f.messages(), f.ctx), undefined);
  assert.equal(f.record().status, "FALLBACK");
  assert.equal(await c.context(f.messages(), f.ctx), undefined);
  assert.equal(calls, 1);
});
test("final request compatibility changes never inject opaque transitioned state", async () => {
  const f = fixture(async () => ({ ...details, encryptedContent: "C2" }));
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  const messages = await c.context(f.messages(), f.ctx);
  f.ctx.modelRegistry.isUsingOAuth = () => false;
  assert.equal(await c.requestPayload(payload(messages), f.ctx), undefined);
  // Virtual context has its own bounded readable fallback even if final auth
  // differs from the context-stage snapshot.
  assert.match(messages[0].summary, /readable/);
  assert.match(messages[0].summary, /old/);
});
test("failed checkpoint transition does not blacklist a newer checkpoint", async () => {
  let calls = 0;
  const f = fixture(async (_ctx, _source, previous) => {
    if (++calls === 1) throw new Error("first fails");
    return { ...previous, encryptedContent: "fresh-success" };
  });
  const c = f.create();
  await c.select({ previousModel: A, model: B }, f.ctx);
  await c.context(f.messages(), f.ctx);
  f.ctx.model = A;
  f.entries.push({ ...f.root, id: "new-checkpoint" });
  f.entries.push(user("next"));
  f.ctx.sessionManager.buildContextEntries = () => f.entries.slice(
    f.entries.findIndex(e => e.id === "new-checkpoint"),
  );
  f.ctx.model = B;
  await c.select({ previousModel: A, model: B }, f.ctx);
  await c.context(f.messages(), f.ctx);
  assert.equal(calls, 2);
  assert.equal(f.record().status, "TRANSITIONED");
});
test("real transition transport sends source checkpoint + paired tail to A, unchanged opaque result", async t => {
  const f = fixture();
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    calls++;
    const body = JSON.parse(init.body);
    assert.equal(body.model, A.id);
    assert.deepEqual(body.input[0], { type: "compaction", encrypted_content: "C1" });
    assert.equal(body.input.at(-1).type, "compaction_trigger");
    const call = body.input.find(i => i.type === "function_call");
    const output = body.input.find(i => i.type === "function_call_output");
    assert.equal(call.call_id, output.call_id);
    assert.equal(JSON.stringify(body).includes("incoming"), false);
    return new Response([
      'data: {"type":"response.output_item.done","item":{"type":"compaction","encrypted_content":"unchanged-C2"}}',
      'data: {"type":"response.completed","response":{"status":"completed"}}', "",
    ].join("\n\n"), { headers: { "content-type": "text/event-stream" } });
  });
  const produced = await createTransitionCheckpoint(
    f.ctx, A, details, f.messages().slice(1, -1), () => [], "off",
  );
  assert.equal(produced.encryptedContent, "unchanged-C2");
  assert.equal(calls, 1);
});
