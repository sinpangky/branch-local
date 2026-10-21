import test from "node:test";
import assert from "node:assert/strict";
import { buildContext, createBoard, createNode, newId, validateWorkspace } from "../shared/core.mjs";
import { duplicateBoard, duplicateSubtree, mergeConversations, purgeNode, setNodeStatus } from "../shared/operations.mjs";
import { mergeWorkspace } from "../shared/import.mjs";
import { restoreNodes } from "../shared/history.mjs";
import { buildRequestContext, createConclusion, createRequestBranch, getConfirmedConclusions, getContextEntries,
  isSummaryStale, researchFingerprint, summaryEvidenceFingerprint, syncConclusionMessages } from "../shared/research.mjs";

const time = "2026-10-18T00:00:00.000Z";
const message = (role, content) => ({ id: newId(), role, content, createdAt: time });
const wrap = (board) => ({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
function fixture() {
  const board = createBoard("研究工作台"), root = board.nodes[0];
  root.title = "研究主线";
  root.messages.push(message("user", "共享问题"), message("assistant", "共享原始依据"));
  const branch = createNode(board, { parentId: root.id, quote: "共享原始依据", title: "待核对方案" });
  branch.messages.push(message("user", "旧的问题"), message("assistant", "待选择的原始回答"), message("user", "当前新问题"));
  return { board, root, branch, workspace: wrap(board) };
}
function item(node, overrides = {}) {
  return { id: newId(), text: "应当依据实验验证", category: "conclusion", citations: [{ nodeId: node.id, messageId: node.messages[0].id, quote: node.messages[0].content }],
    verified: false, adopted: false, ...overrides };
}
function saveConclusion(workspace, board, source, items, title = "研究结论") {
  return createConclusion(workspace, { boardId: board.id, nodeIds: [source.id], title, items, model: "local-test", fingerprint: "comparison-test", createdAt: time });
}

test("legacy nodes gain independent research defaults without fabricating material or evidence measurements", () => {
  const { workspace, branch } = fixture();
  const raw = structuredClone(workspace);
  for (const node of raw.boards[0].nodes) for (const key of ["researchStatus", "contextPolicy", "kind", "conclusion"]) delete node[key];
  const result = validateWorkspace(raw), nodes = result.boards[0].nodes;
  assert.equal(nodes[0].researchStatus, "exploring");
  assert.deepEqual(nodes[0].contextPolicy, { mode: "full", refs: [], conclusionIds: [] });
  assert.equal(nodes[0].kind, "conversation"); assert.equal(nodes[0].conclusion, null);
  nodes[0].contextPolicy.refs.push({ kind: "message", id: "unavailable-historical-message" });
  assert.deepEqual(nodes[1].contextPolicy.refs, []);
  assert.equal(Object.hasOwn(nodes[1].messages[0], "material"), false);
  assert.deepEqual(buildRequestContext(result.boards[0], branch.id), buildContext(result.boards[0], branch.id));
});

test("research schemas reject invalid statuses, ambiguous citations, policies and material pages", () => {
  const { workspace, board, root, branch } = fixture();
  const saved = saveConclusion(workspace, board, root, [item(root)]);
  const invalids = [
    (nodes) => { nodes[0].researchStatus = "model-adopted"; },
    (nodes) => { nodes[0].contextPolicy.mode = "other"; },
    (nodes) => { nodes[0].contextPolicy.refs = [{ kind: "message", id: "a" }, { kind: "message", id: "a" }]; },
    (nodes) => { nodes[0].contextPolicy.refs = [{ kind: "inherited", index: 0.5 }]; },
    (nodes) => { nodes[0].contextPolicy.conclusionIds = [saved.nodeId, saved.nodeId]; },
    (nodes) => { nodes.at(-1).conclusion.items[0].verified = "true"; },
    (nodes) => { nodes.at(-1).conclusion.items[0].category = "certain"; },
    (nodes) => { nodes.at(-1).conclusion.items.push(structuredClone(nodes.at(-1).conclusion.items[0])); },
    (nodes) => { nodes.at(-1).conclusion.items[0].citations[0].contextIndex = 0; },
    (nodes) => { nodes.at(-1).conclusion.items[0].citations = [{ nodeId: branch.id, contextIndex: -1, quote: "x" }]; },
    (nodes) => { nodes[0].messages[0].material = { name: "paper.pdf", kind: "pdf", page: 0 }; },
    (nodes) => { nodes[0].messages[0].material = { name: "paper.pdf", kind: "html" }; },
    (nodes) => { nodes[0].kind = "conclusion"; },
    (nodes) => { nodes.at(-1).kind = "conversation"; },
  ];
  for (const change of invalids) {
    const bad = structuredClone(saved.workspace); change(bad.boards[0].nodes);
    assert.throws(() => validateWorkspace(bad));
  }
});

test("saving reviewed comparison creates one normal assistant message and never accepts AI confirmation flags", () => {
  const { workspace, board, root } = fixture(), original = structuredClone(workspace);
  const sourceItem = item(root, { verified: true, adopted: true });
  const saved = saveConclusion(workspace, board, root, [sourceItem]);
  const node = saved.workspace.boards[0].nodes.at(-1);
  assert.equal(node.id, saved.nodeId); assert.equal(node.kind, "conclusion");
  assert.equal(node.researchStatus, "exploring"); assert.equal(node.parentId, null);
  assert.equal(node.messages.length, 1); assert.equal(node.messages[0].role, "assistant");
  assert.deepEqual(node.conclusion.messageIds, [node.messages[0].id]);
  assert.ok(node.messages[0].content.includes(sourceItem.text));
  assert.deepEqual(node.conclusion.sourceNodeIds, [root.id]);
  assert.equal(node.conclusion.items[0].verified, false); assert.equal(node.conclusion.items[0].adopted, false);
  assert.deepEqual(workspace, original); assert.equal(sourceItem.verified, true);
  assert.equal(getConfirmedConclusions(saved.workspace.boards[0], root.id).length, 0);
  assert.ok(buildRequestContext(saved.workspace.boards[0],node.id).some((message)=>message.content.includes(sourceItem.citations[0].quote)), 'follow-up questions retain the actual quoted evidence, not only opaque source IDs');
  assert.doesNotMatch(node.messages[0].content,/用户已采用|用户已验证/);
  node.conclusion.items[0].adopted=true;
  syncConclusionMessages(node);
  assert.match(buildRequestContext(saved.workspace.boards[0],node.id)[0].content,/用户已采用/);
  assert.throws(() => saveConclusion(workspace, board, root, []), /至少/);
  assert.throws(() => createConclusion(workspace, { boardId: board.id, nodeIds: ["missing"], items: [sourceItem] }), /不存在/);
});

test("large conclusions split losslessly and editing generated text preserves later conversation turns", () => {
  const { workspace, board, root } = fixture();
  const items = Array.from({ length: 12 }, (_, index) => item(root, { text: `独立结论 ${index}：${"😀".repeat(4700)}` }));
  const saved = saveConclusion(workspace, board, root, items), node = saved.workspace.boards[0].nodes.at(-1);
  assert.ok(node.messages.length > 1); assert.deepEqual(node.conclusion.messageIds, node.messages.map((entry) => entry.id));
  const originalText = node.messages.map((entry) => entry.content).join("");
  for (const entry of node.messages) {
    assert.ok(entry.content.length <= 100000);
    assert.ok(!/[\uD800-\uDBFF]$/.test(entry.content)); assert.ok(!/^[\uDC00-\uDFFF]/.test(entry.content));
  }
  for (const item of items) assert.ok(originalText.includes(item.text));
  const firstId = node.messages[0].id;
  const followups = [message("user", "对这份结论追问"), message("assistant", "后续回答必须保留")];
  node.messages.push(...structuredClone(followups));
  node.conclusion.items = [item(root, { text: "用户修订后的短结论" })];
  assert.equal(syncConclusionMessages(node), node);
  assert.equal(node.messages.length, 3); assert.equal(node.messages[0].id, firstId);
  assert.deepEqual(node.messages.slice(1), followups);
  assert.ok(node.messages[0].content.includes("用户修订后的短结论"));
  assert.ok(!node.messages[0].content.includes("独立结论 0"));
  assert.deepEqual(node.conclusion.messageIds, [firstId]);
  validateWorkspace(saved.workspace);
  const duplicateIds = structuredClone(saved.workspace); duplicateIds.boards[0].nodes.at(-1).conclusion.messageIds = [firstId, firstId];
  assert.throws(() => validateWorkspace(duplicateIds), /正文消息不能重复/);
  node.conclusion.messageIds = [followups[0].id];
  const before = structuredClone(node.messages);
  assert.throws(() => syncConclusionMessages(node), /用户提问/);
  assert.deepEqual(node.messages, before);
  assert.throws(() => validateWorkspace(saved.workspace), /assistant/);
});

test("full request mode is byte-identical for legacy and new focused histories", () => {
  const { board, branch } = fixture();
  assert.deepEqual(buildRequestContext(board, branch.id, { currentMessageId: branch.messages.at(-1).id }), buildContext(board, branch.id));
  branch.source.contextMode = "legacy";
  assert.deepEqual(buildRequestContext(board, branch.id), buildContext(board, branch.id));
});

test("selected requests keep original order and bytes and always include the current user exactly once", () => {
  const { board, branch } = fixture();
  branch.contextPolicy = { mode: "selected", refs: [{ kind: "inherited", index: 1 }, { kind: "message", id: branch.messages[1].id }], conclusionIds: [] };
  const entries = getContextEntries(board, branch.id);
  assert.deepEqual(entries[1].ref, { kind: "inherited", index: 1 });
  assert.equal(entries.at(-1).messageId, branch.messages.at(-1).id);
  const expected = [branch.source.context[1], ...branch.messages.slice(1).map(({ role, content }) => ({ role, content }))];
  assert.deepEqual(buildRequestContext(board, branch.id), expected);
  branch.contextPolicy.refs.push({ kind: "message", id: branch.messages.at(-1).id });
  assert.deepEqual(buildRequestContext(board, branch.id, { currentMessageId: branch.messages.at(-1).id }), expected);
  branch.contextPolicy.refs = [{ kind: "message", id: "deleted-historical-id" }, { kind: "inherited", index: 999 }];
  assert.deepEqual(buildRequestContext(board, branch.id), [{ role: "user", content: "当前新问题" }]);
  assert.throws(() => buildRequestContext(board, branch.id, { currentMessageId: branch.messages[1].id }), /user/);
  assert.throws(() => buildRequestContext(board, branch.id, { currentMessageId: "foreign-question" }), /user/);
});

test("conclusions mode includes only selected active cards with user-confirmed items and keeps all own turns", () => {
  const { workspace, board, root, branch } = fixture();
  const first = saveConclusion(workspace, board, root, [item(root, { text: "被用户验证的结论" }), item(root, { text: "尚未确认的猜测" })]);
  const second = saveConclusion(first.workspace, board, root, [item(root, { text: "未选择的独立结论" })], "另一个主题");
  const output = second.workspace.boards[0], target = output.nodes.find((node) => node.id === branch.id);
  const chosen = output.nodes.find((node) => node.id === first.nodeId), unrelated = output.nodes.at(-1);
  chosen.conclusion.items[0].verified = true; unrelated.conclusion.items[0].adopted = true;
  target.contextPolicy = { mode: "conclusions", refs: [], conclusionIds: [chosen.id] };
  const request = buildRequestContext(output, target.id), material = request[0].content;
  assert.ok(material.includes("被用户验证的结论")); assert.ok(!material.includes("尚未确认的猜测"));
  assert.ok(!material.includes("未选择的独立结论")); assert.ok(!material.includes("共享原始依据"));
  assert.deepEqual(request.slice(1), target.messages.map(({ role, content }) => ({ role, content })));
  assert.equal(target.researchStatus, "exploring");
  chosen.status = "archived";
  assert.deepEqual(buildRequestContext(output, target.id), target.messages.map(({ role, content }) => ({ role, content })));
  chosen.status = "active"; target.contextPolicy.conclusionIds = [];
  assert.deepEqual(buildRequestContext(output, target.id), target.messages.map(({ role, content }) => ({ role, content })));
});

test("policy-aware branching never restores excluded history and preserves raw source anchors", () => {
  const { board, branch } = fixture();
  branch.contextPolicy = { mode: "selected", refs: [{ kind: "inherited", index: 1 }], conclusionIds: [] };
  const expected = buildRequestContext(board, branch.id);
  const child = createRequestBranch(board, { parentId: branch.id, quote: "新分支焦点" });
  assert.deepEqual(child.source.context, expected);
  assert.equal(child.source.messageId, branch.messages.at(-1).id);
  assert.equal(child.source.anchor.messageText, branch.messages.at(-1).content);
  assert.ok(!child.source.context.some((entry) => entry.content.includes("旧的问题")));
  child.messages.push(message("user", "新分支提问"));
  assert.deepEqual(buildRequestContext(board, child.id).slice(0, expected.length), expected);
  const atAnswer = createRequestBranch(board, { parentId: branch.id, messageId: branch.messages[1].id });
  assert.ok(!atAnswer.source.context.some((entry) => entry.content.includes("当前新问题")));
  assert.ok(!atAnswer.source.context.some((entry) => entry.content.includes("待选择的原始回答")));
});

test("policy-aware helper preserves full-mode pending focus behavior without changing snapshots", () => {
  const board = createBoard(), root = board.nodes[0]; root.messages.push(message("assistant", "完整历史"));
  const pending = createRequestBranch(board, { parentId: root.id, quote: "第一层聚焦" });
  const nested = createRequestBranch(board, { parentId: pending.id, quote: "第二层聚焦" });
  assert.deepEqual(nested.source.context, pending.source.context);
  assert.deepEqual(nested.source.focusTrail, ["第一层聚焦"]);
  assert.equal(buildRequestContext(board, nested.id).length, 2);
  pending.contextPolicy = { mode: "selected", refs: [], conclusionIds: [] };
  const selected = createRequestBranch(board, { parentId: pending.id, quote: "只保留新的焦点" });
  assert.deepEqual(selected.source.context, []); assert.deepEqual(selected.source.focusTrail, []);
});

test("board copies, subtree copies and imports remap conclusion citations and selected message/card IDs", () => {
  const { workspace, board, root, branch } = fixture();
  root.messages[0].material = { name: "notes.pdf", kind: "pdf", page: 3 };
  root.messages[0].usage = { inputTokens: 123, outputTokens: null, cachedInputTokens: 0 };
  const saved = saveConclusion(workspace, board, root, [item(root), item(branch, { citations: [{ nodeId: branch.id, contextIndex: 1, quote: "共享原始依据" }] })]);
  const original = saved.workspace.boards[0], conclusion = original.nodes.at(-1), source = original.nodes[0];
  source.contextPolicy = { mode: "conclusions", refs: [{ kind: "message", id: source.messages[0].id }], conclusionIds: [conclusion.id] };
  source.researchStatus = "adopted";
  const copied = duplicateBoard(saved.workspace, board.id).workspace.boards[1];
  const imported = mergeWorkspace(workspace, saved.workspace).boards[1];
  for (const output of [copied, imported]) {
    const copyRoot = output.nodes[0], copyBranch = output.nodes[1], copyConclusion = output.nodes.at(-1);
    assert.equal(copyRoot.researchStatus, "adopted");
    assert.equal(copyRoot.contextPolicy.refs[0].id, copyRoot.messages[0].id);
    assert.deepEqual(copyRoot.contextPolicy.conclusionIds, [copyConclusion.id]);
    assert.deepEqual(copyConclusion.conclusion.sourceNodeIds, [copyRoot.id]);
    assert.deepEqual(copyConclusion.conclusion.messageIds, [copyConclusion.messages[0].id]);
    assert.equal(copyConclusion.conclusion.items[0].citations[0].nodeId, copyRoot.id);
    assert.equal(copyConclusion.conclusion.items[0].citations[0].messageId, copyRoot.messages[0].id);
    assert.equal(copyConclusion.conclusion.items[1].citations[0].nodeId, copyBranch.id);
    assert.equal(copyConclusion.conclusion.items[1].citations[0].contextIndex, 1);
    assert.deepEqual(copyRoot.messages[0].material, root.messages[0].material);
    assert.deepEqual(copyRoot.messages[0].usage, root.messages[0].usage);
    copyRoot.messages[0].material.name = "changed.pdf";
    assert.equal(source.messages[0].material.name, "notes.pdf");
  }
  const subtree = duplicateSubtree(saved.workspace, { boardId: board.id, nodeId: root.id });
  const copyRoot = subtree.workspace.boards[0].nodes[3];
  assert.equal(copyRoot.contextPolicy.refs[0].id, copyRoot.messages[0].id);
  assert.deepEqual(copyRoot.contextPolicy.conclusionIds, [conclusion.id]);
});

test("conclusion provenance survives source purging and history restoration without live-ID requirements", () => {
  const { workspace, board, root } = fixture();
  const saved = saveConclusion(workspace, board, root, [item(root)]), conclusion = saved.workspace.boards[0].nodes.at(-1);
  const trashed = setNodeStatus(saved.workspace, { boardId: board.id, nodeId: root.id, status: "trashed" });
  const purged = purgeNode(trashed, { boardId: board.id, nodeId: root.id });
  assert.deepEqual(purged.boards[0].nodes[0].conclusion, conclusion.conclusion);
  const empty = structuredClone(saved.workspace); empty.boards[0].nodes.pop();
  const restored = restoreNodes(empty, { boardId: board.id, nodes: [conclusion] });
  assert.deepEqual(restored.boards[0].nodes.at(-1), conclusion);
});

test("summary evidence tracks content and connected relationships while ignoring movement, timestamps and summary churn", () => {
  const { board, branch } = fixture();
  const evidence = summaryEvidenceFingerprint(board, branch.id);
  branch.summary = { title: "分支摘要", text: "摘要正文", updatedAt: time, model: "test", fingerprint: "old-provider-hash", evidenceFingerprint: evidence };
  assert.equal(isSummaryStale(board, branch.id), false);
  const baseline = structuredClone(board);
  board.nodes[0].summary = { ...branch.summary, text: "关联摘要更新不形成相互失效循环" };
  branch.x += 800; branch.y -= 400; board.updatedAt = new Date().toISOString(); branch.summary.updatedAt = new Date().toISOString();
  assert.equal(summaryEvidenceFingerprint(board, branch.id), evidence);
  const unrelated = createNode(board, { title: "独立研究主题" }); unrelated.messages.push(message("user", "完全不相关"));
  assert.equal(summaryEvidenceFingerprint(board, branch.id), evidence);
  for (const change of [
    (b, n) => { n.messages[0].content += "真正的新内容"; },
    (b, n) => { n.source.context[0].content += "继承快照修订"; },
    (b, n) => { createNode(b, { parentId: n.id, title: "新增下游分支" }); },
    (b, n) => { n.researchStatus = "verify"; },
  ]) {
    const changed = structuredClone(baseline), node = changed.nodes.find((entry) => entry.id === branch.id); change(changed, node);
    assert.equal(isSummaryStale(changed, node.id), true);
  }
  delete branch.summary.evidenceFingerprint;
  assert.equal(isSummaryStale(board, branch.id), true);
  const normalized = validateWorkspace(wrap(baseline));
  assert.equal(normalized.boards[0].nodes.find((node) => node.id === branch.id).summary.evidenceFingerprint, evidence);
});

test("summary evidence does not duplicate merge baseline histories already represented in actual messages", () => {
  const { workspace, board, root, branch } = fixture();
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [branch.id], mode: "append", targetId: root.id });
  const output = merged.workspace.boards[0], target = output.nodes[0];
  const before = summaryEvidenceFingerprint(output, target.id);
  target.merges[0].context[0].content += "仅去重基线变化";
  assert.equal(summaryEvidenceFingerprint(output, target.id), before);
  target.messages.at(-1).content += "实际资料新增";
  assert.notEqual(summaryEvidenceFingerprint(output, target.id), before);
  assert.equal(researchFingerprint({ b: 2, a: [1, "x"] }), researchFingerprint({ a: [1, "x"], b: 2 }));
});
