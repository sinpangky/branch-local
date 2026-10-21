// Shared workspace operations. Keep this module usable in both Node and a browser.
import { validateAgentRun } from "./agent.mjs";

export const LIMITS = Object.freeze({
  boards: 100,
  nodes: 2000,
  messages: 20000,
  contextMessages: 20000,
  contentLength: 100000,
  totalTextLength: 10000000,
  titleLength: 160,
});

export const CARD_SIZE = Object.freeze({
  width: 320,
  height: 248,
  minWidth: 260,
  minHeight: 220,
  maxWidth: 960,
  maxHeight: 800,
});

export function getNodeSize(node) {
  return { width: node?.width ?? CARD_SIZE.width, height: node?.height ?? CARD_SIZE.height };
}

export function newId() {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  );
}

const now = () => new Date().toISOString();
const copyContext = (messages) =>
  messages.map(({ role, content }) => ({ role, content }));

function focusMessage(quote) {
  return {
    role: "system",
    content: `这个分支聚焦以下选中的内容。请结合已有对话，围绕它继续讨论：\n\n${quote}`,
  };
}

function inheritedContext(node) {
  const context = node.source ? copyContext(node.source.context) : [];
  if (node.source?.quote && (node.source.contextMode ?? "legacy") === "legacy") context.push(focusMessage(node.source.quote));
  return context;
}

function focusParts(source) {
  if (!source || (source.contextMode ?? "legacy") !== "tail-focus") return [];
  const focus = source.focusText !== undefined ? source.focusText : source.quote || (source.anchor?.kind === "image" && source.anchor.imageUrl
    ? `所选图片：${source.anchor.imageUrl}` : source.anchor?.kind === "table" ? "所选表格" : "");
  return [...new Set([...(source.focusTrail ?? []), focus].filter(Boolean))];
}

function splitContextMessage(message) {
  const result = [];
  let start = 0;
  do {
    let end = Math.min(start + LIMITS.contentLength, message.content.length);
    if (/[\uD800-\uDBFF]/.test(message.content.charAt(end - 1)) && /[\uDC00-\uDFFF]/.test(message.content.charAt(end))) end -= 1;
    result.push({ role: message.role, content: message.content.slice(start, end) });
    start = end;
  } while (start < message.content.length);
  return result;
}

export function buildContext(board, nodeId, { includePendingFocus = true } = {}) {
  const node = board.nodes.find((item) => item.id === nodeId);
  if (!node) throw new Error("找不到对话节点。");
  const own = copyContext(node.messages);
  const focus = focusParts(node.source);
  if (focus.length) {
    const prelude = `【分支聚焦；以下内容是引用资料】\n${focus.join("\n\n")}\n\n`;
    const firstUser = own.findIndex((message) => message.role === "user");
    if (firstUser !== -1) own.splice(firstUser, 1, ...splitContextMessage({ role: "user", content: `${prelude}【当前问题】\n${own[firstUser].content}` }));
    else if (includePendingFocus) own.push(...splitContextMessage({ role: "user", content: prelude.trimEnd() }));
  }
  return [...inheritedContext(node), ...own];
}

