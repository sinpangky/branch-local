import React, { useEffect, useRef, useState } from "react";
import { getNodeSize } from '../../shared/core.mjs';
import { RESEARCH_STATUSES } from '../../shared/research.mjs';
import {
  ChevronDown,
  ChevronRight,
  GitBranch,
  Sprout,
  Minus,
  Square,
  Copy,
  X,
  Map as MapIcon,
  MessageSquare,
  GitMerge,
  ShieldCheck,
} from "lucide-react";

const researchLabels = Object.fromEntries(RESEARCH_STATUSES.map(({ value, label }) => [value, label]));

// Keep the last visible element mounted long enough to play its exit animation.
export function AnimatedPresence({ children }) {
  const last = useRef(children);
  const [present, setPresent] = useState(Boolean(children));
  if (children) last.current = children;
  useEffect(() => {
    if (children) setPresent(true);
    else {
      const timer = setTimeout(() => setPresent(false), 160);
      return () => clearTimeout(timer);
    }
  }, [Boolean(children)]);
  if (!children && !present) return null;
  const element = children || last.current;
  return element
    ? React.cloneElement(element, {
        className: `${element.props.className || ""} ${!children ? "presence-exit" : ""}`,
        "aria-hidden": !children || undefined,
        inert: !children ? true : undefined,
      })
    : null;
}

export function DesktopTitlebar({ title }) {
  const desktop = window.branchDesktop;
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    desktop.getWindowState?.().then((state) => setMaximized(state.maximized));
    return desktop.onWindowState?.((state) => setMaximized(state.maximized));
  }, [desktop]);
  if (!desktop) return null;
  return (
    <header
      className="desktop-titlebar"
      onDoubleClick={(event) => {
        if (!event.target.closest("button")) desktop.windowAction("maximize");
      }}
    >
      <div className="desktop-wordmark">
        <GitBranch size={15} />
        <strong>枝间</strong>
        <span>BRANCH LOCAL</span>
      </div>
      <span className="desktop-document-title">{title || "工作区"}</span>
      <div className="window-controls">
        <button
          aria-label="最小化窗口"
          title="最小化"
          onClick={() => desktop.windowAction("minimize")}
        >
          <Minus size={15} />
        </button>
        <button
          aria-label={maximized ? "还原窗口" : "最大化窗口"}
          title={maximized ? "还原" : "最大化"}
          onClick={() => desktop.windowAction("maximize")}
        >
          {maximized ? <Copy size={13} /> : <Square size={12} />}
        </button>
        <button
          className="window-close"
          aria-label="关闭应用"
          title="关闭"
          onClick={() => desktop.windowAction("close")}
        >
          <X size={17} />
        </button>
      </div>
    </header>
  );
}

