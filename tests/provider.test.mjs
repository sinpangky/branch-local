import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { normalizeUsage } from "../shared/provider.mjs";
import { createLocalService } from "../server/service.mjs";

test("usage normalizes reported chat totals and distinguishes an unknown cache count from an explicit zero", () => {
  const usage = { prompt_tokens: 1200, completion_tokens: 200, total_tokens: 1400, prompt_tokens_details: { cached_tokens: 1024 } };
  const expected = { inputTokens: 1200, outputTokens: 200, cachedInputTokens: 1024 };
  assert.deepEqual(normalizeUsage(usage), expected);
  assert.deepEqual(normalizeUsage({ choices: [], usage }), expected);
  assert.deepEqual(normalizeUsage({ prompt_tokens: 1200, completion_tokens: 200 }), { ...expected, cachedInputTokens: null });
  assert.deepEqual(normalizeUsage({ ...usage, prompt_tokens_details: { cached_tokens: 0 } }), { ...expected, cachedInputTokens: 0 });
  assert.deepEqual(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } }),
    { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
});

test("Responses-shaped and already normalized accounting retains only known token fields", () => {
  const normalized = { inputTokens: 2200, outputTokens: 60, cachedInputTokens: 1600 };
  assert.deepEqual(normalizeUsage({ input_tokens: 2200, output_tokens: 60, input_tokens_details: { cached_tokens: 1600 } }), normalized);
  assert.deepEqual(normalizeUsage(normalized), normalized);
  assert.deepEqual(normalizeUsage({ usage: { ...normalized, apiKey: "secret", provider_private: { account: "private" } } }), normalized);
  assert.notEqual(normalizeUsage(normalized), normalized, "normalization returns an independent allowlisted object");
  assert.deepEqual(normalizeUsage({ ...normalized, cachedInputTokens: null }), { ...normalized, cachedInputTokens: null });
});

test("missing and malformed accounting is not replaced with invented token or cache estimates", () => {
  for (const value of [null, undefined, [], "usage", {}, { usage: null }, { total_tokens: 1500 },
    { prompt_tokens: 1500 }, { completion_tokens: 20 }, { prompt_eval_count: 1000, eval_count: 20 },
    { prompt_tokens: "1500", completion_tokens: 20 }, { prompt_tokens: 1500, completion_tokens: -1 },
    { input_tokens: 1500, output_tokens: 1.5 }, { inputTokens: Infinity, outputTokens: 20 },
    { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 20 }, { inputTokens: NaN, outputTokens: 20 }])
    assert.equal(normalizeUsage(value), null);
  for (const cached_tokens of [-1, 1501, "1000", Infinity, 1.5, null, undefined])
    assert.deepEqual(normalizeUsage({ prompt_tokens: 1500, completion_tokens: 20, prompt_tokens_details: { cached_tokens } }),
      { inputTokens: 1500, outputTokens: 20, cachedInputTokens: null });
  assert.equal(normalizeUsage(Object.create({ prompt_tokens: 1500, completion_tokens: 20 })), null);
  let readAccessor = false;
  const accessor = Object.defineProperty({ completion_tokens: 20 }, "prompt_tokens", {
    get() { readAccessor = true; throw new Error("must not execute upstream accessors"); },
  });
  assert.equal(normalizeUsage(accessor), null);
  assert.equal(readAccessor, false);
});

async function fixture(t, fetchImpl) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "branch-provider-usage-"));
  const service = await createLocalService({ dataDir, fetchImpl });
  t.after(async () => { await service.close(); await rm(dataDir, { recursive: true, force: true }); });
  return service;
}

const chat = (service, messages) => service.handle(new Request("branch-local://app/api/chat", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messages }),
}));

test("nonstreaming JSON preserves validated usage without returning private provider fields or injecting request options", async (t) => {
  const messages = [{ role: "system", content: "stable root context" }, { role: "user", content: "branch suffix" }];
  let body;
  const service = await fixture(t, async (_url, options) => {
    body = JSON.parse(options.body);
    return Response.json({ choices: [{ message: { content: "answer", reasoning_content: "private reasoning" } }],
      usage: { prompt_tokens: 4200, completion_tokens: 256, prompt_tokens_details: { cached_tokens: 3000 }, private_key: "do-not-leak" },
      provider_account: "do-not-leak" });
  });
  const response = await chat(service, messages);
  assert.deepEqual(await response.json(), {
    choices: [{ message: { role: "assistant", content: "answer" } }],
    usage: { inputTokens: 4200, outputTokens: 256, cachedInputTokens: 3000 },
  });
  assert.deepEqual(body.messages, messages, "the complete history is still required by stateless chat APIs");
  assert.equal(Object.hasOwn(body, "stream_options"), false, "unsupported gateways must not receive an unsolicited usage option");
  for (const key of ["session", "conversation", "previous_response_id", "cache_prompt", "prompt_cache_key"])
    assert.equal(Object.hasOwn(body, key), false, `must not invent provider session/cache support: ${key}`);
});

test("JSON answers with no usable usage remain compatible, while missing cache details stay unknown", async (t) => {
  let usage;
  const service = await fixture(t, async () => Response.json({ choices: [{ message: { content: "valid" } }], usage }));
  for (const invalid of [undefined, null, { prompt_tokens: "1000", completion_tokens: 20 }]) {
    usage = invalid;
    const response = await chat(service, [{ role: "user", content: "hi" }]);
    assert.deepEqual(await response.json(), { choices: [{ message: { role: "assistant", content: "valid" } }] });
  }
  usage = { prompt_tokens: 1000, completion_tokens: 20 };
  assert.deepEqual((await (await chat(service, [{ role: "user", content: "hi" }])).json()).usage,
    { inputTokens: 1000, outputTokens: 20, cachedInputTokens: null });
});

test("SSE forwards the provider's optional final usage event unchanged and never manufactures a usage block", async (t) => {
  const content = 'data: {"choices":[{"delta":{"content":"hello"}}],"usage":null}\n\n';
  const accounting = 'data: {"choices":[],"usage":{"prompt_tokens":2000,"completion_tokens":10,"prompt_tokens_details":{"cached_tokens":1536}}}\n\n';
  let stream = content + accounting + "data: [DONE]\n\n";
  let sent;
  const service = await fixture(t, async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
  });
  assert.equal(await (await chat(service, [{ role: "user", content: "hi" }])).text(), stream);
  assert.equal(Object.hasOwn(sent, "stream_options"), false);
  stream = content + "data: [DONE]\n\n";
  assert.equal(await (await chat(service, [{ role: "user", content: "hi" }])).text(), stream);
});
