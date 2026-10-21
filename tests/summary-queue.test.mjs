import test from "node:test";
import assert from "node:assert/strict";
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { JSDOM } from "jsdom";
import { useSummaries } from "../src/hooks/useSummaries.js";
import { createBoard, createNode, newId } from "../shared/core.mjs";
import { mergeConversations } from "../shared/operations.mjs";
import { isSummaryStale, summaryEvidenceFingerprint } from "../shared/research.mjs";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => { resolve = accept; reject = decline; });
  return { promise, resolve, reject };
}

const node = (id, parentId = null) => ({
  id, parentId, mergeParents: [], merges: [], status: "active", title: `会话 ${id}`, source: null,
  summary: null, messages: [{ role: "user", content: `问题 ${id}` }, { role: "assistant", content: `回答 ${id}` }],
});
const workspace = () => ({
  activeBoardId: "b1", revision: 7,
  boards: [
    { id: "b1", title: "第一画布", status: "active", nodes: [node("a"), node("b", "a"), node("c", "a")] },
    { id: "b2", title: "第二画布", status: "active", nodes: [node("z")] },
  ],
});

async function withQueue(run, options = {}) {
  const dom = new JSDOM('<!doctype html><div id="root"></div>');
  const keys = ["window", "document", "navigator", "fetch", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = new Map(keys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const wsRef = { current: workspace() };
  const settingsRef = { current: { autoSummary: options.autoSummary ?? true, autoSummaryMaterials: options.autoSummaryMaterials ?? false } };
  const requests = [];
  const notifications = [];
  const updates = [];
  let api;
  let pending = 0;
  let maximumPending = 0;
  const fetchMock = (url, init) => {
    assert.equal(url, "/api/summarize");
    assert.equal(init.method, "POST");
    const task = deferred();
    const body = JSON.parse(init.body);
    const request = {
      body, signal: init.signal, settled: false,
      succeed(text = `总结 ${body.nodeId}`) {
        this.respond({ ok: true, status: 200, json: async () => ({
          boardId: body.boardId, nodeId: body.nodeId,
          summary: { title: `标题 ${body.nodeId}`, text },
        }) });
      },
      respond(response) { this.settled = true; task.resolve(response); },
      reject(error = new DOMException("Aborted", "AbortError")) { this.settled = true; task.reject(error); },
    };
    requests.push(request);
    pending += 1;
    maximumPending = Math.max(maximumPending, pending);
    task.promise.then(() => { pending -= 1; }, () => { pending -= 1; });
    return task.promise;
  };
  let root;
  try {
    for (const [key, value] of [
      ["window", dom.window], ["document", dom.window.document], ["navigator", dom.window.navigator],
      ["fetch", fetchMock], ["IS_REACT_ACT_ENVIRONMENT", true],
    ]) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    function Harness() {
      api = useSummaries({
        wsRef, settingsRef,
        update(mutator) {
          const next = structuredClone(wsRef.current);
          mutator(next);
          wsRef.current = next;
          updates.push(next);
        },
        notify: (message) => notifications.push(message),
      });
      return null;
    }
    root = createRoot(dom.window.document.querySelector("#root"));
    await act(async () => root.render(React.createElement(Harness)));
    await run({
      get api() { return api; }, wsRef, settingsRef, requests, notifications, updates,
      get maximumPending() { return maximumPending; },
      target(id = "a", boardId = "b1") { return wsRef.current.boards.find((b) => b.id === boardId)?.nodes.find((n) => n.id === id); },
      async action(fn) { await act(async () => fn(api)); },
      async settle(index, text) { await act(async () => requests[index].succeed(text)); },
    });
  } finally {
    if (root) await act(async () => {
      api.cancel();
      for (const request of requests) if (!request.settled) request.reject();
      root.unmount();
    });
    dom.window.close();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
}

test("summary queue serializes requests, deduplicates targets, and snapshots only the requested board", async () => {
  await withQueue(async (h) => {
    await h.action((api) => { api.enqueue("b1", ["a", "b", "a"]); api.enqueue("b1", ["a"]); });
    assert.equal(h.requests.length, 1);
    assert.equal(h.api.states["b1:a"].status, "generating");
    assert.equal(h.api.states["b1:b"].status, "pending");
    await h.settle(0);
    assert.equal(h.requests.length, 2);
    assert.equal(h.target("a").summary.text, "总结 a");
    assert.equal(h.requests[1].body.nodeId, "b");
    await h.settle(1);
    await h.action((api) => api.enqueue("b2", ["z"]));
    assert.equal(h.requests[2].body.workspace.boards.length, 1);
    assert.equal(h.requests[2].body.workspace.activeBoardId, "b2");
    assert.equal(h.requests[2].body.workspace.boards[0].id, "b2");
    assert.equal(h.requests[2].body.workspace.revision, 7);
    await h.settle(2);
    assert.deepEqual(h.api.states, {});
    assert.equal(h.maximumPending, 1);
  });
});

test("pause immediately requeues the active summary when resume happens before the abort catch", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    await h.action((api) => { api.pause(); api.resume(); });
    assert.equal(h.requests[0].signal.aborted, true);
    assert.equal(h.requests.length, 1);
    assert.equal(h.api.states["b1:a"].status, "pending");
    await h.action(() => h.requests[0].reject());
    assert.equal(h.requests.length, 2);
    assert.equal(h.requests[1].body.nodeId, "a");
    await h.settle(1, "恢复后的总结");
    assert.equal(h.requests[2].body.nodeId, "b");
    await h.settle(2);
    assert.equal(h.target().summary.text, "恢复后的总结");
    assert.equal(h.maximumPending, 1);
    assert.deepEqual(h.api.states, {});
  });
});