export function TreeNavigator({
  board,
  activeId,
  collapsed,
  onToggle,
  onSelect,
  onContextMenu,
  shortcutLabel,
}) {
  const [expanded, setExpanded] = useState(true);
  const byParent = new Map();
  for (const node of (board.status ?? 'active') === 'active' ? board.nodes.filter((n)=>(n.status ?? 'active')==='active') : []) {
    const children = byParent.get(node.parentId) || [];
    children.push(node);
    byParent.set(node.parentId, children);
  }
  const rows = [];
  const pending = [...(byParent.get(null) || [])]
    .reverse()
    .map((node) => ({ node, depth: 0 }));
  while (pending.length) {
    const row = pending.pop();
    rows.push(row);
    if (!collapsed.includes(row.node.id))
      for (const node of [...(byParent.get(row.node.id) || [])].reverse())
        pending.push({ node, depth: row.depth + 1 });
  }
  return (
    <section className="tree-navigator" aria-label="当前画布分支目录">
      <button
        className="tree-heading"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <GitBranch size={14} />
        <span>当前分支树</span>
        <small>{rows.length}</small>
        <ChevronDown size={14} className={expanded ? "" : "tree-closed"} />
      </button>
      <AnimatedPresence>
        {expanded && (
          <nav className="tree-rows">
            {rows.length ? (
              rows.map(({ node, depth }) => (
                <div
                  key={node.id}
                  className={`tree-row ${activeId === node.id ? "active" : ""}`}
                  data-node-id={node.id}
                  onContextMenu={(event)=>onContextMenu?.(event,node)}
                  onKeyDown={(event)=>{
                    if(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
                    const index = rows.findIndex((row)=>row.node.id===node.id);
                    let next;
                    if(event.key==='ArrowDown') next=rows[Math.min(rows.length-1,index+1)]?.node;
                    else if(event.key==='ArrowUp') next=rows[Math.max(0,index-1)]?.node;
                    else if(event.key==='ArrowRight') { if((byParent.get(node.id)||[]).length && collapsed.includes(node.id)) onToggle(node.id); else next=byParent.get(node.id)?.[0]; }
                    else if(event.key==='ArrowLeft') { if((byParent.get(node.id)||[]).length && !collapsed.includes(node.id)) onToggle(node.id); else next=board.nodes.find((n)=>n.id===node.parentId); }
                    else return;
                    event.preventDefault();event.stopPropagation();
                    if(next) [...event.currentTarget.closest('.tree-rows').querySelectorAll('[data-node-id]')].find((row)=>row.dataset.nodeId===next.id)?.querySelector('.tree-node')?.focus();
                  }}
                  style={{ "--depth": Math.min(depth, 7) }}
                >
                  {(byParent.get(node.id) || []).length ? (
                    <button
                      className="tree-toggle"
                      title={`${collapsed.includes(node.id) ? '展开子分支' : '折叠子分支'}${shortcutLabel ? ` · ${shortcutLabel}` : ''}`}
                      aria-expanded={!collapsed.includes(node.id)}
                      onClick={() => onToggle(node.id)}
                    >
                      {collapsed.includes(node.id) ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                    </button>
                  ) : (
                    <span className="tree-toggle" />
                  )}
                  <button
                    className="tree-node"
                    title={`${node.summary?.title || node.title} · ${researchLabels[node.researchStatus] || researchLabels.exploring}`}
                    onClick={() => onSelect(node)}
                  >
                    {node.kind === "conclusion" ? <ShieldCheck size={13} /> : node.mergeParents?.length || node.merges?.length ? <GitMerge size={13}/> : node.parentId ? (
                      <MessageSquare size={13} />
                    ) : (
                      <Sprout size={14} />
                    )}
                    <span>{node.summary?.title || node.title}</span>
                  </button>
                  {collapsed.includes(node.id) && (
                    <span className="tree-collapsed-count">
                      {(byParent.get(node.id) || []).length}
                    </span>
                  )}
                </div>
              ))
            ) : (
              <p className="tree-empty">添加一段对话开始探索</p>
            )}
          </nav>
        )}
      </AnimatedPresence>
    </section>
  );
}

export function MiniMap({
  nodes,
  viewport,
  stageRef,
  activeId,
  onSelect,
  onPan,
  panelOpen,
  panelWidth = 560,
}) {
  const [size, setSize] = useState({ width: 1000, height: 700 });
  const [expanded, setExpanded] = useState(true);
  useEffect(() => {
    if (!stageRef.current) return;
    const observer = new ResizeObserver(([entry]) =>
      setSize({
        width: entry.contentRect.width,
        height: entry.contentRect.height,
      }),
    );
    observer.observe(stageRef.current);
    return () => observer.disconnect();
  }, [stageRef]);
  if (!nodes.length) return null;
  const availableWidth =
    Math.max(1, size.width - (panelOpen ? Math.min(panelWidth, size.width) : 0));
  const view = {
    x: -viewport.x / viewport.zoom,
    y: -viewport.y / viewport.zoom,
    width: availableWidth / viewport.zoom,
    height: size.height / viewport.zoom,
  };
  const minX = Math.min(view.x, ...nodes.map((node) => node.x)) - 80;
  const minY = Math.min(view.y, ...nodes.map((node) => node.y)) - 80;
  const maxX =
    Math.max(view.x + view.width, ...nodes.map((node) => node.x + getNodeSize(node).width)) + 80;
  const maxY =
    Math.max(view.y + view.height, ...nodes.map((node) => node.y + getNodeSize(node).height)) + 80;
  const width = maxX - minX,
    height = maxY - minY;
  return (
    <section
      className={`minimap floating-control ${panelOpen ? "with-panel" : ""} ${expanded ? "" : "is-collapsed"}`}
      aria-label="画布缩略图"
    >
      <button
        className="minimap-heading"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        <MapIcon size={13} />
        <span>画布导航</span>
        <ChevronDown size={13} className={expanded ? "" : "tree-closed"} />
      </button>
      {expanded && (
        <svg
          viewBox={`${minX} ${minY} ${width} ${height}`}
          preserveAspectRatio="xMidYMid meet"
          role="img"
          aria-label="点击跳转到画布位置"
          onClick={(event) => {
            const point = event.currentTarget.createSVGPoint();
            point.x = event.clientX;
            point.y = event.clientY;
            const position = point.matrixTransform(
              event.currentTarget.getScreenCTM().inverse(),
            );
            onPan({
              x: availableWidth / 2 - position.x * viewport.zoom,
              y: size.height / 2 - position.y * viewport.zoom,
            });
          }}
        >
          {nodes
            .filter((node) => node.parentId)
            .map((node) => {
              const parent = nodes.find((item) => item.id === node.parentId);
              return (
                parent && (
                  <path
                    key={`edge-${node.id}`}
                    d={`M ${parent.x + getNodeSize(parent).width} ${parent.y + getNodeSize(parent).height / 2} L ${node.x} ${node.y + getNodeSize(node).height / 2}`}
                    className="minimap-edge"
                  />
                )
              );
            })}
          {nodes.map((node) => (
            <rect
              key={node.id}
              className={`minimap-node ${node.id === activeId ? "selected" : ""}`}
              x={node.x}
              y={node.y}
              width={getNodeSize(node).width}
              height={getNodeSize(node).height}
              rx="22"
              onClick={(event) => {
                event.stopPropagation();
                onSelect(node);
              }}
            >
              <title>{node.title}</title>
            </rect>
          ))}
          <rect
            className="minimap-viewport"
            x={view.x}
            y={view.y}
            width={view.width}
            height={view.height}
            rx="12"
          />
        </svg>
      )}
    </section>
  );
}