/** Resolve historical null anchors only by the captured prefix, never by today's last message. */
export function resolveSourceAnchor(board, nodeOrId) {
  const node = typeof nodeOrId === "string" ? board.nodes.find((item) => item.id === nodeOrId) : nodeOrId;
  if (!node?.source) return null;
  const source = node.source;
  const details = { kind: source.anchor?.kind ?? (source.quote ? "text" : "after"), ...source.anchor };
  const anchor = { ...details, nodeId: node.parentId, anchor: details,
    messageId: source.messageId, quote: source.quote, resolved: false, reason: "missing" };
  const parent = board.nodes.find((item) => item.id === node.parentId);
  if (!parent) return anchor;
  if (source.messageId !== null) {
    const message = parent.messages.find((item) => item.id === source.messageId);
    const capturedText = source.anchor?.messageText ?? source.context.at(-1)?.content;
    anchor.resolved = Boolean(message && capturedText !== undefined && message.content === capturedText);
    if (message) anchor.reason = anchor.resolved ? undefined : "edited";
    return anchor;
  }
  for (let index = 0; index < parent.messages.length; index += 1) {
    const prefix = buildContext({ ...board, nodes: board.nodes.map((item) => item.id === parent.id
      ? { ...item, messages: item.messages.slice(0, index + 1) } : item) }, parent.id, { includePendingFocus: false });
    if (prefix.length === source.context.length && prefix.every((entry, at) => entry.role === source.context[at].role && entry.content === source.context[at].content))
      return { ...anchor, messageId: parent.messages[index].id, resolved: true, reason: undefined };
  }
  return { ...anchor, reason: source.context.length ? "inherited" : "empty",
    ...(source.context.length ? { contextIndex: source.anchor?.contextIndex ?? source.context.length - 1 } : {}) };
}

export function createNode(
  board,
  { parentId = null, messageId = null, quote = "", title = "", anchor = null, focusText } = {},
) {
  let parent = null;
  let source = null;
  if (parentId !== null) {
    parent = board.nodes.find((node) => node.id === parentId);
    if (!parent) throw new Error("找不到分支的父节点。");
    const lastIndex =
      messageId === null
        ? parent.messages.length - 1
        : parent.messages.findIndex((message) => message.id === messageId);
    if (messageId !== null && lastIndex === -1)
      throw new Error("选中的消息不属于父节点。");
    source = {
      messageId: parent.messages[lastIndex]?.id ?? null,
      quote: String(quote).trim(),
      ...(focusText !== undefined ? { focusText: textValue(focusText, "分支聚焦文本", LIMITS.contentLength) } : {}),
      contextMode: "tail-focus",
      anchor: { kind: quote ? "text" : "after", ...anchor,
        ...(parent.messages[lastIndex] ? { messageText: parent.messages[lastIndex].content }
          : parent.source?.context.length ? { contextIndex: parent.source.context.length - 1 } : {}) },
      focusTrail: parent.messages.slice(0, lastIndex + 1).some((message) => message.role === "user") ? [] : focusParts(parent.source),
      context: buildContext({ ...board, nodes: board.nodes.map((item) => item.id === parent.id
        ? { ...item, messages: item.messages.slice(0, lastIndex + 1) } : item) }, parent.id, { includePendingFocus: false }),
    };
  } else if (messageId !== null || quote) {
    throw new Error("引用消息或选中文字需要父节点。");
  }
  const siblings = board.nodes.filter((node) => node.parentId === parentId);
  const parentSize = getNodeSize(parent);
  const siblingOffset = siblings.reduce((offset, sibling) =>
    offset + Math.max(parent ? parentSize.height : 0, getNodeSize(sibling).height) + 52, 0);
  const node = {
    id: newId(),
    parentId,
    mergeParents: [],
    merges: [],
    status: "active",
    researchStatus: "exploring",
    contextPolicy: { mode: "full", refs: [], conclusionIds: [] },
    executionMode: "chat",
    kind: "conversation",
    conclusion: null,
    archivedAt: null,
    deletedAt: null,
    summary: null,
    width: CARD_SIZE.width,
    height: CARD_SIZE.height,
    title: (
      title.trim() ||
      source?.quote.slice(0, 28) ||
      (parent ? "新的分支" : "新的对话")
    ).slice(0, LIMITS.titleLength),
    x: parent ? parent.x + parentSize.width + 140 : 80,
    y: (parent ? parent.y : 120) + siblingOffset,
    messages: [],
    source,
    draft: "",
  };
  board.nodes.push(node);
  board.updatedAt = now();
  return node;
}

function demoMessage(role, content) {
  return { id: newId(), role, content, createdAt: now() };
}