test("a paused fetch that ignores abort and resolves successfully is discarded and restarted only once", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    await h.action((api) => { api.pause(); api.pause(); });
    await h.settle(0, "应被丢弃");
    assert.equal(h.requests.length, 1);
    assert.equal(h.target().summary, null);
    await h.action((api) => api.resume());
    assert.equal(h.requests.length, 2);
    await h.settle(1, "重新开始");
    assert.equal(h.target().summary.text, "重新开始");
    assert.equal(h.requests.length, 2);
  });
});

test("cancel drops queued jobs and all late results, allowing a fresh enqueue for the same target", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    await h.action((api) => { api.cancel(); api.enqueue("b1", ["a"], { manual: true }); });
    assert.equal(h.api.states["b1:a"].status, "pending");
    assert.equal(h.api.states["b1:b"], undefined);
    await h.action(() => h.requests[0].reject());
    assert.equal(h.requests.length, 2);
    assert.equal(h.api.states["b1:a"].status, "generating");
    await h.settle(1, "最新总结");
    assert.equal(h.target().summary.text, "最新总结");
    assert.equal(h.target("b").summary, null);
    assert.equal(h.maximumPending, 1);
    assert.deepEqual(h.api.states, {});
  });
});

test("cancel cannot be undone by a late successful old response", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    await h.action((api) => api.cancel());
    await h.settle(0, "取消后的迟到结果");
    assert.equal(h.target().summary, null);
    assert.equal(h.updates.length, 0);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.api.states, {});
  });
});

test("cancel during response.json discards late JSON and preserves the new job's generation", async () => {
  await withQueue(async (h) => {
    const json = deferred();
    await h.action((api) => api.enqueue("b1", ["a"]));
    await h.action(() => h.requests[0].respond({ ok: true, status: 200, json: () => json.promise }));
    await h.action((api) => { api.cancel(); api.enqueue("b1", ["b"]); });
    assert.equal(h.requests.length, 1);
    await h.action(() => json.resolve({ boardId: "b1", nodeId: "a", summary: { title: "旧", text: "旧" } }));
    assert.equal(h.requests.length, 2);
    assert.equal(h.target().summary, null);
    assert.equal(h.api.states["b1:b"].status, "generating");
    await h.settle(1);
    assert.equal(h.target("b").summary.text, "总结 b");
    assert.deepEqual(h.api.states, {});
  });
});

