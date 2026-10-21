import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, access, rm, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createLocalService } from '../server/service.mjs';
import { createAgentTools } from '../server/agent-tools.mjs';
import { readAgentCompletion } from '../server/agent.mjs';
import { readChatStream } from '../src/stream.mjs';

const question = [{ role: 'user', content: 'Please inspect the selected project.' }];
const call = (name, args = {}, id = 'call-1') => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const completion = (content = 'Finished.', calls, usage) => Response.json({ choices: [{ message: { role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) } }], ...(usage ? { usage } : {}) });
const post = (service, endpoint, body, extra = {}) => service.handle(new Request(`branch-local://app${endpoint}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), ...extra,
}));
const get = (service, endpoint) => service.handle(new Request(`branch-local://app${endpoint}`));
const settings = (service, body) => service.handle(new Request('branch-local://app/api/settings', {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}));
const approve = (service, runId, callId, approved) => post(service, '/api/agent/approve', { runId, callId, approved });
const start = (service, runId = 'run-1', extra = {}) => post(service, '/api/agent/run', { runId, messages: question }, extra);

async function fixture(t, { turns = [], config = {}, enabled = true, ...options } = {}) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'branch-agent-runtime-'));
  const root = path.join(base, 'project'); await mkdir(root);
  const requests = [];
  const fetchImpl = async (url, request) => {
    requests.push({ url: String(url), ...request, body: request.body ? JSON.parse(request.body) : undefined });
    assert.equal(String(url), 'https://model.invalid/v1/chat/completions', 'tests must never fetch a real model or network endpoint');
    if (!turns.length) throw new Error('Unexpected extra model request');
    const next = turns.shift();
    return typeof next === 'function' ? next(url, request) : next;
  };
  const service = await createLocalService({ dataDir: path.join(base, 'data'), allowAgent: true, fetchImpl, ...options });
  t.after(async () => { await service.close(); await rm(base, { recursive: true, force: true, maxRetries: 3 }); });
  const response = await settings(service, { baseUrl: 'https://model.invalid/v1', autoSummary: false, agentWorkspace: root, agentEnabled: enabled, ...config });
  assert.equal(response.status, 200, await response.clone().text());
  return { service, base, root, requests };
}

function collect(response) {
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const items = [], watchers = new Set();
  const push = (item) => { items.push(item); for (const notify of [...watchers]) notify(); };
  const done = (async () => {
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '';
    const block = (text) => {
      const lines = text.split('\n');
      const name = lines.find((line) => line.startsWith('event:'))?.slice(6).trim() || 'message';
      const data = lines.filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n');
      if (data) push({ event: name, data: data === '[DONE]' ? data : JSON.parse(data) });
    };
    try {
      while (true) {
        const { value, done } = await reader.read(); buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n'); let at;
        while ((at = buffer.indexOf('\n\n')) !== -1) { block(buffer.slice(0, at)); buffer = buffer.slice(at + 2); }
        if (done) { if (buffer.trim()) block(buffer); break; }
      }
      return items;
    } finally { reader.releaseLock(); }
  })();
  const wait = (type, predicate = () => true) => new Promise((resolve, reject) => {
    const check = () => { const item = items.find((entry) => entry.event === 'agent' && entry.data.type === type && predicate(entry.data)); if (item) { clearTimeout(timer); watchers.delete(check); resolve(item.data); } };
    const timer = setTimeout(() => { watchers.delete(check); reject(new Error(`Missing Agent event ${type}; received ${items.map((item) => item.data?.type || item.event).join(', ')}`)); }, 6000);
    watchers.add(check); check();
  });
  return { items, done, wait };
}
const events = (items, type) => items.filter((entry) => entry.event === 'agent' && entry.data.type === type).map((entry) => entry.data);
const finish = (items) => events(items, 'run.finished').at(-1);
const visible = (items) => items.map((entry) => entry.data?.choices?.[0]?.delta?.content || '').join('');