export function createBoard(title = "新的探索", { demo = false } = {}) {
  const timestamp = now();
  const board = {
    id: newId(),
    title: title.trim().slice(0, LIMITS.titleLength) || "新的探索",
    createdAt: timestamp,
    updatedAt: timestamp,
    status: "active",
    archivedAt: null,
    deletedAt: null,
    nodes: [],
    viewport: { x: 50, y: 120, zoom: 1 },
  };
  const root = createNode(board, {
    title: demo ? "把一个问题，展开成多条思路" : "新的对话",
  });
  if (demo) {
    root.messages.push(
      demoMessage(
        "user",
        "我想理解：为什么在对话中建立分支，会比一直向下追问更有帮助？",
      ),
      demoMessage(
        "assistant",
        "这是内置演示内容，尚未调用 AI 模型。\n\n分支让不同思路保留各自的上下文，你可以回到同一个起点，比较不同的解法。\n\n选中回答中的一句话，就能围绕这句话建立分支，不会把后续问题混进来。\n\n试试打开两条分支，或在回答中选中文字，展开你自己的思路。",
      ),
    );
    const compare = createNode(board, {
      parentId: root.id,
      messageId: root.messages[1].id,
      quote: "比较不同的解法",
      title: "比较不同的解法",
    });
    compare.messages.push(
      demoMessage("user", "举一个分支比较解法的例子。"),
      demoMessage(
        "assistant",
        "演示：从“如何保存数据”这个问题出发，一条分支研究本地文件，另一条研究数据库。每条分支可以独立深入，同时保留共同的起点。此回答是示例，未调用模型。",
      ),
    );
    const context = createNode(board, {
      parentId: root.id,
      messageId: root.messages[1].id,
      quote: "不会把后续问题混进来",
      title: "分支如何继承上下文？",
    });
    context.messages.push(
      demoMessage("user", "新分支会继承哪些内容？"),
      demoMessage(
        "assistant",
        "演示：新分支会保存父对话截至所选消息的上下文快照，并记录你选中的文字。父对话之后的新消息和其他分支不会混入；以后修改父对话也不会改变这份快照。此回答是示例，未调用模型。",
      ),
    );
    arrangeBoard(board);
  }
  return board;
}

export function createWorkspace() {
  const board = createBoard("欢迎来到分支画布", { demo: true });
  return { version: 2, revision: 0, activeBoardId: board.id, boards: [board] };
}

export function arrangeBoard(board) {
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  if (byId.size !== board.nodes.length)
    throw new Error("无法排列：节点 ID 重复。");
  const children = new Map(board.nodes.map((node) => [node.id, []]));
  const roots = [];
  for (const node of board.nodes) {
    if (node.parentId === null) roots.push(node);
    else {
      if (!children.has(node.parentId))
        throw new Error("无法排列：父节点不存在。");
      children.get(node.parentId).push(node);
    }
  }
  const order = [];
  const stack = roots.map((node) => ({ node, depth: 0 })).reverse();
  while (stack.length) {
    const { node, depth } = stack.pop();
    order.push({ node, depth });
    for (const child of [...children.get(node.id)].reverse())
      stack.push({ node: child, depth: depth + 1 });
  }
  if (order.length !== byId.size) throw new Error("无法排列：节点存在循环。");
  const spans = new Map();
  const slotHeights = new Map();
  const columnWidths = new Map();
  for (const { node, depth } of order) {
    const { width, height } = getNodeSize(node);
    slotHeights.set(node.id, height + 92);
    columnWidths.set(depth, Math.max(columnWidths.get(depth) ?? 0, width));
  }
  for (let index = order.length - 1; index >= 0; index -= 1) {
    const { node } = order[index];
    spans.set(
      node.id,
      Math.max(
        slotHeights.get(node.id),
        children
          .get(node.id)
          .reduce((total, child) => total + spans.get(child.id), 0),
      ),
    );
  }
  let next = 0;
  const starts = new Map();
  for (const root of roots) {
    starts.set(root.id, next);
    next += spans.get(root.id) + 136;
  }
  const columns = [80];
  for (let depth = 0; depth < columnWidths.size; depth += 1)
    columns.push(columns[depth] + columnWidths.get(depth) + 140);
  for (const { node, depth } of order) {
    const start = starts.get(node.id);
    node.x = columns[depth];
    node.y = 100 + start + (spans.get(node.id) - slotHeights.get(node.id)) / 2;
    const childHeight = children.get(node.id).reduce((total, child) => total + spans.get(child.id), 0);
    let childStart = start + (spans.get(node.id) - childHeight) / 2;
    for (const child of children.get(node.id)) {
      starts.set(child.id, childStart);
      childStart += spans.get(child.id);
    }
  }
  return board;
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);

