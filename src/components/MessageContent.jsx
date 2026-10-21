import React, { useEffect, useMemo, useRef } from "react";
import { renderMessageHtml } from "../../shared/markdown.mjs";
import { findAnchorRange } from "../anchors.mjs";
import "katex/dist/katex.min.css";
import "./message-content.css";

export { renderMessageHtml } from "../../shared/markdown.mjs";

const EMPTY_BRANCH_LINKS = [];
function tableQuote(table) {
  return [...table.rows].map((row) => [...row.cells].map((cell) => cell.textContent.trim()).join(" | ")).join("\n");
}

export default function MessageContent({ text, codeWrap = false, fontSize, onBranchBlock, branchLinks = EMPTY_BRANCH_LINKS, onOpenBranch }) {
  const html = useMemo(() => renderMessageHtml(text), [text]);
  const linksKey = JSON.stringify(branchLinks.map(({ id, title, anchor, quote }) => [id, title, anchor?.kind, anchor?.blockIndex, anchor?.imageUrl, anchor?.occurrence, quote]));
  const root = useRef(null);
  const timers = useRef(new Set());
  useEffect(() => () => {
    for (const timer of timers.current) clearTimeout(timer);
  }, []);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const tools = [];
    const decorate = (block, kind, index) => {
      const existing = branchLinks.filter((branch) => branch.anchor?.kind === kind && branch.anchor.blockIndex === index
        && (kind !== "image" || !branch.anchor.imageUrl || branch.anchor.imageUrl === block.dataset.imageRef));
      if (!onBranchBlock && !existing.length) return;
      const bar = element.ownerDocument.createElement("span");
      bar.className = "message-block-tools";
      bar.dataset.blockKind = kind;
      bar.dataset.blockIndex = String(index);
      if (onBranchBlock) {
        const button = element.ownerDocument.createElement("button");
        button.type = "button";
        button.dataset.branchBlock = kind;
        button.dataset.blockIndex = String(index);
        button.textContent = kind === "table" ? "从此表格建立分支" : "从此图片建立分支";
        bar.append(button);
      }
      for (const branch of existing) {
        const button = element.ownerDocument.createElement("button");
        button.type = "button";
        button.className = "message-block-existing";
        button.dataset.openBranch = branch.id;
        button.textContent = `↗ ${branch.title || "已有分支"}`;
        button.disabled = !onOpenBranch;
        bar.append(button);
      }
      if (kind === "table") block.after(bar);
      else block.append(bar);
      tools.push(bar);
    };
    [...element.querySelectorAll("table")].forEach((table, index) => decorate(table, "table", index));
    [...element.querySelectorAll("[data-image-ref]")].forEach((image, index) => decorate(image, "image", index));
    const textGroups = new Map();
    for (const branch of branchLinks) {
      if (branch.anchor?.kind !== "text" || !branch.quote) continue;
      const range = findAnchorRange(element, branch.quote, branch.anchor.occurrence ?? 0);
      const block = range?.endContainer.parentElement?.closest("p,li,pre,blockquote,h1,h2,h3,h4,h5,h6");
      if (!block || !element.contains(block) || block.closest("table,[data-image-ref],.message-block-tools")) continue;
      const group = textGroups.get(block) || [];
      group.push(branch);
      textGroups.set(block, group);
    }
    for (const [block, branches] of textGroups) {
      const bar = element.ownerDocument.createElement("span");
      bar.className = "message-block-tools message-text-branch-tools";
      for (const branch of branches) {
        const button = element.ownerDocument.createElement("button");
        const quote = branch.quote.trim().replace(/\s+/g, " ");
        button.type = "button";
        button.className = "message-block-existing";
        button.dataset.openBranch = branch.id;
        button.textContent = `↗ ${branch.title || "已有分支"} · ${quote.slice(0, 44)}${quote.length > 44 ? "…" : ""}`;
        button.title = `${branch.title || "已有分支"}：${quote}`;
        button.disabled = !onOpenBranch;
        bar.append(button);
      }
      block.after(bar);
      tools.push(bar);
    }
    return () => tools.forEach((bar) => bar.remove());
    // Callers derive fresh arrays while streaming other messages. Replacing
    // unchanged tools would remove the user's focused branch button.
  }, [html, Boolean(onBranchBlock), Boolean(onOpenBranch), linksKey]);

  const contentClick = async (event) => {
    const openBranch = event.target.closest("button[data-open-branch]");
    if (openBranch && event.currentTarget.contains(openBranch)) {
      event.preventDefault(); event.stopPropagation();
      onOpenBranch?.(openBranch.dataset.openBranch);
      return;
    }
    const branch = event.target.closest("button[data-branch-block]");
    if (branch && event.currentTarget.contains(branch)) {
      event.preventDefault(); event.stopPropagation();
      const blockIndex = Number(branch.dataset.blockIndex);
      if (branch.dataset.branchBlock === "table") {
        const table = event.currentTarget.querySelectorAll("table")[blockIndex];
        if (table) onBranchBlock?.({ kind: "table", blockIndex, quote: tableQuote(table) });
      } else {
        const image = event.currentTarget.querySelectorAll("[data-image-ref]")[blockIndex];
        if (image) onBranchBlock?.({ kind: "image", blockIndex, quote: image.dataset.imageAlt || image.dataset.imageRef, imageUrl: image.dataset.imageRef });
      }
      return;
    }
    const loadImage = event.target.closest("button[data-load-image]");
    if (loadImage && event.currentTarget.contains(loadImage)) {
      event.preventDefault(); event.stopPropagation();
      const reference = loadImage.closest("[data-image-ref]");
      let url;
      try { url = new URL(reference.dataset.imageRef); } catch { return; }
      if (url.protocol !== "https:" || url.username || url.password || loadImage.disabled) return;
      const preview = reference.querySelector(".message-image-preview");
      const status = reference.querySelector(".message-image-status");
      if (!preview || !status) return;
      const image = reference.ownerDocument.createElement("img");
      image.alt = reference.dataset.imageAlt || "会话引用图片";
      image.loading = "lazy";
      image.decoding = "async";
      image.referrerPolicy = "no-referrer";
      image.className = "message-loaded-image";
      image.addEventListener("load", () => {
        if (preview.firstChild !== image) return;
        loadImage.textContent = "已加载";
        status.textContent = "";
      }, { once: true });
      image.addEventListener("error", () => {
        if (preview.firstChild !== image) return;
        preview.replaceChildren();
        loadImage.disabled = false;
        loadImage.textContent = "重新加载图片";
        status.textContent = "图片加载失败，可以重试或查看原图。";
      }, { once: true });
      loadImage.disabled = true;
      loadImage.textContent = "正在加载…";
      status.textContent = "";
      status.setAttribute("aria-live", "polite");
      image.src = url.href;
      preview.replaceChildren(image);
      return;
    }
    const button = event.target.closest("button[data-copy-code]");
    if (!button || !event.currentTarget.contains(button)) return;
    event.preventDefault();
    event.stopPropagation();
    const code = button.closest(".message-code")?.querySelector("pre code");
    if (!code || button.disabled) return;
    button.disabled = true;
    try {
      if (window.branchDesktop?.copyText) await window.branchDesktop.copyText(code.textContent);
      else if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code.textContent);
      else throw new Error("Clipboard is unavailable");
      button.textContent = "已复制";
      button.setAttribute("aria-label", "代码已复制");
    } catch {
      button.textContent = "复制失败";
      button.setAttribute("aria-label", "复制失败，请选择代码后手动复制");
    } finally {
      if (!button.isConnected) return;
      const timer = setTimeout(() => {
        button.textContent = "复制代码";
        button.setAttribute("aria-label", "复制代码");
        button.disabled = false;
        timers.current.delete(timer);
      }, 1600);
      timers.current.add(timer);
    }
  };

  return (
    <div
      ref={root}
      className={`message-content${codeWrap ? " message-code-wrap" : ""}`}
      style={Number.isFinite(Number(fontSize)) && fontSize != null
        ? { "--message-font-size": `${Math.min(28, Math.max(10, Number(fontSize)))}px` }
        : undefined}
      onClick={contentClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