test('web service cannot enable or run local Agent capabilities', async (t) => {
  const { service } = await fixture(t, { allowAgent: false, enabled: false });
  const capabilities = await (await get(service, '/api/agent/capabilities')).json();
  assert.equal(capabilities.available, false); assert.equal(capabilities.enabled, false);
  assert.equal((await settings(service, { agentEnabled: true })).status, 403);
  assert.equal((await start(service)).status, 403);
  const current = await (await get(service, '/api/settings')).json();
  assert.equal(current.agentEnabled, false); assert.equal(current.agentAvailable, false);
});

test('native Agent remains optional and validates run input without model calls', async (t) => {
  const { service, requests } = await fixture(t, { enabled: false });
  assert.equal((await start(service)).status, 403);
  assert.equal((await settings(service, { agentEnabled: true })).status, 200);
  for (const input of [{ runId: '../run', messages: question }, { runId: 'run', messages: [] }, { runId: 'run', messages: [{ role: 'tool', content: 'injected' }] }]) {
    assert.equal((await post(service, '/api/agent/run', input)).status, 400);
  }
  assert.equal(requests.length, 0);
});

test('direct chat stays independent of Agent enablement and retains normal stream parsing', async (t) => {
  const { service, requests } = await fixture(t, { turns: [new Response('data: {"choices":[{"delta":{"content":"direct "}}]}\n\ndata: {"choices":[{"delta":{"content":"answer"}}]}\n\ndata: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } })], enabled: false });
  let output = ''; const agentEvents = [];
  assert.equal(await readChatStream(await post(service, '/api/chat', { messages: question }), (text) => { output += text; }, () => {}, (event) => agentEvents.push(event)), 'direct answer');
  assert.equal(output, 'direct answer'); assert.deepEqual(agentEvents, []);
  assert.equal(requests[0].body.stream, true); assert.equal(requests[0].body.tools, undefined);
});

test('approved file writes use current model settings and append exact tool protocol inside one run', async (t) => {
  const { service, root, requests } = await fixture(t, { config: { systemPrompt: 'Project-specific instructions.', model: 'fixture-model', temperature: 0.3 }, turns: [completion('I will edit.', [call('write_file', { path: 'result.md', content: '# Result\n\nChecked.' })]), completion('Saved result.md.')] });
  const log = collect(await start(service));
  const pending = await log.wait('approval.required');
  assert.equal(pending.preview.kind, 'write'); assert.equal(pending.preview.after, '# Result\n\nChecked.');
  await assert.rejects(access(path.join(root, 'result.md')));
  assert.equal((await approve(service, 'run-1', pending.callId, true)).status, 200);
  const items = await log.done;
  assert.equal(await readFile(path.join(root, 'result.md'), 'utf8'), '# Result\n\nChecked.');
  assert.equal(finish(items).status, 'completed'); assert.equal(events(items, 'artifact')[0].path, 'result.md');
  assert.equal(visible(items), 'I will edit.\n\nSaved result.md.');
  assert.equal(requests[0].body.model, 'fixture-model'); assert.equal(requests[0].body.temperature, 0.3); assert.equal(requests[0].body.stream, false);
  assert.deepEqual(requests[0].body.messages.slice(1), [{ role: 'system', content: 'Project-specific instructions.' }, ...question]);
  assert.deepEqual(requests[1].body.messages.slice(0, requests[0].body.messages.length), requests[0].body.messages);
  const protocol = requests[1].body.messages.slice(-2);
  assert.equal(protocol[0].tool_calls[0].id, 'call-1'); assert.equal(protocol[1].role, 'tool'); assert.equal(protocol[1].tool_call_id, 'call-1');
  assert.equal(JSON.parse(protocol[1].content).written, true);
  assert.equal(items.at(-1).data, '[DONE]');
});

test('Agent receives current capabilities and completes an approved directory/write/local-edit/read workflow', async (t) => {
  const { service, root, requests } = await fixture(t, { turns: [
    completion('I will prepare the report.', [call('create_directory', { path: 'reports' }, 'mkdir-1')]),
    completion('', [call('write_file', { path: 'reports/result.md', content: '# Result\n\nPending.' }, 'write-1')]),
    completion('', [call('edit_file', { path: 'reports/result.md', old_text: 'Pending.', new_text: 'Checked.' }, 'edit-1')]),
    completion('', [call('read_file', { path: 'reports/result.md', start_line: 1, end_line: 3 }, 'read-1')]),
    completion('Created reports/result.md and checked its content.'),
  ] });
  const log = collect(await start(service));
  const directory = await log.wait('approval.required', (event) => event.callId === 'mkdir-1');
  assert.equal(directory.preview.kind, 'directory');
  await assert.rejects(access(path.join(root, 'reports')));
  assert.equal((await approve(service, 'run-1', directory.callId, true)).status, 200);
  const write = await log.wait('approval.required', (event) => event.callId === 'write-1');
  assert.equal((await approve(service, 'run-1', write.callId, true)).status, 200);
  const edit = await log.wait('approval.required', (event) => event.callId === 'edit-1');
  assert.equal(edit.preview.kind, 'write'); assert.equal(edit.preview.replacements, 1);
  assert.equal(edit.preview.before, '# Result\n\nPending.'); assert.equal(edit.preview.after, '# Result\n\nChecked.');
  assert.equal(await readFile(path.join(root, 'reports/result.md'), 'utf8'), '# Result\n\nPending.');
  assert.equal((await approve(service, 'run-1', edit.callId, true)).status, 200);
  const items = await log.done;
  assert.equal(finish(items).status, 'completed');
  assert.equal(await readFile(path.join(root, 'reports/result.md'), 'utf8'), '# Result\n\nChecked.');
  assert.equal(events(items, 'artifact').length, 2, 'writes and edits produce files, directories are not misrepresented as file artifacts');
  assert.ok(events(items, 'artifact').every((item) => item.path === 'reports/result.md' && item.kind === 'file'));
  assert.equal(JSON.parse(requests[4].body.messages.at(-1).content).content, '# Result\n\nChecked.');
  const instructions = requests[0].body.messages[0].content;
  assert.match(instructions, /命令已关闭/); assert.match(instructions, /网络工具已关闭/);
  assert.ok(instructions.includes(JSON.stringify(await realpath(root))));
  const duties = instructions.split('工具职责\n')[1];
  assert.match(duties, /edit_file：/); assert.match(duties, /create_directory：/);
  assert.doesNotMatch(duties, /run_command|web_search|fetch_url|download_file/);
  for (const request of requests) assert.equal(request.body.messages[0].content, instructions, 'prefix remains stable throughout the run');
});

test('denied write is not executed and denial reaches the next model turn', async (t) => {
  const { service, root, requests } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'denied.md', content: 'must not appear' })]), completion('The requested write was denied.')] });
  const log = collect(await start(service)); const pending = await log.wait('approval.required');
  assert.equal((await approve(service, 'run-1', pending.callId, false)).status, 200);
  const items = await log.done;
  await assert.rejects(access(path.join(root, 'denied.md')));
  assert.equal(events(items, 'tool.denied').length, 1); assert.equal(events(items, 'artifact').length, 0);
  assert.match(requests[1].body.messages.at(-1).content, /拒绝/); assert.equal(finish(items).status, 'completed');
});

