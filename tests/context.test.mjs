import test from "node:test";
import assert from "node:assert/strict";
import { createBoard, createNode, newId, buildContext, validateWorkspace, resolveSourceAnchor } from "../shared/core.mjs";
import { mergeConversations, duplicateBoard, duplicateSubtree, setNodeStatus, purgeNode } from "../shared/operations.mjs";
import { mergeWorkspace } from "../shared/import.mjs";
import { restoreNodes } from "../shared/history.mjs";

const timestamp = "2026-10-18T00:00:00.000Z";
const message = (role, content) => ({ id: newId(), role, content, createdAt: timestamp });
const wrap = (board) => ({ version: 2, revision: 0, activeBoardId: board.id, boards: [board] });
const text = (messages) => messages.map((item) => item.content).join("\n");
function fixture() {
  const board = createBoard("保持原始上下文前缀");
  const root = board.nodes[0]; root.title = "主干";
  root.messages.push(message("user", "共同问题 one"), message("assistant", "共同回答 two"));
  const left = createNode(board, { parentId: root.id, title: "方案 A", quote: "左侧聚焦" });
  left.messages.push(message("user", "左侧问题 three"), message("assistant", "左侧回答 four"));
  const right = createNode(board, { parentId: root.id, title: "方案 B", quote: "右侧聚焦" });
  right.messages.push(message("user", "右侧问题 five"), message("assistant", "右侧回答 six"));
  return { board, root, left, right, workspace: wrap(board) };
}

test("fork keeps the exact requested history prefix and puts focus only inside its first own user turn", () => {
  const { board, root, left } = fixture();
  const prefix = root.messages.map(({ role, content }) => ({ role, content }));
  const result = buildContext(board, left.id);
  assert.deepEqual(result.slice(0, prefix.length), prefix);
  assert.equal(left.source.messageId, root.messages.at(-1).id);
  assert.equal(left.source.contextMode, "tail-focus");
  assert.equal(result[2].role, "user");
  assert.match(result[2].content, /左侧聚焦[\s\S]*左侧问题 three/);
  assert.equal(left.messages[0].content, "左侧问题 three");
  assert.equal(result.filter((entry) => entry.role === "system").length, 0);
  root.messages.push(message("assistant", "future changes must not enter"));
  assert.deepEqual(buildContext(board, left.id), result);
  assert.equal(resolveSourceAnchor(board, left.id).messageId, root.messages[1].id);
});

test("nested forks capture the actual focused request prefix without duplicating focus", () => {
  const { board, left } = fixture();
  const parentContext = buildContext(board, left.id);
  const nested = createNode(board, { parentId: left.id, quote: "深入追问" });
  assert.deepEqual(nested.source.context, parentContext);
  nested.messages.push(message("user", "嵌套问题"));
  const context = buildContext(board, nested.id);
  assert.deepEqual(context.slice(0, parentContext.length), parentContext);
  assert.equal(text(context).split("左侧聚焦").length - 1, 1);
  assert.equal(text(context).split("深入追问").length - 1, 1);
  const firstOwn = left.messages[0];
  const atQuestion = createNode(board, { parentId: left.id, messageId: firstOwn.id, quote: "另一个角度" });
  assert.deepEqual(atQuestion.source.context, parentContext.slice(0, -1));
  assert.equal(atQuestion.source.anchor.messageText, firstOwn.content);
  assert.equal(resolveSourceAnchor(board, atQuestion).resolved, true);
});

