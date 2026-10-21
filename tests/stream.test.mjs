import test from "node:test";
import assert from "node:assert/strict";
import { readChatStream } from "../src/stream.mjs";

const encoder = new TextEncoder();
const delta = (content) =>
  JSON.stringify({ choices: [{ delta: { content } }] });
const event = (content) => `data: ${delta(content)}\n\n`;

test('Agent-only completion may be empty only on the explicitly enabled Agent channel',async()=>{
  const frame='event: agent\ndata: {"type":"run.finished","status":"completed"}\n\n';
  const received=[];
  assert.equal(await readChatStream(streamed([frame]),()=>{},()=>{},(value)=>received.push(value)),'');
  assert.equal(received[0].status,'completed');
  await assert.rejects(readChatStream(streamed([frame]),()=>{}),/no assistant content/);
});

test('Agent cancelled terminal state is delivered before the read rejects as AbortError',async()=>{
  const received=[];
  await assert.rejects(readChatStream(streamed(['event: agent\ndata: {"type":"run.finished","status":"cancelled"}\n\n']),()=>{},()=>{},(value)=>received.push(value)),{name:'AbortError'});
  assert.equal(received[0].status,'cancelled');
});

function streamed(chunks, extra = {}) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(
            typeof chunk === "string" ? encoder.encode(chunk) : chunk,
          );
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" }, ...extra },
  );
}

test("decodes UTF-8 characters split at every byte and emits only content strings", async () => {
  const bytes = encoder.encode(
    event("中文 🌱") + event("分支") + "data: [DONE]\n\n",
  );
  const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
  const received = [];
  assert.equal(
    await readChatStream(streamed(chunks), (text) => received.push(text)),
    "中文 🌱分支",
  );
  assert.deepEqual(received, ["中文 🌱", "分支"]);
});

test("handles CRLF across chunk boundaries, comments, empty deltas and multiple events", async () => {
  const text =
    ': keepalive\r\ndata: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\n' +
    `data: ${delta("first")}\r\n\r\ndata: ${delta(" second")}\r\n\r\ndata: [DONE]\r\n\r\n`;
  const received = [];
  const chunks = text.split("").map((character) => encoder.encode(character));
  assert.equal(
    await readChatStream(streamed(chunks), (value) => received.push(value)),
    "first second",
  );
  assert.deepEqual(received, ["first", " second"]);
});

test("supports multiple data fields in a single SSE event and flushes final unterminated event", async () => {
  const received = [];
  const response = streamed([
    'data: {"choices":\ndata: [{"delta":{"content":"hello"}}]}\n\n',
    `data: ${delta("!")}`,
  ]);
  assert.equal(
    await readChatStream(response, (value) => received.push(value)),
    "hello!",
  );
  assert.deepEqual(received, ["hello", "!"]);
});

test("stops at DONE and excludes later events", async () => {
  const received = [];
  assert.equal(
    await readChatStream(
      streamed([event("kept") + "data: [DONE]\n\n" + event("ignored")]),
      (value) => received.push(value),
    ),
    "kept",
  );
  assert.deepEqual(received, ["kept"]);
});

test("throws upstream event errors even after partial content", async () => {
  const received = [];
  await assert.rejects(
    readChatStream(
      streamed([
        event("partial") +
          'event: error\ndata: {"message":"Provider overloaded"}\n\n',
      ]),
      (value) => received.push(value),
    ),
    /Provider overloaded/,
  );
  assert.deepEqual(received, ["partial"]);
});

test("throws data-only JSON provider errors", async () => {
  await assert.rejects(
    readChatStream(
      streamed(['data: {"error":{"message":"Invalid API key"}}\n\n']),
      () => {},
    ),
    /Invalid API key/,
  );
});

test("throws non-ok HTTP JSON errors with the provider message", async () => {
  const response = new Response(
    JSON.stringify({ error: { message: "Quota exceeded" } }),
    { status: 429 },
  );
  await assert.rejects(
    readChatStream(response, () => assert.fail("No content should be emitted")),
    /Quota exceeded/,
  );
});