test('approval cannot overwrite an intervening user edit and reports tool failure', async (t) => {
  const { service, root, requests } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'existing.md', content: 'agent replacement' })]), completion('The file changed; no replacement was made.')] });
  await writeFile(path.join(root, 'existing.md'), 'before');
  const log = collect(await start(service)); const pending = await log.wait('approval.required');
  assert.equal(pending.preview.before, 'before'); await writeFile(path.join(root, 'existing.md'), 'user changed while reviewing');
  await approve(service, 'run-1', pending.callId, true); const items = await log.done;
  assert.equal(await readFile(path.join(root, 'existing.md'), 'utf8'), 'user changed while reviewing');
  assert.equal(events(items, 'tool.failed').length, 1); assert.equal(events(items, 'artifact').length, 0);
  assert.match(requests[1].body.messages.at(-1).content, /变化|修改/);
});

test('waiting approval enforces one active run, one decision, and settings cannot change mid-run', async (t) => {
  const { service } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'one.md', content: 'one' })]), completion('done')] });
  const log = collect(await start(service)); const pending = await log.wait('approval.required');
  assert.equal((await start(service, 'other-run')).status, 409);
  assert.deepEqual((await (await get(service, '/api/agent/capabilities')).json()).activeRunIds, ['run-1']);
  assert.equal((await settings(service, { agentAllowCommands: true })).status, 409);
  assert.equal((await approve(service, 'run-1', pending.callId, false)).status, 200);
  assert.equal((await approve(service, 'run-1', pending.callId, true)).status, 409);
  await log.done;
  assert.deepEqual((await (await get(service, '/api/agent/capabilities')).json()).activeRunIds, []);
});