test("explicit fixed focus keeps full UI quotes while preserving old fork prompts and immutable nested prefixes", () => {
  const board = createBoard(); const root = board.nodes[0];
  const table = "名称 | 结果\n" + "完整表格中的长行 | 完整实验数值\n".repeat(200);
  root.messages.push(message("assistant", `说明\n${table}`));
  const focusText = "继承快照最后一条消息中的第 1 个表格；首行：名称 | 结果";
  const compact = createNode(board, { parentId: root.id, quote: table, anchor: { kind: "table", blockIndex: 0 }, focusText });
  compact.messages.push(message("user", "比较结果"), message("assistant", "比较完成"));
  const context = buildContext(board, compact.id);
  assert.equal(compact.source.quote, table.trim());
  assert.equal(compact.source.focusText, focusText);
  assert.deepEqual(context.slice(0, 1), root.messages.map(({ role, content }) => ({ role, content })));
  assert.ok(context[1].content.includes(focusText));
  assert.ok(!context[1].content.includes("完整实验数值"));
  assert.equal(text(context).split("完整实验数值").length - 1, 200);
  const nested = createNode(board, { parentId: compact.id, quote: "再比较一组" });
  nested.messages.push(message("user", "嵌套提问"));
  assert.deepEqual(nested.source.context, context);
  assert.deepEqual(buildContext(board, nested.id).slice(0, context.length), context);
  assert.equal(text(buildContext(board, nested.id)).split(focusText).length - 1, 1);

  const old = createNode(board, { parentId: root.id, quote: table, anchor: { kind: "table", blockIndex: 0 } });
  old.messages.push(message("user", "原有聚焦问题"));
  const previous = buildContext(board, old.id);
  const normalized = validateWorkspace(wrap(board));
  const oldNormalized = normalized.boards[0].nodes.find((node) => node.id === old.id);
  assert.equal(Object.hasOwn(oldNormalized.source, "focusText"), false);
  assert.deepEqual(buildContext(normalized.boards[0], old.id), previous);
  assert.ok(previous[1].content.includes(table.trim()));
  for (const invalid of [null, 4, "x".repeat(100001)]) {
    const bad = structuredClone(normalized);
    bad.boards[0].nodes.find((node) => node.id === compact.id).source.focusText = invalid;
    assert.throws(() => validateWorkspace(bad), /分支聚焦文本/);
  }
});

test("fixed pending image focus propagates once without adding a virtual sent turn to child snapshots", () => {
  const board = createBoard(); const root = board.nodes[0];
  const imageUrl = "https://example.invalid/source.png";
  root.messages.push(message("assistant", `![完整图片说明](${imageUrl})`));
  const focusText = `继承快照最后一条消息中的第 1 张图片：${imageUrl}`;
  const pending = createNode(board, { parentId: root.id, quote: "完整图片说明", anchor: { kind: "image", blockIndex: 0, imageUrl }, focusText });
  const nested = createNode(board, { parentId: pending.id, quote: "第二层关注点" });
  assert.deepEqual(nested.source.focusTrail, [focusText]);
  assert.deepEqual(nested.source.context, pending.source.context);
  nested.messages.push(message("user", "真实问题"));
  const context = buildContext(board, nested.id);
  assert.equal(context.length, 2);
  assert.equal(text(context).split(focusText).length - 1, 1);
  assert.ok(!context[1].content.includes("完整图片说明"));
  assert.equal(text(context).split("第二层关注点").length - 1, 1);
  assert.equal(pending.source.quote, "完整图片说明");
});

test("forking before the first user turn propagates pending focus without storing a virtual sent message", () => {
  const board = createBoard(); const root = board.nodes[0];
  root.messages.push(message("assistant", "原始资料"));
  const pending = createNode(board, { parentId: root.id, quote: "第一次聚焦" });
  assert.equal(buildContext(board, pending.id).length, 2);
  const nested = createNode(board, { parentId: pending.id, quote: "第二次聚焦" });
  assert.deepEqual(nested.source.context, pending.source.context);
  assert.equal(nested.source.messageId, null);
  nested.messages.push(message("user", "真正发送的问题"));
  const actual = buildContext(board, nested.id);
  assert.equal(actual.length, 2);
  for (const focus of ["第一次聚焦", "第二次聚焦", "真正发送的问题"]) assert.equal(text(actual).split(focus).length - 1, 1);
  const resolved = resolveSourceAnchor(board, nested);
  assert.equal(resolved.resolved, false); assert.equal(resolved.reason, "inherited");
  assert.equal(resolved.contextIndex, 0);
});

