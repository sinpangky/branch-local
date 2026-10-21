import { LIMITS, validateWorkspace } from "./core.mjs";

/** Restore only the deleted subtree, retaining every subsequent workspace edit. */
export function restoreNodes(workspace, { boardId, nodes }) {
  const next = validateWorkspace(workspace);
  const board = next.boards.find((entry) => entry.id === boardId);
  if (!board) throw new Error("原画布已不存在，无法恢复分支。");
  if (!Array.isArray(nodes) || nodes.length > LIMITS.nodes)
    throw new Error("要恢复的节点列表无效。");

  board.nodes.push(...nodes);
  // Validate the combined graph: restored IDs must be unique, and every parent
  // must still exist in this board or be part of the restored subtree.
  // Normalization also deep-copies the restored nodes and their context snapshots.
  return validateWorkspace(next);
}