test('cancelling waiting approval invalidates approval and never executes the proposed write', async (t) => {
  const { service, root, requests } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'cancelled.md', content: 'forbidden after stop' })])] });
  const log = collect(await start(service)); const pending = await log.wait('approval.required');
  assert.equal((await post(service, '/api/agent/cancel', { runId: 'run-1' })).status, 200);
  assert.equal((await approve(service, 'run-1', pending.callId, true)).status, 409);
  const items = await log.done;
  assert.equal(finish(items).status, 'cancelled'); assert.equal(events(items, 'tool.started').length, 0);
  await assert.rejects(access(path.join(root, 'cancelled.md'))); assert.equal(requests.length, 1);
});

test('request abort stops pending approval and cannot be revived', async (t) => {
  const { service, root } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'aborted.md', content: 'no' })])] });
  const controller = new AbortController(); const log = collect(await start(service, 'run-1', { signal: controller.signal }));
  const pending = await log.wait('approval.required'); controller.abort(); const items = await log.done;
  assert.equal(finish(items).status, 'cancelled');
  assert.equal((await approve(service, 'run-1', pending.callId, true)).status, 409);
  await assert.rejects(access(path.join(root, 'aborted.md')));
});

test('invalid JSON tool arguments reject the entire model batch before any tool executes', async (t) => {
  let prepared = 0;
  const { service } = await fixture(t, { turns: [completion('', [call('read_file', { path: 'first.txt' }), call('read_file', '{broken', 'call-2')])], agentToolFactory: async (options) => {
    const tools = await createAgentTools(options); return { ...tools, prepare: (...args) => { prepared += 1; return tools.prepare(...args); } };
  } });
  const items = await collect(await start(service)).done;
  assert.equal(finish(items).status, 'failed'); assert.match(finish(items).error, /JSON/); assert.equal(prepared, 0);
});

test('duplicate call IDs in one completion are rejected before tool effects', async (t) => {
  let prepared = 0;
  const { service } = await fixture(t, { turns: [completion('', [call('read_file', { path: 'a' }), call('read_file', { path: 'b' })])], agentToolFactory: async (options) => {
    const tools = await createAgentTools(options); return { ...tools, prepare: (...args) => { prepared += 1; return tools.prepare(...args); } };
  } });
  const items = await collect(await start(service)).done;
  assert.equal(finish(items).status, 'failed'); assert.match(finish(items).error, /重复/); assert.equal(prepared, 0);
});

test('duplicate call IDs across turns cannot replay an executed action', async (t) => {
  const { service, root, requests } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'once.txt', content: 'first' })]), completion('', [call('write_file', { path: 'once.txt', content: 'second' })])] });
  const log = collect(await start(service)); const pending = await log.wait('approval.required'); await approve(service, 'run-1', pending.callId, true);
  const items = await log.done;
  assert.equal(await readFile(path.join(root, 'once.txt'), 'utf8'), 'first'); assert.equal(finish(items).status, 'failed');
  assert.equal(events(items, 'approval.required').length, 1); assert.equal(events(items, 'tool.completed').length, 1); assert.equal(requests.length, 2);
});