test("supports non-streaming JSON gateways", async () => {
  const received = [];
  const response = new Response(
    JSON.stringify({
      choices: [
        { message: { content: "完整回答", reasoning_content: "private" } },
      ],
    }),
    {
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
  assert.equal(
    await readChatStream(response, (value) => received.push(value)),
    "完整回答",
  );
  assert.deepEqual(received, ["完整回答"]);
});

test("ignores reasoning_content and non-string content values", async () => {
  const received = [];
  const chunks = [
    'data: {"choices":[{"delta":{"reasoning_content":"private thoughts","content":null}}]}\n\n',
    'data: {"choices":[{"delta":{"content":["not text"]}}]}\n\n',
    event("visible"),
  ];
  assert.equal(
    await readChatStream(streamed(chunks), (value) => received.push(value)),
    "visible",
  );
  assert.deepEqual(received, ["visible"]);
});

test("rejects an empty, whitespace-only or reasoning-only response", async () => {
  for (const text of [
    "",
    "data: [DONE]\n\n",
    event("  "),
    'data: {"choices":[{"delta":{"reasoning_content":"private"}}]}\n\n',
  ]) {
    await assert.rejects(
      readChatStream(streamed([text]), () => {}),
      /no assistant content/,
    );
  }
  await assert.rejects(
    readChatStream(
      new Response('{"choices":[]}', {
        headers: { "content-type": "application/json" },
      }),
      () => {},
    ),
    /no assistant content/,
  );
});

test("propagates stream aborts with their original identity", async () => {
  const abort = new DOMException("Cancelled by user", "AbortError");
  let reads = 0;
  const received = [];
  const response = new Response(
    new ReadableStream({
      pull(controller) {
        if (reads++ === 0) controller.enqueue(encoder.encode(event("partial")));
        else controller.error(abort);
      },
    }),
  );
  await assert.rejects(
    readChatStream(response, (value) => received.push(value)),
    (error) => error === abort,
  );
  assert.deepEqual(received, ["partial"]);
});

test("rejects malformed SSE JSON rather than silently losing the response", async () => {
  await assert.rejects(
    readChatStream(streamed(["data: {broken json}\n\n"]), () => {}),
    /Invalid JSON/,
  );
});

test("cancels an open upstream after a callback throws and preserves the original error", async () => {
  const callbackError = new Error("Rendering failed");
  const cleanupError = new Error("Cancellation failed");
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(event("first")));
      },
      async cancel() {
        await Promise.resolve();
        cancelled = true;
        throw cleanupError;
      },
    }),
  );
  await assert.rejects(
    readChatStream(response, () => {
      throw callbackError;
    }),
    (error) => error === callbackError,
  );
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("cancels an open upstream after malformed SSE without masking its parse error", async () => {
  let cancelled = false;
  const response = new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode("data: {broken json}\n\n"));
      },
      async cancel() {
        await Promise.resolve();
        cancelled = true;
        throw new Error("Cancellation failed");
      },
    }),
  );
  await assert.rejects(
    readChatStream(response, () => assert.fail("No content should be emitted")),
    /Invalid JSON in the provider event stream/,
  );
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test("nonstreaming JSON forwards normalized reported usage to the third callback", async () => {
  const seen = [], accounting = [];
  const payload = { choices: [{ message: { content: "完整回答" } }],
    usage: { inputTokens: 4096, outputTokens: 128, cachedInputTokens: 3072, provider_private: "hidden" } };
  assert.equal(await readChatStream(Response.json(payload), (text) => seen.push(text), (usage) => accounting.push(usage)), "完整回答");
  assert.deepEqual(seen, ["完整回答"]);
  assert.deepEqual(accounting, [{ inputTokens: 4096, outputTokens: 128, cachedInputTokens: 3072 }]);
});

test("SSE choices-empty final usage survives split UTF-8 and does not append metadata to visible text", async () => {
  const usage = { prompt_tokens: 2400, completion_tokens: 180, prompt_tokens_details: { cached_tokens: 2048 } };
  const wire = event("中文回答") + `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`;
  const bytes = encoder.encode(wire);
  const seen = [], accounting = [];
  assert.equal(await readChatStream(streamed([...bytes].map((byte) => Uint8Array.of(byte))),
    (text) => seen.push(text), (tokens) => accounting.push(tokens)), "中文回答");
  assert.deepEqual(seen, ["中文回答"]);
  assert.deepEqual(accounting, [{ inputTokens: 2400, outputTokens: 180, cachedInputTokens: 2048 }]);
});

test("usage callbacks distinguish an unknown cache count from a reported zero, and missing or malformed usage is ignored", async () => {
  for (const [usage, expected] of [
    [{ prompt_tokens: 1200, completion_tokens: 80 }, [{ inputTokens: 1200, outputTokens: 80, cachedInputTokens: null }]],
    [{ prompt_tokens: 1200, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 0 } }, [{ inputTokens: 1200, outputTokens: 80, cachedInputTokens: 0 }]],
    [undefined, []], [null, []], [{ prompt_tokens: "1200", completion_tokens: 80 }, []],
  ]) {
    for (const response of [Response.json({ choices: [{ message: { content: "answer" } }], usage }),
      streamed([event("answer"), `data: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`])]) {
      const accounting = [];
      assert.equal(await readChatStream(response, () => {}, (tokens) => accounting.push(tokens)), "answer");
      assert.deepEqual(accounting, expected);
    }
  }
});

test("aborting before the final usage chunk preserves the abort identity, skips unknown totals and releases the reader", async () => {
  const abort = new DOMException("Stream interrupted before usage", "AbortError");
  const seen = [], accounting = [];
  let read = 0;
  const response = new Response(new ReadableStream({ pull(controller) {
    if (read++ === 0) controller.enqueue(encoder.encode(event("partial answer")));
    else controller.error(abort);
  } }));
  await assert.rejects(() => readChatStream(response, (text) => seen.push(text), (usage) => accounting.push(usage)), (error) => error === abort);
  assert.deepEqual(seen, ["partial answer"]);
  assert.deepEqual(accounting, []);
  assert.equal(response.body.locked, false);
});

test("a usage callback failure cancels an open stream, keeps the callback error and releases the reader", async () => {
  const callbackError = new Error("Usage display failed");
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(event("answer") + 'data: {"choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20}}\n\n')); },
    cancel() { cancelled = true; throw new Error("Cancellation must not mask the callback error"); },
  }));
  await assert.rejects(() => readChatStream(response, () => {}, () => { throw callbackError; }), (error) => error === callbackError);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});
