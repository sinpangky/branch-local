import { LIMITS } from "./core.mjs";
import { researchFingerprint } from "./research.mjs";

export const COMPARISON_CATEGORIES = Object.freeze(["agreement", "difference", "basis", "open", "conclusion"]);

function selectedNodes(board, nodeIds) {
  if (!board || !Array.isArray(board.nodes) || !Array.isArray(nodeIds) || nodeIds.length < 2
      || nodeIds.length > LIMITS.nodes || nodeIds.some((id) => typeof id !== "string")
      || new Set(nodeIds).size !== nodeIds.length) throw new Error("请选择至少两个不同的同画布会话进行比较。");
  const byId = new Map(board.nodes.map((node) => [node.id, node]));
  const nodes = nodeIds.map((id) => byId.get(id));
  if (nodes.some((node) => !node)) throw new Error("比较来源不存在，或不属于当前画布。");
  return nodes;
}

/** Evidence locations always refer to stored text, never a synthetic focus turn. */
export function getComparisonSources(board, nodeIds) {
  return selectedNodes(board, nodeIds).map((node) => ({
    nodeId: node.id, title: node.title, parentId: node.parentId,
    mergeParents: [...(node.mergeParents || [])], status: node.status ?? "active",
    focus: node.source?.focusText ?? node.source?.quote ?? "",
    messages: [
      ...(node.source?.context || []).map((message, contextIndex) => ({ role: message.role, content: message.content, contextIndex })),
      ...node.messages.map((message) => ({ role: message.role, content: message.content, messageId: message.id })),
    ],
  }));
}

/** Synchronous evidence key shared by the API and the review-before-save UI. */
export function comparisonFingerprint(board, nodeIds) {
  return researchFingerprint({ boardId: board.id, sources: getComparisonSources(board, nodeIds) });
}

const compactWhitespace = (value) => value.replace(/\s+/g, " ").trim();
const containsQuote = (text, quote) => text.includes(quote) || compactWhitespace(text).includes(compactWhitespace(quote));

function verifyCitation(sources, citation) {
  if (!citation || typeof citation !== "object" || Array.isArray(citation)
      || typeof citation.nodeId !== "string" || typeof citation.quote !== "string"
      || !citation.quote.trim() || citation.quote.length > LIMITS.contentLength) return null;
  const source = sources.find((item) => item.nodeId === citation.nodeId);
  if (!source) return null;
  const quote = citation.quote.trim();
  const hasMessage = citation.messageId !== undefined;
  const hasContext = citation.contextIndex !== undefined;
  if (hasMessage && hasContext) return null;
  let candidates;
  if (hasMessage) {
    if (typeof citation.messageId !== "string") return null;
    candidates = source.messages.filter((message) => message.messageId === citation.messageId);
  } else if (hasContext) {
    if (!Number.isSafeInteger(citation.contextIndex) || citation.contextIndex < 0) return null;
    candidates = source.messages.filter((message) => message.contextIndex === citation.contextIndex);
  } else candidates = source.messages;
  const matches = candidates.filter((message) => containsQuote(message.content, quote));
  if (matches.length !== 1) return null;
  const location = matches[0];
  return { nodeId: source.nodeId,
    ...(location.messageId !== undefined ? { messageId: location.messageId } : { contextIndex: location.contextIndex }), quote };
}

/** Invalid or ambiguous citations cannot become clickable evidence. */
export function verifyComparisonCitation(board, nodeIds, citation) {
  return verifyCitation(getComparisonSources(board, nodeIds), citation);
}

function normalizeComparison(value, { sources, nodeIds, model, createdAt, fingerprint }) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || typeof value.title !== "string" || !value.title.trim() || value.title.length > LIMITS.titleLength
      || !Array.isArray(value.items) || !value.items.length || value.items.length > 200)
    throw new Error("模型比较缺少有效的 title 或 items，请重试。");
  if (typeof model !== "string" || model.length > 256 || !Number.isFinite(Date.parse(createdAt)))
    throw new Error("比较模型或生成时间无效。");
  const items = value.items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)
        || typeof item.text !== "string" || !item.text.trim() || item.text.length > 10000
        || !COMPARISON_CATEGORIES.includes(item.category)
        || (item.citations !== undefined && (!Array.isArray(item.citations) || item.citations.length > 200)))
      throw new Error("模型比较条目或证据引用格式无效，请重试。");
    const seen = new Set();
    const citations = (item.citations || []).map((citation) => verifyCitation(sources, citation)).filter((citation) => {
      if (!citation) return false;
      const key = JSON.stringify(citation);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { id: `comparison-item-${index + 1}`, text: item.text.trim(), category: item.category,
      citations, unsupported: citations.length === 0, verified: false, adopted: false };
  });
  return { title: value.title.trim(), items, sourceNodeIds: [...nodeIds], model,
    fingerprint, createdAt: new Date(createdAt).toISOString() };
}

/** Reuse the immutable evidence snapshot across all partial/reduction responses. */
export function createComparisonValidator({ board, nodeIds, model = "", createdAt = new Date().toISOString() }) {
  const sources = getComparisonSources(board, nodeIds);
  const selectedIds = [...nodeIds];
  const fingerprint = researchFingerprint({ boardId: board.id, sources });
  return (value) => normalizeComparison(value, { sources, nodeIds: selectedIds, model, createdAt, fingerprint });
}

/** Normalize model output without accepting model-asserted verification/adoption. */
export function validateComparison(value, options) {
  return createComparisonValidator(options)(value);
}
