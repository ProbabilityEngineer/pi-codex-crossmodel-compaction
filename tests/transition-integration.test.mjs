import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "typebox";
import compaction from "../extensions/index.ts";
import { codexHarness, compactionResponse, requestBody, textResponse } from "./support/codex-harness.mjs";
import { latestTransition } from "../src/transition-state.ts";

process.env.CI = "1";
process.env.PI_OFFLINE = "1";

function toolResponse(id) {
  const item = { type: "function_call", id: `fc_${id}`, call_id: id,
    name: "fixture_tool", arguments: "{}", status: "completed" };
  return new Response([
    { type: "response.output_item.added", item: { ...item, arguments: "" } },
    { type: "response.function_call_arguments.delta", delta: "{}" },
    { type: "response.output_item.done", item },
    { type: "response.completed", response: { status: "completed", output: [item],
      usage: { input_tokens: 10, output_tokens: 1, total_tokens: 11 } } },
  ].map(e => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
test("real Pi A→B→two tools→continuation→A: one transition per explicit selection", async t => {
  const requests = [];
  let tools = 0, transitioning = false;
  t.mock.method(globalThis, "fetch", async (_url, init) => {
    const body = requestBody(init);
    requests.push(body);
    if (body.input.at(-1)?.type === "compaction_trigger") return compactionResponse();
    if (transitioning && tools < 2) return toolResponse(`cycle-${++tools}`);
    return textResponse();
  });
  const h = await codexHarness([compaction, pi => pi.registerTool({
    name: "fixture_tool", label: "fixture", description: "test tool",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: "tool result" }], details: {} }),
  })]);
  try {
    await h.session.prompt("old history");
    await h.session.prompt("more history");
    await h.session.compact();
    const ordinary = requests.filter(r => r.input.at(-1)?.type === "compaction_trigger").length;
    const B = { ...h.model, id: "generic-target" };
    await h.session.setModel(B);
    transitioning = true;
    await h.session.prompt("incoming boundary");
    const native = requests.filter(r => r.input.at(-1)?.type === "compaction_trigger");
    assert.equal(native.length, ordinary + 1);
    assert.equal(native.at(-1).model, h.model.id);
    assert.equal(native.at(-1).input[0].type, "compaction");
    assert.equal(JSON.stringify(native.at(-1).input).includes("incoming boundary"), false);
    const target = requests.filter(r => r.model === B.id);
    assert.equal(target.length, 3);
    for (const body of target) {
      assert.equal(body.input[0].type, "compaction");
      assert.equal(body.input.filter(i => i.role === "user" &&
        JSON.stringify(i).includes("incoming boundary")).length, 1);
    }
    assert.equal(tools, 2);
    assert.equal(latestTransition(h.sessionManager.getBranch(), h.sessionManager.getSessionId()).status, "TRANSITIONED");
    // Recreate the extension/coordinator from persisted custom session entries.
    await h.session.reload();
    await h.session.prompt("continue after reload");
    assert.equal(requests.at(-1).input[0].type, "compaction");
    assert.equal(requests.filter(r => r.input.at(-1)?.type === "compaction_trigger").length, ordinary + 1);
    await h.session.setModel(h.model);
    await h.session.prompt("return to source");
    const allNative = requests.filter(r => r.input.at(-1)?.type === "compaction_trigger");
    assert.equal(allNative.length, ordinary + 2);
    assert.equal(allNative.at(-1).model, B.id);
    await h.session.setModel(B);
    await h.session.prompt("switch again");
    assert.equal(requests.filter(r => r.input.at(-1)?.type === "compaction_trigger").length, ordinary + 3);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