for (const [description, mutate] of [
  ["own messages", (h) => h.target().messages.push({ role: "user", content: "新问题" })],
  ["branch topology", (h) => h.wsRef.current.boards[0].nodes.push(node("child", "a"))],
  ["a related branch summary", (h) => { h.target("b").summary = { title: "兄弟", text: "另一个方向" }; }],
  ["inherited branch context", (h) => { h.target().source = { quote: "新引用", context: [{ role: "user", content: "继承问题" }] }; }],
  ["merge ancestry", (h) => { h.target().mergeParents = ["b"]; }],
  ["a related research status", (h) => { h.target("b").researchStatus = "adopted"; }],
  ["the current node kind", (h) => { h.target().kind = "conclusion"; }],
  ["a related conclusion's source relation", (h) => { h.target("b").conclusion = { sourceNodeIds: ["c"] }; }],
]) test(`summary responses are invalidated when ${description} changes`, async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    mutate(h);
    await h.settle(0, "过时总结");
    assert.equal(h.target().summary, null);
    assert.equal(h.requests.length, 2);
    assert.equal(h.api.states["b1:a"].status, "generating");
    await h.settle(1, "包含最新证据");
    assert.equal(h.target().summary.text, "包含最新证据");
  });
});

test("summary saves the request snapshot evidence key and ignores a provider-supplied stale key", async () => {
  await withQueue(async (h) => {
    const expected = summaryEvidenceFingerprint(h.wsRef.current.boards[0], "a");
    await h.action((api) => api.enqueue("b1", ["a"]));
    await h.action(() => h.requests[0].respond({ ok: true, status: 200, json: async () => ({
      boardId: "b1", nodeId: "a", summary: { title: "摘要", text: "当前内容的摘要", evidenceFingerprint: "untrusted-old-key" },
    }) }));
    assert.equal(h.target().summary.evidenceFingerprint, expected);
    assert.equal(isSummaryStale(h.wsRef.current.boards[0], "a"), false);
    assert.equal(h.requests.length, 1);
  });
});

test("a real append merge in a related branch invalidates the ancestor's in-flight summary and retries with its new source tree", async () => {
  await withQueue(async (h) => {
    const board = createBoard("追加合并回归");
    board.id = "b1";
    const root = board.nodes[0];
    root.id = "a";
    const message = (role, content) => ({ id: newId(), role, content, createdAt: board.createdAt });
    root.messages.push(message("user", "主干问题"), message("assistant", "主干原有回答"));
    const child = createNode(board, { parentId: root.id, title: "当前派生分支" });
    child.messages.push(message("user", "派生问题"), message("assistant", "派生结论"));
    const source = createNode(board, { title: "独立研究主干" });
    source.messages.push(message("user", "独立来源问题"), message("assistant", "独立来源结论"));
    h.wsRef.current = { version: 2, activeBoardId: board.id, revision: 7, boards: [board] };

    await h.action((api) => api.enqueue(board.id, [root.id]));
    const originalChild = h.requests[0].body.workspace.boards[0].nodes.find((item) => item.id === child.id);
    const merged = mergeConversations(h.wsRef.current, {
      boardId: board.id, nodeIds: [source.id], mode: "append", targetId: child.id,
    });
    assert.equal(merged.changed, true);
    h.wsRef.current = merged.workspace;
    assert.deepEqual(h.target(child.id).mergeParents, originalChild.mergeParents);
    assert.equal(h.target(child.id).summary, originalChild.summary);
    await h.settle(0, "缺少新合并关系的旧总结");

    assert.equal(h.target().summary, null);
    assert.equal(h.requests.length, 2, "append changes provenance without changing directed ancestry; its old response must retry");
    const retryChild = h.requests[1].body.workspace.boards[0].nodes.find((item) => item.id === child.id);
    assert.equal(retryChild.merges[0].nodeId, source.id);
    assert.match(retryChild.messages.at(-1).content, /独立来源结论/);
    await h.settle(1, "包含新关联树的总结");
    assert.equal(h.target().summary.text, "包含新关联树的总结");
    assert.deepEqual(h.api.states, {});
  });
});

