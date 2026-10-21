import React, { useEffect, useMemo, useRef } from "react";
import { marked } from "marked";
import { ArrowUpRight, Database, ExternalLink, FileText, GitBranch, GitMerge, Link2, LocateFixed, RefreshCw, ShieldCheck, Sparkles, X } from "lucide-react";
import { isSummaryStale } from "../../shared/research.mjs";
import "./conversation-overview.css";

function httpUrl(value) {
  if (typeof value !== "string" || !/^https?:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function trimBareUrl(value) {
  const pairs = new Map([["(", ")"], ["[", "]"], ["{", "}"], ["（", "）"], ["［", "］"], ["｛", "｝"], ["【", "】"], ["「", "」"], ["『", "』"], ["《", "》"], ["〈", "〉"]]);
  const counts = new Map([...pairs.values()].map((closing) => [closing, 0]));
  let end = value.length;
  for (let i = 0; i < value.length; i++) {
    const character = value[i];
    if (pairs.has(character)) {
      const closing = pairs.get(character);
      counts.set(closing, counts.get(closing) + 1);
    } else if (counts.has(character)) {
      if (!counts.get(character)) { end = i; break; }
      counts.set(character, counts.get(character) - 1);
    }
  }
  return value.slice(0, end).replace(/[.,;:!?]+$/u, "");
}

/** Extract references from actual transcript text, without fetching any URL. */
export function collectConversationSources(node) {
  const sources = new Map();
  const add = (raw, label, where, image = false) => {
    const url = httpUrl(raw);
    if (!url) return;
    const existing = sources.get(url);
    if (existing) {
      existing.image ||= image;
      if (!existing.where.includes(where)) existing.where.push(where);
      return;
    }
    sources.set(url, { url, label: label?.trim() || new URL(url).hostname, image, where: [where] });
  };
  const addBare = (text, where, useUrlLabel = false) => {
    // Prose punctuation ends a literal URL. Encoded punctuation and balanced URL brackets stay intact.
    for (const match of text.matchAll(/https?:\/\/[^\s<>"'`，。；：！？、“”‘’]+/giu)) {
      const url = trimBareUrl(match[0]);
      add(url, useUrlLabel ? url : "", where);
    }
  };
  for (const [messages, where] of [[node?.messages, "当前消息"], [node?.source?.context, "继承上下文"]]) {
    for (const message of messages || []) {
      if (typeof message.content !== "string") continue;
      try {
        const tokens = marked.lexer(message.content);
        marked.walkTokens(tokens, (token) => {
          if (token.type === "link" || token.type === "image") {
            if (/^https?:\/\//i.test(token.raw)) addBare(token.raw, where, true);
            else add(token.href, token.text, where, token.type === "image");
          } else if (!token.tokens && ["text", "code", "codespan", "html"].includes(token.type)) {
            // Only scan literal leaves: rescanning a Markdown destination would swallow its closing syntax and following prose.
            addBare(token.raw, where);
          }
        });
        for (const definition of Object.values(tokens.links || {})) add(definition.href, "", where);
      } catch {
        // An unfinished Markdown response still has usable literal URLs.
        addBare(message.content, where);
      }
    }
  }
  return [...sources.values()];
}

/** Only saved import metadata identifies local materials; transcript links never imply imported files. */
export function collectLocalMaterials(node) {
  const materials = new Map();
  for (const message of node?.messages || []) {
    const material = message.material;
    if (!material || typeof material.name !== "string" || !["markdown", "pdf"].includes(material.kind)) continue;
    const key = JSON.stringify([material.name, material.kind]);
    const entry = materials.get(key) || { name: material.name, kind: material.kind, pages: [], messageCount: 0 };
    entry.messageCount++;
    if (Number.isSafeInteger(material.page) && material.page > 0 && !entry.pages.includes(material.page)) entry.pages.push(material.page);
    materials.set(key, entry);
  }
  return [...materials.values()].map((entry) => ({ ...entry, pages: entry.pages.sort((a, b) => a - b) }));
}

export function getConversationRelations(board, node) {
  if (!node) return { parent: null, children: [], mergeSources: [], mergeTargets: [], conclusionSources: [], conclusionTargets: [] };
  const nodes = board?.nodes || [];
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const merged = new Map();
  const addSource = (id, record = null) => {
    if (!id || id === node?.id) return;
    const entry = merged.get(id) || { id, node: byId.get(id) || null, records: [] };
    if (record) entry.records.push(record);
    merged.set(id, entry);
  };
  if (node?.mergeParents?.length) {
    addSource(node.parentId);
    for (const id of node.mergeParents) addSource(id);
  }
  for (const record of node?.merges || []) addSource(record.nodeId, record);
  return {
    parent: node?.parentId ? byId.get(node.parentId) || null : null,
    children: nodes.filter((item) => item.parentId === node?.id),
    mergeSources: [...merged.values()],
    mergeTargets: nodes.filter((item) => item.id !== node?.id && (
      item.mergeParents?.includes(node.id)
      || (item.mergeParents?.length && item.parentId === node.id)
      || item.merges?.some((record) => record.nodeId === node.id)
    )),
    conclusionSources: [...new Set(node.conclusion?.sourceNodeIds || [])].filter((id) => id !== node.id)
      .map((id) => ({ id, node: byId.get(id) || null })),
    conclusionTargets: nodes.filter((item) => item.id !== node.id && item.conclusion?.sourceNodeIds?.includes(node.id)),
  };
}

const displayTitle = (node) => node?.summary?.title || node?.title || "未命名会话";
const reportedCount = (value) => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString("zh-CN") : null;
const jumpSource = (nodeId, source, sourceNodeId) => ({ nodeId, sourceNodeId, messageId: source?.messageId ?? null, quote: source?.quote || "", anchor: source?.anchor ?? null });
const summaryUpdatedAt = (value) => {
  if (!value || Number.isNaN(new Date(value).getTime())) return null;
  return new Date(value).toLocaleString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
};

function Lifecycle({ node }) {
  return node?.status === "archived" ? <small className="overview-lifecycle">已归档</small>
    : node?.status === "trashed" ? <small className="overview-lifecycle">回收站</small> : null;
}

function SourceAnchor({ source }) {
  if (!source) return <p className="overview-anchor-note">未记录具体消息位置。</p>;
  const kind = source.anchor?.kind || (source.quote ? "text" : "after");
  const label = kind === "table" ? "从表格位置分支" : kind === "image" ? "从图片位置分支"
    : kind === "text" ? "引用的文字" : source.messageId ? "从该条消息之后分支" : "创建分支时保存的消息位置";
  return <div className="overview-anchor">
    <small>{label}{kind === "text" && Number.isInteger(source.anchor?.occurrence) ? ` · 第 ${source.anchor.occurrence + 1} 处` : ""}</small>
    {source.quote && <blockquote title={source.quote}>{source.quote}</blockquote>}
    {kind === "image" && !source.quote && source.anchor?.imageUrl && <p className="overview-anchor-note">{source.anchor.imageUrl}</p>}
  </div>;
}

function RelatedNode({ node, onNavigate, children }) {
  return <div className="overview-relation">
    <button type="button" className="overview-node-link" onClick={() => onNavigate?.(node)} disabled={!onNavigate}>
      <span><strong>{displayTitle(node)}</strong>{node.summary?.text && <small>{node.summary.text}</small>}</span>
      <ArrowUpRight size={14} />
    </button>
    <Lifecycle node={node} />
    {children}
  </div>;
}

export default function ConversationOverview({ board, node, onNavigate, onJump, onSummarize, summaryState, onClose, usage }) {
  const root = useRef(null);
  const close = useRef(onClose);
  close.current = onClose;
  const references = useMemo(() => collectConversationSources(node), [node]);
  const materials = useMemo(() => collectLocalMaterials(node), [node]);
  const relations = useMemo(() => getConversationRelations(board, node), [board, node]);
  const stale = useMemo(() => !node || !board?.nodes?.some((entry) => entry.id === node.id) || isSummaryStale(board, node.id), [board, node]);
  useEffect(() => {
    const previous = document.activeElement;
    const element = root.current;
    if (element && !element.contains(previous)) element.querySelector("button")?.focus();
    const pointer = (event) => {
      if (element?.contains(event.target) || event.target.closest?.("[data-conversation-overview-toggle]") || event.target.closest?.(".modal-shade")) return;
      close.current?.();
    };
    const keyboard = (event) => {
      if (event.key !== "Escape" || event.ctrlKey || event.altKey || event.shiftKey || event.metaKey
          || event.repeat || event.isComposing || event.keyCode === 229 || document.querySelector(".modal-shade")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close.current?.();
    };
    document.addEventListener("pointerdown", pointer, true);
    window.addEventListener("keydown", keyboard, true);
    return () => {
      document.removeEventListener("pointerdown", pointer, true);
      window.removeEventListener("keydown", keyboard, true);
      if (previous?.isConnected && (element?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus();
    };
  }, []);
  if (!node) return null;
  const hasSummary = typeof node.summary?.text === "string" && node.summary.text.trim();
  const updatedAt = summaryUpdatedAt(node.summary?.updatedAt);
  const busy = ["pending", "generating"].includes(summaryState?.status);
  const readOnly = (board?.status ?? "active") !== "active" || (node.status ?? "active") !== "active";
  const input = reportedCount(usage?.inputTokens);
  const cached = reportedCount(usage?.cachedInputTokens);
  const output = reportedCount(usage?.outputTokens);
  const reported = input !== null || cached !== null || output !== null;
  return <section ref={root} className="conversation-overview" role="dialog" aria-modal="false" aria-label="会话概览"
    onKeyDown={(event) => event.stopPropagation()}>
    <header className="overview-heading"><span><GitBranch size={18} /><span className="overview-heading-copy"><strong>会话概览</strong><small title={displayTitle(node)}>{displayTitle(node)}</small></span></span>
      <button type="button" className="overview-close" aria-label="关闭会话概览" onClick={onClose}><X size={17} /></button>
    </header>
    <div className="overview-body">
      <section className="overview-section overview-summary">
        <div className="overview-section-title"><Sparkles size={14} /><h3>模型总结</h3>
          <button type="button" className="overview-refresh" disabled={busy || readOnly || !onSummarize} onClick={() => onSummarize?.(node)}>
            <RefreshCw size={12} className={summaryState?.status === "generating" ? "spin" : ""} />
            {summaryState?.status === "pending" ? "排队中" : summaryState?.status === "generating" ? "生成中…" : summaryState?.status === "error" ? "重试总结" : "更新总结"}
          </button>
        </div>
        {hasSummary ? <><strong className="overview-summary-title">{node.summary.title || node.title}</strong><p>{node.summary.text}</p>
          <small className="overview-metadata">模型：{node.summary.model || "未记录"} · 已有总结</small>
          <small className="overview-metadata">更新于：{updatedAt ? <time dateTime={node.summary.updatedAt}>{updatedAt}</time> : "未记录"}</small>
          <p className={`overview-freshness${stale ? " stale" : ""}`} data-stale={stale}>
            {!node.summary.evidenceFingerprint ? "尚未核对当前内容，请更新总结。" : stale ? "会话内容或关联已变化，建议更新总结。" : "已核对：会话内容与关联未变化。"}
          </p></>
          : <p className="overview-empty">尚无模型总结。连接模型后，可按当前完整会话与分支关系生成。</p>}
        {summaryState?.status === "error" && <p className="overview-error" role="alert">{summaryState.error || "总结生成失败，请重试。"}</p>}
      </section>

      <section className="overview-section overview-materials-section">
        <div className="overview-section-title"><FileText size={14} /><h3>本地资料</h3><span>{materials.length}</span></div>
        <p className="overview-disclaimer">按资料名称与格式汇总当前会话的导入记录；仅保存提取的文字，原文件不复制到应用数据目录。</p>
        {materials.length ? <ul className="overview-materials">{materials.map((material) => <li key={JSON.stringify([material.name, material.kind])}>
          <strong>{material.name}</strong><small className="overview-metadata">{material.kind === "pdf" ? "PDF" : "Markdown"} · {material.messageCount} 段提取文字{material.pages.length ? ` · 第 ${material.pages.join("、")} 页` : ""}</small>
        </li>)}</ul> : <p className="overview-empty">当前会话没有已记录的本地导入资料。</p>}
      </section>

      <section className="overview-section">
        <div className="overview-section-title"><Link2 size={14} /><h3>文中来源</h3><span>{references.length}</span></div>
        <p className="overview-disclaimer">仅提取当前消息与继承上下文中的链接；未检索、抓取或验证网页。</p>
        {references.length ? <ul className="overview-sources">{references.map((reference) => <li key={reference.url}>
          <a href={reference.url} target="_blank" rel="noopener noreferrer"><span><strong>{reference.label}</strong><small>{reference.url}</small></span><ExternalLink size={13} /></a>
          <small className="overview-metadata">{reference.image ? "图片引用 · " : ""}{reference.where.join("、")}</small>
        </li>)}</ul> : <p className="overview-empty">这段会话尚未引用 http(s) 来源链接。</p>}
      </section>

      <section className="overview-section">
        <div className="overview-section-title"><GitBranch size={14} /><h3>分支来源</h3></div>
        {relations.parent ? <RelatedNode node={relations.parent} onNavigate={onNavigate}>
          <SourceAnchor source={node.source} />
          <button type="button" className="overview-jump" disabled={!node.source || !onJump} onClick={() => onJump?.(jumpSource(relations.parent.id, node.source, node.id))}><LocateFixed size={12} />定位来源消息</button>
        </RelatedNode> : <p className="overview-empty">{node.parentId ? "来源会话已不存在；已保存的继承上下文仍属于当前会话。" : "独立主干，没有上游分支。"}</p>}
      </section>

      <section className="overview-section">
        <div className="overview-section-title"><GitBranch size={14} /><h3>派生分支</h3><span>{relations.children.length}</span></div>
        {relations.children.length ? relations.children.map((child) => <RelatedNode key={child.id} node={child} onNavigate={onNavigate}>
          <SourceAnchor source={child.source} />
          <button type="button" className="overview-jump" disabled={!child.source || !onJump} onClick={() => onJump?.(jumpSource(node.id, child.source, child.id))}><LocateFixed size={12} />定位本会话中的来源</button>
        </RelatedNode>) : <p className="overview-empty">还没有从这段会话派生的分支。</p>}
      </section>

      <section className="overview-section">
        <div className="overview-section-title"><GitMerge size={14} /><h3>合并来源</h3><span>{relations.mergeSources.length}</span></div>
        {relations.mergeSources.length ? relations.mergeSources.map((entry) => {
          const snapshot = entry.records.at(-1);
          const details = entry.records.length ? <p className="overview-anchor-note">保留 {entry.records.length} 次独立快照 · 共 {entry.records.reduce((count, record) => count + (record.context?.length || 0), 0)} 条上下文消息</p> : null;
          return entry.node ? <RelatedNode key={entry.id} node={entry.node} onNavigate={onNavigate}>{details}</RelatedNode>
            : <div className="overview-relation" key={entry.id}><strong>{snapshot?.title || "原合并来源已删除"}</strong><small className="overview-metadata">来源会话已不存在，合并快照仍保留。</small>{details}</div>;
        }) : <p className="overview-empty">没有合并其他会话的记录。</p>}
      </section>

      <section className="overview-section">
        <div className="overview-section-title"><GitMerge size={14} /><h3>合并去向</h3><span>{relations.mergeTargets.length}</span></div>
        {relations.mergeTargets.length ? relations.mergeTargets.map((target) => <RelatedNode key={target.id} node={target} onNavigate={onNavigate} />)
          : <p className="overview-empty">这段会话尚未合入其他会话。</p>}
      </section>

      <section className="overview-section overview-conclusion-sources">
        <div className="overview-section-title"><ShieldCheck size={14} /><h3>结论来源</h3><span>{relations.conclusionSources.length}</span></div>
        <p className="overview-disclaimer">结论引用的会话资料；此关联不表示分支继承或合并。</p>
        {relations.conclusionSources.length ? relations.conclusionSources.map((entry) => entry.node
          ? <RelatedNode key={entry.id} node={entry.node} onNavigate={onNavigate} />
          : <div className="overview-relation" key={entry.id}><strong>原结论来源已删除</strong><small className="overview-metadata">会话 ID：{entry.id}。已保存的结论与引文仍保留。</small></div>)
          : <p className="overview-empty">当前节点没有结论来源记录。</p>}
      </section>

      <section className="overview-section overview-conclusion-targets">
        <div className="overview-section-title"><ShieldCheck size={14} /><h3>结论去向</h3><span>{relations.conclusionTargets.length}</span></div>
        {relations.conclusionTargets.length ? relations.conclusionTargets.map((target) => <RelatedNode key={target.id} node={target} onNavigate={onNavigate} />)
          : <p className="overview-empty">这段会话尚未作为结论卡的来源。</p>}
      </section>

      <section className="overview-section overview-usage">
        <div className="overview-section-title"><Database size={14} /><h3>最近一条回答的用量</h3></div>
        {reported ? <><dl><div><dt>本次输入</dt><dd>{input ?? "未知"}</dd></div><div><dt>缓存读取</dt><dd>{cached ?? "未知"}</dd></div><div><dt>本次输出</dt><dd>{output ?? "未知"}</dd></div></dl><p className="overview-disclaimer">单位为 tokens，仅显示服务端实际报告的用量；缓存命中与计费以模型服务为准。</p></>
          : <p className="overview-empty">服务端未报告用量，输入、输出与缓存读取均未知。</p>}
      </section>
    </div>
  </section>;
}