test('disabled tools are absent from model registry and a requested disabled tool rejects the whole batch', async (t) => {
  const { service, requests } = await fixture(t, { turns: [completion('', [call('run_command', { command: 'should never run' })])] });
  const items = await collect(await start(service)).done;
  const names = requests[0].body.tools.map((tool) => tool.function.name);
  assert.ok(!names.includes('run_command')); assert.ok(!names.includes('fetch_url')); assert.ok(!names.includes('download_file'));
  assert.equal(finish(items).status, 'failed'); assert.equal(events(items, 'tool.started').length, 0);
});

test('maxSteps terminates a tool loop without extra model calls or silently claiming completion', async (t) => {
  const { service, requests } = await fixture(t, { config: { agentMaxSteps: 2 }, turns: [completion('', [call('list_files')]), completion('', [call('list_files', {}, 'call-2')])] });
  const items = await collect(await start(service)).done;
  assert.equal(requests.length, 2); assert.equal(events(items, 'tool.completed').length, 2);
  assert.equal(finish(items).status, 'failed'); assert.equal(finish(items).steps, 2); assert.match(finish(items).error, /步数/);
});

test('24-call budget stops a repeated tool loop before the next batch executes', async (t) => {
  const turns = Array.from({ length: 4 }, (_, step) => completion('', Array.from({ length: step < 3 ? 8 : 1 }, (_, index) => call('list_files', {}, `call-${step}-${index}`))));
  const { service, requests } = await fixture(t, { config: { agentMaxSteps: 30 }, turns });
  const items = await collect(await start(service)).done;
  assert.equal(requests.length, 4); assert.equal(events(items, 'tool.completed').length, 24);
  assert.equal(finish(items).status, 'failed'); assert.match(finish(items).error, /24/);
});

test('injected execution engine receives the same transcript and tools without changing direct chat', async (t) => {
  const turns = [];
  const { service, requests } = await fixture(t, { turns: [completion('direct remains available')], agentEngines: {
    compatible: async (input) => { turns.push(input); return { content: 'replacement engine result', toolCalls: [], usage: null }; },
  } });
  const items = await collect(await start(service)).done;
  assert.equal(visible(items), 'replacement engine result'); assert.equal(finish(items).status, 'completed');
  assert.equal(requests.length, 0); assert.equal(turns.length, 1); assert.deepEqual(turns[0].messages.at(-1), question[0]);
  assert.ok(turns[0].tools.some((tool) => tool.function.name === 'read_file')); assert.ok(turns[0].signal instanceof AbortSignal);
  assert.equal(await readChatStream(await post(service, '/api/chat', { messages: question }), () => {}), 'direct remains available');
  assert.equal(requests.length, 1); assert.equal(requests[0].body.tools, undefined);
});

test('approved download creates a real artifact only after approval using credential-free mock transport', async (t) => {
  const transfers = []; const bytes = Buffer.from([0, 1, 255, 3]);
  const { service, root } = await fixture(t, { config: { agentAllowNetwork: true }, turns: [completion('', [call('download_file', { url: 'https://download.invalid/file', path: 'download.bin' })]), completion('Downloaded the file.')],
    agentToolFactory: (options) => createAgentTools({ ...options, lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }], fetchImpl: async (url, request) => {
      transfers.push({ url, request }); return new Response(bytes, { headers: { 'Content-Type': 'application/octet-stream' } });
    } }),
  });
  const log = collect(await start(service)); const pending = await log.wait('approval.required');
  assert.equal(pending.preview.executesFile, false); assert.equal(transfers.length, 0); await assert.rejects(access(path.join(root, 'download.bin')));
  await approve(service, 'run-1', pending.callId, true); const items = await log.done;
  assert.deepEqual(await readFile(path.join(root, 'download.bin')), bytes);
  assert.equal(transfers.length, 1); assert.equal(transfers[0].request.credentials, 'omit'); assert.equal(transfers[0].request.headers.Authorization, undefined);
  assert.equal(events(items, 'artifact')[0].kind, 'download'); assert.equal(finish(items).status, 'completed');
});