for (const targetId of ["a", "b"]) {
  for (const field of ["nodeId", "title", "createdAt", "messageIds"]) {
    test(`summary invalidates when ${targetId === "a" ? "current" : "related"} provenance ${field} changes`, async () => {
      await withQueue(async (h) => {
        h.target(targetId).merges = [{ nodeId: "c", title: "已引用来源", createdAt: "2026-10-18T00:00:00.000Z", messageIds: ["imported-1"], context: [{ role: "user", content: "历史 baseline" }] }];
        await h.action((api) => api.enqueue("b1", ["a"]));
        const record = h.target(targetId).merges[0];
        if (field === "messageIds") record.messageIds.push("imported-2");
        else record[field] = { nodeId: "new-source", title: "来源改名", createdAt: "2026-10-18T01:00:00.000Z" }[field];
        await h.settle(0, "旧合并关系");
        assert.equal(h.target().summary, null);
        assert.equal(h.requests.length, 2);
        await h.settle(1, "已更新合并关系");
        assert.equal(h.target().summary.text, "已更新合并关系");
      });
    });
  }
}

test("unused historical merge baseline changes do not invalidate current or related summary fingerprints", async () => {
  await withQueue(async (h) => {
    for (const id of ["a", "b"]) h.target(id).merges = [{
      nodeId: "c", title: "来源", createdAt: "2026-10-18T00:00:00.000Z", messageIds: ["imported-1"],
      context: [{ role: "user", content: "巨大历史快照".repeat(10000) }],
    }];
    await h.action((api) => api.enqueue("b1", ["a"]));
    for (const id of ["a", "b"]) h.target(id).merges[0].context = [{ role: "user", content: "未发送给摘要模型的旧 baseline 变化" }];
    await h.settle(0, "关系未变，仍有效");
    assert.equal(h.requests.length, 1);
    assert.equal(h.target().summary.text, "关系未变，仍有效");
  });
});

test("stale results retry at most twice, then expose a retryable error instead of remaining pending", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      h.target().messages.push({ role: "user", content: `变化 ${attempt}` });
      await h.settle(attempt, "过时");
    }
    assert.equal(h.requests.length, 3);
    assert.equal(h.target().summary, null);
    assert.equal(h.api.states["b1:a"].status, "error");
    assert.equal(h.api.states["b1:a"].retryable, true);
    assert.match(h.api.states["b1:a"].error, /持续变化/);
    await h.action((api) => api.enqueue("b1", ["a"], { manual: true }));
    await h.settle(3, "重试成功");
    assert.equal(h.target().summary.text, "重试成功");
    assert.deepEqual(h.api.states, {});
  });
});

test("card positions, drafts, and storage revisions do not invalidate a summary", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    h.target().x = 1200;
    h.target().draft = "尚未发送的问题";
    h.wsRef.current.revision = 8;
    await h.settle(0, "有效总结");
    assert.equal(h.target().summary.text, "有效总结");
    assert.equal(h.requests.length, 1);
  });
});

test("archived, trashed, removed, and newly ineligible queued targets are skipped", async () => {
  await withQueue(async (h) => {
    h.target("b").status = "archived";
    h.target("c").status = "trashed";
    h.wsRef.current.boards[1].status = "archived";
    await h.action((api) => { api.enqueue("b1", ["a", "b", "c", "missing"]); api.enqueue("b2", ["z"]); });
    assert.equal(h.requests.length, 1);
    assert.deepEqual(Object.keys(h.api.states), ["b1:a"]);
    h.target().status = "archived";
    await h.settle(0);
    assert.equal(h.target().summary, null);
    assert.deepEqual(h.api.states, {});

    h.target().status = "active";
    h.target("b").status = "active";
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    h.target("b").status = "trashed";
    await h.settle(1);
    // The tree status change invalidates a's first result, while b itself
    // must never enter the network queue after being trashed.
    assert.equal(h.requests.length, 3);
    assert.equal(h.requests[2].body.nodeId, "a");
    await h.settle(2);
    assert.deepEqual(h.api.states, {});
  });
});