// Inspect descriptors before reading values, so imported accessors never run.
function inspectPayload(value, state, depth = 0) {
  if (typeof value === "string") {
    state.text += value.length;
    if (state.text > LIMITS.totalTextLength) throw new Error("导入内容过大。");
    return;
  }
  if (value === null || typeof value === "boolean" || typeof value === "number")
    return;
  if (typeof value !== "object" || depth > 16)
    throw new Error("导入数据包含不支持的值或嵌套过深。");
  if (state.seen.has(value))
    throw new Error("导入数据包含循环或重复对象引用。");
  state.seen.add(value);
  const proto = Object.getPrototypeOf(value);
  if (
    Array.isArray(value)
      ? proto !== Array.prototype
      : proto !== Object.prototype && proto !== null
  )
    throw new Error("导入数据必须是普通 JSON 对象。");
  const keys = Reflect.ownKeys(value);
  if (keys.length > LIMITS.contextMessages + 1)
    throw new Error("导入数据数组或对象过大。");
  state.values += keys.length;
  if (state.values > 500000) throw new Error("导入数据过大。");
  for (const key of keys) {
    if (typeof key !== "string" || forbiddenKeys.has(key))
      throw new Error("导入数据包含非法属性。");
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!Object.hasOwn(descriptor, "value"))
      throw new Error("导入数据不能包含访问器。");
    if (Array.isArray(value) && key === "length") continue;
    inspectPayload(descriptor.value, state, depth + 1);
  }
}

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${label}格式错误。`);
  return value;
}

function textValue(value, label, maxLength, { empty = true } = {}) {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    (!empty && !value.trim())
  )
    throw new Error(`${label}为空、过长或格式错误。`);
  return value;
}

function idValue(value, label) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value))
    throw new Error(`${label}格式错误。`);
  return value;
}

function numberValue(value, label, min = -10000000, max = 10000000) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  )
    throw new Error(`${label}必须是有效数值。`);
  return value;
}

function timestampValue(value, label) {
  if (
    typeof value !== "string" ||
    value.length > 40 ||
    !Number.isFinite(Date.parse(value))
  )
    throw new Error(`${label}格式错误。`);
  return new Date(value).toISOString();
}

function arrayValue(value, label, max) {
  if (!Array.isArray(value) || value.length > max)
    throw new Error(`${label}格式错误或数量过大。`);
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw new Error(`${label}不能包含空槽。`);
  }
  return value;
}

function lifecycleValue(raw, label) {
  const status = raw.status === undefined ? "active" : raw.status;
  if (!["active", "archived", "trashed"].includes(status))
    throw new Error(`${label}状态无效。`);
  return {
    status,
    archivedAt: raw.archivedAt == null ? null : timestampValue(raw.archivedAt, `${label}归档时间`),
    deletedAt: raw.deletedAt == null ? null : timestampValue(raw.deletedAt, `${label}删除时间`),
  };
}

function summaryValue(value) {
  if (value == null) return null;
  record(value, "会话总结");
  return {
    title: textValue(value.title, "总结标题", 80, { empty: false }),
    text: textValue(value.text, "总结正文", 1000),
    updatedAt: timestampValue(value.updatedAt, "总结时间"),
    model: textValue(value.model, "总结模型", 256),
    fingerprint: textValue(value.fingerprint, "总结指纹", 128),
    ...(value.evidenceFingerprint !== undefined
      ? { evidenceFingerprint: textValue(value.evidenceFingerprint, "总结证据指纹", 128) } : {}),
  };
}

function materialValue(value) {
  record(value, "导入资料");
  if (!["markdown", "pdf"].includes(value.kind)) throw new Error("导入资料类型无效。");
  const material = { name: textValue(value.name, "资料名称", 256, { empty: false }), kind: value.kind };
  if (value.page !== undefined) {
    material.page = numberValue(value.page, "资料页码", 1, Number.MAX_SAFE_INTEGER);
    if (!Number.isSafeInteger(material.page)) throw new Error("资料页码必须是正整数。");
  }
  return material;
}

function contextPolicyValue(value) {
  if (value === undefined) return { mode: "full", refs: [], conclusionIds: [] };
  record(value, "上下文策略");
  if (!["full", "conclusions", "selected"].includes(value.mode)) throw new Error("上下文策略无效。");
  const seen = new Set();
  const refs = arrayValue(value.refs, "上下文选择", LIMITS.contextMessages).map((raw) => {
    record(raw, "上下文选择项");
    let ref;
    if (raw.kind === "message") ref = { kind: "message", id: idValue(raw.id, "上下文消息 ID") };
    else if (raw.kind === "inherited") {
      const index = numberValue(raw.index, "继承上下文序号", 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(index)) throw new Error("继承上下文序号必须是非负整数。");
      ref = { kind: "inherited", index };
    } else throw new Error("上下文选择类型无效。");
    const key = JSON.stringify(ref);
    if (seen.has(key)) throw new Error("上下文选择不能重复。");
    seen.add(key);
    return ref;
  });
  const conclusionIds = arrayValue(value.conclusionIds === undefined ? [] : value.conclusionIds, "上下文结论卡", LIMITS.nodes)
    .map((id) => idValue(id, "上下文结论卡 ID"));
  if (new Set(conclusionIds).size !== conclusionIds.length) throw new Error("上下文结论卡不能重复。");
  return { mode: value.mode, refs, conclusionIds };
}

function conclusionValue(value) {
  if (value == null) return null;
  record(value, "结论");
  const ids = new Set();
  const items = arrayValue(value.items, "结论条目", 200).map((raw) => {
    record(raw, "结论条目");
    const id = idValue(raw.id, "结论条目 ID");
    if (ids.has(id)) throw new Error("结论条目 ID 不能重复。");
    ids.add(id);
    if (!["agreement", "difference", "basis", "open", "conclusion"].includes(raw.category)) throw new Error("结论条目分类无效。");
    const citations = arrayValue(raw.citations, "结论引文", 200).map((citation) => {
      record(citation, "结论引文");
      const result = { nodeId: idValue(citation.nodeId, "引文会话 ID"), quote: textValue(citation.quote, "引文原文", LIMITS.contentLength) };
      if (citation.messageId !== undefined) result.messageId = idValue(citation.messageId, "引文消息 ID");
      if (citation.contextIndex !== undefined) {
        result.contextIndex = numberValue(citation.contextIndex, "引文继承序号", 0, Number.MAX_SAFE_INTEGER);
        if (!Number.isSafeInteger(result.contextIndex)) throw new Error("引文继承序号必须是非负整数。");
      }
      if (result.messageId !== undefined && result.contextIndex !== undefined) throw new Error("引文不能同时指定消息和继承序号。");
      return result;
    });
    for (const key of ["verified", "adopted"]) if (raw[key] !== undefined && typeof raw[key] !== "boolean") throw new Error("结论确认状态必须是布尔值。");
    return { id, text: textValue(raw.text, "结论内容", 10000, { empty: false }), category: raw.category,
      citations, verified: raw.verified ?? false, adopted: raw.adopted ?? false };
  });
  const sourceNodeIds = arrayValue(value.sourceNodeIds, "结论来源", LIMITS.nodes).map((id) => idValue(id, "结论来源 ID"));
  if (new Set(sourceNodeIds).size !== sourceNodeIds.length) throw new Error("结论来源不能重复。");
  const messageIds = arrayValue(value.messageIds === undefined ? [] : value.messageIds, "结论正文消息", LIMITS.messages)
    .map((id) => idValue(id, "结论正文消息 ID"));
  if (new Set(messageIds).size !== messageIds.length) throw new Error("结论正文消息不能重复。");
  return { items, sourceNodeIds, messageIds, createdAt: timestampValue(value.createdAt, "结论时间"),
    model: textValue(value.model, "结论模型", 256), fingerprint: textValue(value.fingerprint, "结论指纹", 128) };
}

function anchorValue(value, quote) {
  if (value === undefined) return { kind: quote ? "text" : "after" };
  record(value, "分支定位");
  if (!["after", "text", "table", "image"].includes(value.kind)) throw new Error("分支定位类型无效。");
  const anchor = { kind: value.kind };
  for (const key of ["occurrence", "blockIndex", "contextIndex"]) {
    if (value[key] !== undefined) {
      const number = numberValue(value[key], "分支定位序号", 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(number)) throw new Error("分支定位序号必须是非负整数。");
      anchor[key] = number;
    }
  }
  if (value.imageUrl !== undefined) anchor.imageUrl = textValue(value.imageUrl, "来源图片地址", 16000);
  if (value.messageText !== undefined) anchor.messageText = textValue(value.messageText, "来源消息原文", LIMITS.contentLength);
  return anchor;
}

function contextValue(value, label = "上下文快照") {
  return arrayValue(value, label, LIMITS.contextMessages).map((entry) => {
    record(entry, "上下文消息");
    if (!["system", "user", "assistant"].includes(entry.role)) throw new Error("上下文消息角色无效。");
    return { role: entry.role, content: textValue(entry.content, "上下文内容", LIMITS.contentLength + 100) };
  });
}

function usageValue(value) {
  record(value, "消息用量");
  const usage = {};
  for (const key of ["inputTokens", "outputTokens", "cachedInputTokens"]) {
    if (value[key] === null) usage[key] = null;
    else {
      const count = numberValue(value[key], "消息用量计数", 0, Number.MAX_SAFE_INTEGER);
      if (!Number.isSafeInteger(count)) throw new Error("消息用量计数必须是非负安全整数或 null。");
      usage[key] = count;
    }
  }
  return usage;
}

export function validateWorkspace(input) {
  inspectPayload(input, { text: 0, values: 0, seen: new WeakSet() });
  record(input, "工作区");
  if (input.version !== 1 && input.version !== 2)
    throw new Error("不支持的工作区版本。");
  const revision = numberValue(
    input.revision,
    "工作区修订号",
    0,
    Number.MAX_SAFE_INTEGER,
  );
  if (!Number.isSafeInteger(revision))
    throw new Error("工作区修订号必须是整数。");
  const usedIds = new Set();
  const uniqueId = (value, label) => {
    const id = idValue(value, label);
    if (usedIds.has(id)) throw new Error(`重复的 ID：${id}`);
    usedIds.add(id);
    return id;
  };
  let nodeCount = 0;
  let messageCount = 0;
  const boards = arrayValue(input.boards, "画布列表", LIMITS.boards).map(
    (rawBoard) => {
      record(rawBoard, "画布");
      const id = uniqueId(rawBoard.id, "画布 ID");
      record(rawBoard.viewport, "画布视图");
      const nodes = arrayValue(rawBoard.nodes, "节点列表", LIMITS.nodes).map(
        (rawNode) => {
          record(rawNode, "节点");
          if (++nodeCount > LIMITS.nodes) throw new Error("节点总数过大。");
          const nodeId = uniqueId(rawNode.id, "节点 ID");
          const parentId =
            rawNode.parentId === null
              ? null
              : idValue(rawNode.parentId, "父节点 ID");
          const messages = arrayValue(
            rawNode.messages,
            "消息列表",
            LIMITS.messages,
          ).map((rawMessage) => {
            record(rawMessage, "消息");
            if (++messageCount > LIMITS.messages)
              throw new Error("消息总数过大。");
            if (!["user", "assistant"].includes(rawMessage.role))
              throw new Error("消息角色只能是 user 或 assistant。");
            if (rawMessage.agentRun !== undefined && rawMessage.role !== "assistant")
              throw new Error("只有 assistant 消息可以包含 Agent 运行记录。");
            return {
              id: uniqueId(rawMessage.id, "消息 ID"),
              role: rawMessage.role,
              content: textValue(
                rawMessage.content,
                "消息内容",
                LIMITS.contentLength,
              ),
              createdAt: timestampValue(rawMessage.createdAt, "消息时间"),
              ...(Object.hasOwn(rawMessage, "usage") ? { usage: usageValue(rawMessage.usage) } : {}),
              ...(rawMessage.material !== undefined ? { material: materialValue(rawMessage.material) } : {}),
              ...(rawMessage.agentRun !== undefined ? { agentRun: validateAgentRun(rawMessage.agentRun) } : {}),
            };
          });
          let source = null;
          if (rawNode.source !== null) {
            record(rawNode.source, "分支来源");
            source = {
              messageId:
                rawNode.source.messageId === null
                  ? null
                  : idValue(rawNode.source.messageId, "来源消息 ID"),
              quote: textValue(
                rawNode.source.quote,
                "选中文字",
                LIMITS.contentLength,
              ),
              ...(rawNode.source.focusText !== undefined
                ? { focusText: textValue(rawNode.source.focusText, "分支聚焦文本", LIMITS.contentLength) } : {}),
              context: contextValue(rawNode.source.context),
              contextMode: rawNode.source.contextMode === undefined ? "legacy" : rawNode.source.contextMode,
              anchor: anchorValue(rawNode.source.anchor, rawNode.source.quote),
              focusTrail: arrayValue(rawNode.source.focusTrail === undefined ? [] : rawNode.source.focusTrail, "待发送聚焦引用", LIMITS.nodes)
                .map((focus) => textValue(focus, "聚焦引用", LIMITS.contentLength + 16000)),
            };
            if (!["legacy", "tail-focus"].includes(source.contextMode)) throw new Error("分支上下文模式无效。");
          }
          if ((parentId === null) !== (source === null))
            throw new Error("根节点不能有分支来源，子节点必须有上下文快照。");
          const mergedSources = new Set();
          const researchStatus = rawNode.researchStatus === undefined ? "exploring" : rawNode.researchStatus;
          if (!["exploring", "verify", "adopted", "parked"].includes(researchStatus)) throw new Error("研究状态无效。");
          const kind = rawNode.kind === undefined ? "conversation" : rawNode.kind;
          const executionMode = rawNode.executionMode === undefined ? "chat" : rawNode.executionMode;
          if (!["chat", "agent"].includes(executionMode)) throw new Error("会话执行模式无效。");
          if (!["conversation", "conclusion"].includes(kind)) throw new Error("节点类型无效。");
          const conclusion = conclusionValue(rawNode.conclusion);
          if ((kind === "conclusion") !== (conclusion !== null)) throw new Error("结论节点必须包含结论，普通会话不能包含结论元数据。");
          if (conclusion?.messageIds.some((id) => messages.some((message) => message.id === id && message.role !== "assistant")))
            throw new Error("结论正文只能引用本节点的 assistant 消息。");
          return {
            id: nodeId,
            parentId,
            mergeParents: arrayValue(rawNode.mergeParents === undefined ? [] : rawNode.mergeParents, "合并来源列表", LIMITS.nodes)
              .map((mergeId) => idValue(mergeId, "合并来源 ID")),
            merges: arrayValue(rawNode.merges === undefined ? [] : rawNode.merges, "合并记录", LIMITS.nodes).map((rawMerge) => {
              record(rawMerge, "合并记录");
              const mergedNodeId = idValue(rawMerge.nodeId, "合并历史来源 ID");
              if (mergedSources.has(mergedNodeId)) throw new Error("合并来源记录不能重复。");
              mergedSources.add(mergedNodeId);
              const messageIds = arrayValue(rawMerge.messageIds, "合并消息 ID", LIMITS.messages).map((id) => idValue(id, "合并消息 ID"));
              if (new Set(messageIds).size !== messageIds.length) throw new Error("合并消息 ID 不能重复。");
              return { nodeId: mergedNodeId, title: textValue(rawMerge.title, "合并来源标题", LIMITS.titleLength),
                context: contextValue(rawMerge.context, "合并历史快照"), messageIds,
                createdAt: timestampValue(rawMerge.createdAt, "合并时间") };
            }),
            ...lifecycleValue(rawNode, "节点"),
            researchStatus,
            contextPolicy: contextPolicyValue(rawNode.contextPolicy),
            executionMode,
            kind,
            conclusion,
            summary: summaryValue(rawNode.summary),
            title: textValue(rawNode.title, "节点标题", LIMITS.titleLength, {
              empty: false,
            }),
            x: numberValue(rawNode.x, "节点 X 坐标"),
            y: numberValue(rawNode.y, "节点 Y 坐标"),
            width: numberValue(rawNode.width === undefined ? CARD_SIZE.width : rawNode.width, "卡片宽度", CARD_SIZE.minWidth, CARD_SIZE.maxWidth),
            height: numberValue(rawNode.height === undefined ? CARD_SIZE.height : rawNode.height, "卡片高度", CARD_SIZE.minHeight, CARD_SIZE.maxHeight),
            messages,
            source,
            draft: textValue(rawNode.draft, "草稿", LIMITS.contentLength),
          };
        },
      );
      const byId = new Map(nodes.map((node) => [node.id, node]));
      const indegree = new Map(nodes.map((node) => [node.id, 0]));
      const children = new Map(nodes.map((node) => [node.id, []]));
      for (const node of nodes) {
        const parents = [...(node.parentId === null ? [] : [node.parentId]), ...node.mergeParents];
        if (new Set(parents).size !== parents.length)
          throw new Error("分支包含重复的来源引用。");
        for (const parentId of parents) {
          if (!byId.has(parentId))
            throw new Error("分支引用了不存在的父节点或合并来源。");
          if (parentId === node.id) throw new Error("分支不能引用自身，结构存在循环。");
          children.get(parentId).push(node.id);
        }
        if (node.parentId === null && node.mergeParents.length)
          throw new Error("合并节点必须有主父节点。");
        indegree.set(node.id, parents.length);
      }
      const queue = nodes
        .filter((node) => indegree.get(node.id) === 0)
        .map((node) => node.id);
      for (let index = 0; index < queue.length; index += 1) {
        for (const childId of children.get(queue[index])) {
          indegree.set(childId, indegree.get(childId) - 1);
          if (indegree.get(childId) === 0) queue.push(childId);
        }
      }
      if (queue.length !== nodes.length) throw new Error("分支结构存在循环。");
      return {
        id,
        title: textValue(rawBoard.title, "画布标题", LIMITS.titleLength, {
          empty: false,
        }),
        createdAt: timestampValue(rawBoard.createdAt, "画布创建时间"),
        updatedAt: timestampValue(rawBoard.updatedAt, "画布更新时间"),
        ...lifecycleValue(rawBoard, "画布"),
        nodes,
        viewport: {
          x: numberValue(rawBoard.viewport.x, "视图 X 坐标"),
          y: numberValue(rawBoard.viewport.y, "视图 Y 坐标"),
          zoom: numberValue(rawBoard.viewport.zoom, "缩放比例", 0.1, 4),
        },
      };
    },
  );
  if (!boards.length) throw new Error("工作区至少需要一个画布。");
  const activeBoardId = idValue(input.activeBoardId, "当前画布 ID");
  if (!boards.some((board) => board.id === activeBoardId))
    throw new Error("当前画布不存在。");
  return { version: 2, revision, activeBoardId, boards };
}