test('a non-supporting model reports failure without executing tools or changing direct-chat settings', async (t) => {
  const { service, requests } = await fixture(t, { turns: [Response.json({ error: 'tools not supported' }, { status: 400 }), completion('plain fallback')] });
  const items = await collect(await start(service)).done;
  assert.equal(finish(items).status, 'failed'); assert.match(finish(items).error, /工具调用|直接聊天/); assert.equal(events(items, 'tool.started').length, 0);
  assert.equal(await readChatStream(await post(service, '/api/chat', { messages: question }), () => {}), 'plain fallback');
  assert.equal(requests[1].body.tools, undefined);
});

test('closing while the model is pending aborts transport and awaits its shutdown', async (t) => {
  let transportStopped = false;
  const { service } = await fixture(t, { turns: [async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => setTimeout(() => { transportStopped = true; reject(new DOMException('stopped', 'AbortError')); }, 35), { once: true });
  })] });
  const log = collect(await start(service)); await log.wait('model.started');
  await service.close(); assert.equal(transportStopped, true);
  assert.equal(finish(await log.done).status, 'cancelled');
});

test('cancelling the response body invalidates approval and stops the associated run', async (t) => {
  const { service, root } = await fixture(t, { turns: [completion('', [call('write_file', { path: 'disconnected.txt', content: 'must not appear' })])] });
  const response = await start(service); const reader = response.body.getReader(); const decoder = new TextDecoder(); let received = '';
  while (!received.includes('approval.required')) { const { value, done } = await reader.read(); assert.equal(done, false); received += decoder.decode(value, { stream: true }); }
  await reader.cancel(); reader.releaseLock();
  assert.deepEqual((await (await get(service, '/api/agent/capabilities')).json()).activeRunIds, []);
  assert.equal((await approve(service, 'run-1', 'call-1', true)).status, 409);
  await assert.rejects(access(path.join(root, 'disconnected.txt')));
});

test('fully reported usage aggregates all turns while unreported cache remains unknown', async (t) => {
  const { service } = await fixture(t, { turns: [completion('', [call('list_files')], { prompt_tokens: 10, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 3 } }), completion('done', undefined, { prompt_tokens: 20, completion_tokens: 5 })] });
  const usage = []; const response = await start(service);
  await readChatStream(response, () => {}, (value) => usage.push(value));
  assert.deepEqual(usage.at(-1), { inputTokens: 30, outputTokens: 9, cachedInputTokens: null });
});

test('an unknown usage turn does not present a partial sum as total run usage', async (t) => {
  const { service } = await fixture(t, { turns: [completion('', [call('list_files')], { prompt_tokens: 10, completion_tokens: 4 }), completion('done')] });
  const usage = []; await readChatStream(await start(service), () => {}, (value) => usage.push(value));
  assert.deepEqual(usage, []);
});

test('readChatStream forwards failed run terminal metadata before throwing the error event', async (t) => {
  const { service } = await fixture(t, { turns: [new Response('{bad', { headers: { 'Content-Type': 'application/json' } })] });
  const agentEvents = [];
  await assert.rejects(readChatStream(await start(service), () => {}, () => {}, (event) => agentEvents.push(event)), /JSON/);
  assert.equal(agentEvents.at(-1).type, 'run.finished'); assert.equal(agentEvents.at(-1).status, 'failed');
});