test("legacy context remains byte-identical while historical null anchors match the snapshot rather than the latest message", () => {
  const { board, root, left } = fixture();
  const rawSnapshot = structuredClone(left.source.context);
  left.source = { messageId: null, quote: "旧聚焦", context: rawSnapshot };
  const expected = [...rawSnapshot, { role: "system", content: "这个分支聚焦以下选中的内容。请结合已有对话，围绕它继续讨论：\n\n旧聚焦" }, ...left.messages.map(({ role, content }) => ({ role, content }))];
  const legacy = validateWorkspace({ ...wrap(board), version: 1 });
  const normalized = legacy.boards[0].nodes.find((node) => node.id === left.id);
  assert.equal(normalized.source.contextMode, "legacy");
  assert.deepEqual(normalized.source.context, rawSnapshot);
  assert.deepEqual(buildContext(legacy.boards[0], left.id), expected);
  root.messages.push(message("user", "之后才出现的新消息"));
  assert.equal(resolveSourceAnchor(board, left).messageId, root.messages[1].id);
  const nested = createNode(board, { parentId: left.id, quote: "新的尾部聚焦" });
  assert.deepEqual(nested.source.context, expected);
  assert.equal(text(buildContext(board, nested.id)).split("旧聚焦").length - 1, 1);
});

test("stable rich anchors roundtrip and an edited or deleted source never resolves by ID alone", () => {
  const { board, root } = fixture();
  for (const kind of ["text", "table", "image", "after"]) {
    const branch = createNode(board, { parentId: root.id, messageId: root.messages[1].id,
      quote: "选中的局部", anchor: { kind, occurrence: 1, blockIndex: 2, imageUrl: "https://example.invalid/original.png" } });
    const normalized = validateWorkspace(wrap(board)).boards[0].nodes.find((node) => node.id === branch.id);
    assert.deepEqual(normalized.source.anchor, branch.source.anchor);
    assert.equal(resolveSourceAnchor(board, branch).resolved, true);
  }
  const branch = board.nodes.at(-1);
  root.messages[1].content = "原消息被修改";
  assert.equal(resolveSourceAnchor(board, branch).reason, "edited");
  assert.equal(resolveSourceAnchor(board, branch).resolved, false);
  root.messages.pop();
  assert.equal(resolveSourceAnchor(board, branch).reason, "missing");
});

test("new merge retains primary request roles and bytes and appends only secondary deltas as user data", () => {
  const { workspace, board, left, right } = fixture();
  left.source.focusText = "主干固定聚焦，不在合并中重复";
  right.source.contextMode = "legacy";
  const prefix = buildContext(board, left.id);
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id, right.id] });
  const output = merged.workspace.boards[0], node = output.nodes.find((entry) => entry.id === merged.nodeId);
  const context = buildContext(output, node.id);
  assert.deepEqual(context.slice(0, prefix.length), prefix);
  assert.deepEqual(node.source.context, prefix);
  assert.equal(Object.hasOwn(node.source, "focusText"), false);
  assert.equal(text(context).split(left.source.focusText).length - 1, 1);
  assert.equal(node.messages.length, 1);
  assert.equal(node.messages[0].role, "user");
  assert.match(node.messages[0].content, /原始角色 system/);
  assert.ok(!node.messages[0].content.includes("共同问题 one"));
  for (const phrase of ["共同问题 one", "共同回答 two", "左侧问题 three", "右侧问题 five", "右侧回答 six"])
    assert.equal(text(context).split(phrase).length - 1, 1, phrase);
  assert.equal(node.merges[0].nodeId, right.id);
  assert.deepEqual(node.merges[0].context, buildContext(board, right.id));
});

