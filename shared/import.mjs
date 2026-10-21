import { LIMITS, newId, validateWorkspace } from "./core.mjs";
import { remapResearchMetadata } from "./research.mjs";

function entityIds(workspace) {
  return workspace.boards.flatMap((board) => [
    board.id,
    ...board.nodes.flatMap((node) => [
      node.id,
      ...node.messages.map((message) => message.id),
    ]),
  ]);
}

/** Import complete board copies without replacing any current workspace data. */
export function mergeWorkspace(
  current,
  incoming,
  { suffix = "（导入）" } = {},
) {
  const merged = validateWorkspace(current);
  const imported = validateWorkspace(incoming);
  if (typeof suffix !== "string") throw new Error("导入标题后缀必须是字符串。");
  const titleSuffix = suffix.slice(0, LIMITS.titleLength);
  const usedIds = new Set([...entityIds(merged), ...entityIds(imported)]);
  const allocateId = () => {
    let id;
    do {
      id = newId();
    } while (usedIds.has(id));
    usedIds.add(id);
    return id;
  };
  const boardIds = new Map();
  const nodeIds = new Map();
  const messageIds = new Map();

  // Build every mapping first, because references may point to later nodes.
  for (const board of imported.boards) {
    boardIds.set(board.id, allocateId());
    for (const node of board.nodes) {
      nodeIds.set(node.id, allocateId());
      for (const message of node.messages)
        messageIds.set(message.id, allocateId());
    }
  }
  for (const board of imported.boards) {
    board.id = boardIds.get(board.id);
    board.title =
      board.title.slice(0, LIMITS.titleLength - titleSuffix.length) +
      titleSuffix;
    for (const node of board.nodes) {
      Object.assign(node, remapResearchMetadata(node, nodeIds, messageIds));
      node.id = nodeIds.get(node.id);
      if (node.parentId !== null) node.parentId = nodeIds.get(node.parentId);
      node.mergeParents = node.mergeParents.map((id) => nodeIds.get(id));
      for (const merge of node.merges) {
        merge.nodeId = nodeIds.get(merge.nodeId) ?? merge.nodeId;
        merge.messageIds = merge.messageIds.map((id) => messageIds.get(id) ?? id);
      }
      for (const message of node.messages)
        message.id = messageIds.get(message.id);
      if (
        node.source?.messageId !== null &&
        node.source?.messageId !== undefined
      ) {
        // An edited/deleted source message may no longer exist. Preserve its
        // historical ID; the branch's independent context snapshot remains valid.
        node.source.messageId =
          messageIds.get(node.source.messageId) ?? node.source.messageId;
      }
    }
  }
  merged.boards.push(...imported.boards);
  merged.activeBoardId = imported.boards[0].id;
  return validateWorkspace(merged);
}