test("autoSummary false rejects automatic enqueue but always permits manual requests", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    assert.equal(h.requests.length, 0);
    await h.action((api) => api.enqueue("b1", ["a"], { manual: true }));
    assert.equal(h.requests.length, 1);
    await h.settle(0, "手动总结");
    assert.equal(h.target().summary.text, "手动总结");
  }, { autoSummary: false });
});

test("manual enqueue upgrades a paused automatic job after automatic summaries are disabled", async () => {
  await withQueue(async (h) => {
    await h.action((api) => { api.pause(); api.enqueue("b1", ["a"]); });
    h.settingsRef.current.autoSummary = false;
    await h.action((api) => { api.enqueue("b1", ["a"], { manual: true }); api.resume(); });
    assert.equal(h.requests.length, 1);
    await h.settle(0, "手动升级");
    assert.equal(h.target().summary.text, "手动升级");
  });
});

test("navigation-style automatic enqueue skips material conversations and inherited material branches before any request", async () => {
  await withQueue(async (h) => {
    h.target().messages.push({ role: "user", content: "【本地资料：研究.md】\n\n文档原文", material: { name: "研究.md", kind: "markdown" } });
    h.target("b").source = { quote: "", context: [{ role: "user", content: "聚焦前缀\n【本地资料：研究.md】\n\n继承的文档原文" }], contextMode: "tail-focus" };
    await h.action((api) => api.enqueue("b1", ["a", "b", "c"]));
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.nodeId, "c");
    assert.equal(h.api.states["b1:a"], undefined);
    assert.equal(h.api.states["b1:b"], undefined);
    await h.settle(0);
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    assert.equal(h.requests.length, 1, "revisiting the board cannot implicitly upload imported or inherited materials");
    assert.equal(h.target().summary, null);
    assert.equal(h.target("b").summary, null);
  });
});

for (const [kind, materialize] of [
  ["metadata without a display marker", (target) => { target.messages[0].material = { name: "旧资料.pdf", kind: "pdf", page: 1 }; }],
  ["a focus-wrapped inline marker", (target) => { target.source = { quote: "", focusText: "引用前缀\n【本地资料：聚焦资料.md】\n片段", contextMode: "tail-focus", context: [] }; }],
]) test(`automatic summary material detection covers ${kind}`, async () => {
  await withQueue(async (h) => {
    materialize(h.target());
    await h.action((api) => api.enqueue("b1", ["a"]));
    assert.equal(h.requests.length, 0);
    assert.deepEqual(h.api.states, {});
  });
});

test("a queued automatic job is rechecked for materials when it starts", async () => {
  await withQueue(async (h) => {
    await h.action((api) => { api.pause(); api.enqueue("b1", ["a", "b"]); });
    h.target().messages.push({ role: "user", content: "已有前缀\n【本地资料：新文件.md】\n新原文" });
    await h.action((api) => api.resume());
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].body.nodeId, "b");
    await h.settle(0);
    assert.equal(h.target().summary, null);
    assert.deepEqual(h.api.states, {});
  });
});

test("material added during an automatic request suppresses its write and does not retry with newly imported text", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    h.target().messages.push({ role: "user", content: "【本地资料：稍后导入.md】\n\n隐私原文" });
    await h.settle(0, "不能写入的旧自动摘要");
    assert.equal(h.requests.length, 1);
    assert.equal(h.target().summary, null);
    assert.equal(h.updates.length, 0);
    assert.deepEqual(h.api.states, {});
  });
});

test("manual summaries explicitly permit materials even when both automatic options are disabled", async () => {
  await withQueue(async (h) => {
    h.target().messages.push({ role: "user", content: "【本地资料：手动选择.md】\n\n用户明确选择总结的资料" });
    await h.action((api) => api.enqueue("b1", ["a"], { manual: true }));
    assert.equal(h.requests.length, 1);
    await h.settle(0, "手动摘要");
    assert.equal(h.target().summary.text, "手动摘要");
  }, { autoSummary: false, autoSummaryMaterials: false });
});