test('service.close waits for an in-flight tool to acknowledge cancellation before completing', async (t) => {
  let stopped = false, prepared = false;
  const { service } = await fixture(t, { turns: [completion('', [call('list_files')])], agentToolFactory: async () => ({ root: 'fixture', tools: [{ type: 'function', function: { name: 'list_files' } }], prepare: async (_name, _args, { signal }) => ({
    summary: 'fixture delayed stop', preview: {}, requiresApproval: false,
    execute: () => new Promise((resolve) => { prepared = true; signal.addEventListener('abort', () => setTimeout(() => { stopped = true; resolve({ cancelled: true }); }, 80), { once: true }); }),
  }) }) });
  const log = collect(await start(service)); await log.wait('tool.started'); assert.equal(prepared, true);
  let closed = false; const closing = service.close().then(() => { closed = true; }); await delay(15);
  assert.equal(closed, false); assert.equal(stopped, false);
  await closing; assert.equal(stopped, true);
  const items = await log.done; assert.equal(finish(items).status, 'cancelled'); assert.equal(events(items, 'tool.completed').length, 0);
  assert.equal((await get(service, '/api/health')).status, 503);
});

test('service.close stops a real approved command before returning and leaves no delayed write', { timeout: 15000 }, async (t) => {
  const command = process.platform === 'win32'
    ? "Set-Content -LiteralPath 'started.txt' -Value $PID; Start-Sleep -Seconds 20; Set-Content -LiteralPath 'late.txt' -Value 'must not run'"
    : "echo $$ > started.txt; sleep 20; printf 'must not run' > late.txt";
  const { service, root } = await fixture(t, { config: { agentAllowCommands: true }, turns: [completion('', [call('run_command', { command, timeout_ms: 30000 })])] });
  const log = collect(await start(service)); const pending = await log.wait('approval.required');
  assert.equal(pending.preview.sandboxed, false); await approve(service, 'run-1', pending.callId, true); await log.wait('tool.started');
  let pid;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { pid = Number((await readFile(path.join(root, 'started.txt'), 'utf8')).trim()); if (pid) break; } catch {}
    await delay(25);
  }
  assert.ok(pid > 0, 'command reached execution before cancellation');
  await service.close(); const items = await log.done;
  assert.equal(finish(items).status, 'cancelled');
  assert.throws(() => process.kill(pid, 0), /ESRCH|not found|No such/i);
  await assert.rejects(access(path.join(root, 'late.txt')));
});

test('compatible completion parser accepts fragmented streaming tool calls and rejects malformed/oversized replies', async () => {
  const parts = [
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-', function: { name: 'read_', arguments: '{"path":' } }] } }] },
    { choices: [{ delta: { content: 'inspect', tool_calls: [{ index: 0, id: '1', function: { name: 'file', arguments: '"a.txt"}' } }] } }] },
  ];
  const response = new Response(parts.map((part) => `data: ${JSON.stringify(part)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const output = await readAgentCompletion(response);
  assert.equal(output.toolCalls[0].id, 'call-1'); assert.equal(output.toolCalls[0].function.name, 'read_file');
  assert.deepEqual(output.toolCalls[0].args, { path: 'a.txt' }); assert.equal(output.content, 'inspect');
  await assert.rejects(readAgentCompletion(completion('', Array.from({ length: 9 }, (_, index) => call('list_files', {}, `call-${index}`)))), /过多/);
  await assert.rejects(readAgentCompletion(new Response('x'.repeat(2 * 1024 * 1024 + 1))), /2 MiB/);
  await assert.rejects(readAgentCompletion(completion('', undefined)), /空回答/);
});

test('a command exiting nonzero is recorded as failed and its real result reaches the model',async(t)=>{
  const {service,requests}=await fixture(t,{config:{agentAllowCommands:true},turns:[completion('',[call('run_command',{command:'exit 7',timeout_ms:5000})]),completion('验证命令返回 7，尚未通过。')]});
  const log=collect(await start(service));
  const pending=await log.wait('approval.required');
  await approve(service,'run-1',pending.callId,true);
  const items=await log.done;
  assert.equal(events(items,'tool.failed').filter((entry)=>entry.tool==='run_command').length,1);
  assert.equal(events(items,'tool.completed').filter((entry)=>entry.tool==='run_command').length,0);
  assert.equal(JSON.parse(requests[1].body.messages.at(-1).content).exitCode,7);
  assert.match(visible(items),/尚未通过/);
});