test("append preserves original messages and request prefix, deduplicates repeated snapshots and imports later growth only", () => {
  const { workspace, board, left, right } = fixture();
  const originalMessages = structuredClone(left.messages), originalPrefix = buildContext(board, left.id);
  const first = mergeConversations(workspace, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  const target = first.workspace.boards[0].nodes.find((node) => node.id === left.id);
  assert.equal(first.nodeId, left.id); assert.equal(first.changed, true);
  assert.deepEqual(target.messages.slice(0, originalMessages.length), originalMessages);
  assert.deepEqual(buildContext(first.workspace.boards[0], left.id).slice(0, originalPrefix.length), originalPrefix);
  assert.deepEqual(target.mergeParents, left.mergeParents);
  const repeated = mergeConversations(first.workspace, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  assert.equal(repeated.changed, false); assert.deepEqual(repeated.workspace, first.workspace);
  const growing = structuredClone(first.workspace);
  growing.boards[0].nodes.find((node) => node.id === right.id).messages.push(message("user", "真正新增的来源问题"), message("assistant", "真正新增的来源结论"));
  const next = mergeConversations(growing, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  const updated = next.workspace.boards[0].nodes.find((node) => node.id === left.id);
  assert.deepEqual(updated.messages.slice(0, target.messages.length), target.messages);
  assert.ok(updated.messages.at(-1).content.includes("真正新增的来源结论"));
  assert.ok(!updated.messages.at(-1).content.includes("右侧回答 six"));
  assert.equal(text(updated.messages).split("右侧回答 six").length - 1, 1);
  assert.equal(updated.merges.length, 1);
  assert.equal(updated.merges[0].messageIds.length, 2);
});

test("source rewrites are appended as new evidence without discarding already merged history", () => {
  const { workspace, board, left, right } = fixture();
  const first = mergeConversations(workspace, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  first.workspace.boards[0].nodes.find((node) => node.id === right.id).messages[1].content = "改写后的来源结论";
  const next = mergeConversations(first.workspace, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  const target = next.workspace.boards[0].nodes.find((node) => node.id === left.id);
  assert.ok(text(target.messages).includes("右侧回答 six"));
  assert.ok(text(target.messages).includes("改写后的来源结论"));
});

test("append is a no-op for fully represented source prefixes and excludes them from mixed-source material", () => {
  const { workspace, board, root, left, right } = fixture();
  const baseline = validateWorkspace(workspace);
  const noDifference = mergeConversations(workspace, { boardId: board.id, nodeIds: [root.id], mode: "append", targetId: left.id });
  assert.equal(noDifference.changed, false);
  assert.deepEqual(noDifference.workspace, baseline);
  const mixed = mergeConversations(workspace, { boardId: board.id, nodeIds: [root.id, right.id], mode: "append", targetId: left.id });
  const target = mixed.workspace.boards[0].nodes.find((node) => node.id === left.id);
  assert.equal(mixed.changed, true);
  assert.deepEqual(target.merges.map((record) => record.nodeId), [right.id]);
  assert.ok(target.messages.at(-1).content.includes("右侧回答 six"));
  assert.ok(!target.messages.at(-1).content.includes(`【合并来源：${root.title}（ID: ${root.id}）】`));
});

test("source shrinking and later regrowth do not repeat previously imported trailing evidence", () => {
  const { workspace, board, left, right } = fixture();
  const first = mergeConversations(workspace, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  const shrunk = structuredClone(first.workspace);
  const source = shrunk.boards[0].nodes.find((node) => node.id === right.id);
  const last = source.messages.pop();
  const unchanged = mergeConversations(shrunk, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  assert.equal(unchanged.changed, false);
  source.messages.push(last, message("user", "重新生长的新问题"));
  const grown = mergeConversations(shrunk, { boardId: board.id, nodeIds: [right.id], mode: "append", targetId: left.id });
  const target = grown.workspace.boards[0].nodes.find((node) => node.id === left.id);
  assert.ok(target.messages.at(-1).content.includes("重新生长的新问题"));
  assert.ok(!target.messages.at(-1).content.includes("右侧回答 six"));
});

test("append accepts ancestor and descendant sources without adding graph cycles, and source deletion keeps merge evidence", () => {
  const { workspace, board, root, left } = fixture();
  const descendant = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id], mode: "append", targetId: root.id });
  const ancestor = mergeConversations(descendant.workspace, { boardId: board.id, nodeIds: [root.id], mode: "append", targetId: left.id });
  validateWorkspace(ancestor.workspace);
  assert.deepEqual(ancestor.workspace.boards[0].nodes.find((node) => node.id === root.id).mergeParents, []);
  const before = structuredClone(descendant.workspace.boards[0].nodes[0].merges);
  const trashed = setNodeStatus(descendant.workspace, { boardId: board.id, nodeId: left.id, status: "trashed" });
  const purged = purgeNode(trashed, { boardId: board.id, nodeId: left.id });
  assert.deepEqual(purged.boards[0].nodes[0].merges, before);
  assert.ok(text(purged.boards[0].nodes[0].messages).includes("左侧回答 four"));
});

test("copy, import and history restore remap merge/source IDs while keeping independent snapshots and anchor details", () => {
  const { workspace, board, root, left, right } = fixture();
  left.source.focusText = "固定聚焦引用";
  const merged = mergeConversations(workspace, { boardId: board.id, nodeIds: [left.id, right.id] });
  const node = merged.workspace.boards[0].nodes.at(-1);
  const copied = duplicateBoard(merged.workspace, board.id).workspace.boards[1];
  const imported = mergeWorkspace(workspace, merged.workspace).boards[1];
  for (const copy of [copied, imported]) {
    const copyMerge = copy.nodes.at(-1);
    assert.equal(copyMerge.merges[0].nodeId, copy.nodes[2].id);
    assert.equal(copyMerge.merges[0].messageIds[0], copyMerge.messages[0].id);
    assert.equal(copyMerge.source.messageId, copy.nodes[1].messages.at(-1).id);
    assert.deepEqual(copyMerge.source.anchor, node.source.anchor);
    assert.deepEqual(copyMerge.merges[0].context, node.merges[0].context);
    assert.equal(copy.nodes[1].source.focusText, left.source.focusText);
    assert.equal(Object.hasOwn(copy.nodes[2].source, "focusText"), false);
  }
  const subtree = duplicateSubtree(merged.workspace, { boardId: board.id, nodeId: root.id });
  const copiedNodes = subtree.workspace.boards[0].nodes.slice(4);
  assert.equal(copiedNodes.at(-1).merges[0].nodeId, copiedNodes[2].id);
  assert.equal(copiedNodes[1].source.focusText, left.source.focusText);
  const rest = structuredClone(merged.workspace); rest.boards[0].nodes.pop();
  assert.deepEqual(restoreNodes(rest, { boardId: board.id, nodes: [node] }).boards[0].nodes.at(-1), node);
  const withoutLeft = structuredClone(workspace); withoutLeft.boards[0].nodes = [root, right];
  assert.equal(restoreNodes(withoutLeft, { boardId: board.id, nodes: [left] }).boards[0].nodes.at(-1).source.focusText, left.source.focusText);
  copied.nodes.at(-1).merges[0].context[0].content = "改副本";
  assert.notEqual(node.merges[0].context[0].content, "改副本");
});

test("token usage is optional, preserves unknown counts as null, and rejects invalid measurements", () => {
  const { workspace, board, root } = fixture();
  root.messages[1].usage = { inputTokens: 0, outputTokens: 12, cachedInputTokens: null };
  const result = validateWorkspace(workspace);
  assert.equal(Object.hasOwn(result.boards[0].nodes[0].messages[0], "usage"), false);
  assert.deepEqual(result.boards[0].nodes[0].messages[1].usage, root.messages[1].usage);
  assert.deepEqual(buildContext(board, root.id), root.messages.map(({ role, content }) => ({ role, content })));
  for (const bad of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, NaN, "12"]) {
    const invalid = structuredClone(workspace); invalid.boards[0].nodes[0].messages[1].usage.inputTokens = bad;
    assert.throws(() => validateWorkspace(invalid), /用量/);
  }
});