test("material automatic summaries require explicit opt-in and revocation suppresses active writes and queued work", async () => {
  await withQueue(async (h) => {
    for (const id of ["a", "b"]) h.target(id).messages.push({ role: "user", content: `【本地资料：${id}.md】\n\n文档原文` });
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    assert.equal(h.requests.length, 1);
    h.settingsRef.current.autoSummaryMaterials = false;
    await h.settle(0, "撤销同意后的旧结果");
    assert.equal(h.requests.length, 1);
    assert.equal(h.target().summary, null);
    assert.equal(h.target("b").summary, null);
    assert.deepEqual(h.api.states, {});
    h.settingsRef.current.autoSummaryMaterials = true;
    await h.action((api) => api.enqueue("b1", ["a"]));
    await h.settle(1, "明确允许后的材料摘要");
    assert.equal(h.target().summary.text, "明确允许后的材料摘要");
  }, { autoSummaryMaterials: true });
});

test("a manual retry can upgrade an automatic job that gained materials while paused", async () => {
  await withQueue(async (h) => {
    await h.action((api) => { api.pause(); api.enqueue("b1", ["a"]); });
    h.target().messages.push({ role: "user", content: "【本地资料：后加资料.md】\n\n手动选择" });
    await h.action((api) => { api.enqueue("b1", ["a"], { manual: true }); api.resume(); });
    assert.equal(h.requests.length, 1);
    await h.settle(0, "用户明确重试");
    assert.equal(h.target().summary.text, "用户明确重试");
  });
});

test("disabling automatic summaries also drops queued jobs and suppresses an in-flight automatic write", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a", "b"]));
    h.settingsRef.current.autoSummary = false;
    await h.settle(0, "已关闭自动摘要");
    assert.equal(h.target().summary, null);
    assert.equal(h.requests.length, 1);
    assert.deepEqual(h.api.states, {});
  });
});

test("a model error on a stale-result retry exposes its real error and supports a successful manual retry", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    h.target().messages.push({ role: "user", content: "更新" });
    await h.settle(0, "过时");
    await h.action(() => h.requests[1].respond({ ok: false, status: 502, json: async () => ({ error: "模型服务 HTTP 503" }) }));
    assert.equal(h.api.states["b1:a"].status, "error");
    assert.equal(h.api.states["b1:a"].error, "模型服务 HTTP 503");
    assert.deepEqual(h.notifications, []);
    await h.action((api) => api.enqueue("b1", ["a"], { manual: true }));
    await h.action(() => h.requests[2].reject(new Error("连接模型失败")));
    assert.equal(h.api.states["b1:a"].error, "连接模型失败");
    assert.match(h.notifications[0], /连接模型失败/);
    await h.action((api) => api.enqueue("b1", ["a"], { manual: true }));
    await h.settle(3, "模型恢复");
    assert.equal(h.target().summary.text, "模型恢复");
    assert.deepEqual(h.api.states, {});
  });
});

test("malformed or mismatched summary responses never overwrite the target", async () => {
  await withQueue(async (h) => {
    await h.action((api) => api.enqueue("b1", ["a"]));
    await h.action(() => h.requests[0].respond({
      ok: true, status: 200,
      json: async () => ({ boardId: "b1", nodeId: "b", summary: { title: "wrong target", text: "wrong" } }),
    }));
    assert.equal(h.target().summary, null);
    assert.equal(h.api.states["b1:a"].status, "error");
    await h.action((api) => api.enqueue("b1", ["a"], { manual: true }));
    await h.action(() => h.requests[1].respond({ ok: true, status: 200, json: async () => { throw new Error("Invalid JSON"); } }));
    assert.match(h.api.states["b1:a"].error, /无法读取/);
    assert.equal(h.target().summary, null);
  });
});
