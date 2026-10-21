import React, { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleAlert, Clock3, FileDown, FileText, FolderOpen, LoaderCircle, ShieldCheck, Square, Terminal, X } from "lucide-react";
import "./agent-trace.css";

const runLabels = { running: "执行中", completed: "已完成", cancelled: "已停止", failed: "失败", interrupted: "上次中断" };
const toolLabels = { running: "执行中", completed: "已完成", denied: "已拒绝", failed: "失败", cancelled: "已取消", "awaiting-approval": "待确认" };
const toolNames = { list_files: "列出文件", search_files: "搜索文件", read_file: "读取文件", write_file: "写入文件", edit_file: "局部编辑文件", create_directory: "创建目录", run_command: "运行命令", fetch_url: "读取网页", download_file: "下载文件", web_search: "搜索网页" };
const detailLimit = 12000;

function text(value) { return typeof value === "string" ? value : ""; }
function json(value) {
  try { return JSON.stringify(value ?? {}, null, 2) ?? ""; }
  catch { return "无法显示此预览；请拒绝操作并重新发起任务。"; }
}
function bytes(value) {
  return Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString("en-US")} bytes` : "尚未获取";
}

function StatusIcon({ status }) {
  if (status === "running") return <LoaderCircle size={15} className="spin" aria-hidden="true" />;
  if (status === "completed") return <Check size={15} aria-hidden="true" />;
  if (status === "awaiting-approval") return <ShieldCheck size={15} aria-hidden="true" />;
  if (status === "denied" || status === "cancelled") return <X size={15} aria-hidden="true" />;
  if (status === "interrupted") return <Clock3 size={15} aria-hidden="true" />;
  if (status === "failed") return <CircleAlert size={15} aria-hidden="true" />;
  return <Square size={14} aria-hidden="true" />;
}

function ToolRecord({ event }) {
  const live = ["running", "awaiting-approval"].includes(event.status);
  const [expanded, setExpanded] = useState(live);
  useEffect(() => { setExpanded(live); }, [live]);
  const original = text(event.detail) || text(event.details);
  const detail = original.slice(0, detailLimit);
  return <li className="agent-tool-record" data-tool-status={event.status}>
    <button type="button" className="agent-tool-heading" aria-expanded={expanded} onClick={() => { if (!live) setExpanded((value) => !value); }}>
      <span className="agent-tool-status-icon"><StatusIcon status={event.status} /></span>
      <span className="agent-tool-label"><strong>{text(event.summary) || toolNames[event.tool] || text(event.tool)}</strong><small>{toolNames[event.tool] || "工具"} · {text(event.tool)}</small></span>
      <span className="agent-tool-status">{toolLabels[event.status] || "已记录"}</span>
      <ChevronDown size={14} className={expanded ? "expanded" : ""} aria-hidden="true" />
    </button>
    {expanded && <div className="agent-tool-detail">
      {detail ? <pre>{detail}</pre> : <p>{live ? "正在等待此工具返回结果。" : "此工具没有附加详情。"}</p>}
      {original.length > detailLimit && <small>历史详情仅显示前 {detailLimit.toLocaleString("en-US")} 个字符。</small>}
    </div>}
  </li>;
}

function ApprovalPreview({ pending }) {
  const preview = pending.preview;
  if (!preview || typeof preview !== "object" || Array.isArray(preview)) return <pre className="agent-preview-json">{json(preview)}</pre>;
  if (preview.kind === "write" || pending.tool === "write_file" || pending.tool === "edit_file") return <>
    <dl className="agent-preview-meta"><div><dt>目标文件</dt><dd><code>{text(preview.path)}</code></dd></div><div><dt>操作</dt><dd>{pending.tool === "edit_file" ? `局部替换${Number.isSafeInteger(preview.replacements) && preview.replacements > 0 ? `（${preview.replacements} 处）` : ""}` : preview.exists ? "替换已有文件内容" : "创建新文件"}</dd></div></dl>
    <div className={`agent-file-preview ${preview.exists ? "is-existing" : "is-new"}`}>
      {preview.exists && <section aria-label="修改前的完整内容"><h5>修改前</h5><pre>{text(preview.before) || <span className="agent-preview-empty">空文件</span>}</pre></section>}
      <section aria-label="写入后的完整内容"><h5>{preview.exists ? "修改后" : "新文件内容"}</h5><pre>{text(preview.after) || <span className="agent-preview-empty">空文件</span>}</pre></section>
    </div>
  </>;
  if (preview.kind === "directory" || pending.tool === "create_directory") return <>
    <dl className="agent-preview-meta"><div><dt>目标目录</dt><dd><code>{text(preview.path)}</code></dd></div><div><dt>操作</dt><dd>创建单层目录</dd></div></dl>
    <p className="agent-download-note">允许后将在工作目录内创建此目录，父目录必须已经存在。不会创建文件或改变已有文件内容。</p>
  </>;
  if (preview.kind === "command" || pending.tool === "run_command") return <>
    <dl className="agent-preview-meta"><div><dt>运行目录</dt><dd><code>{text(preview.cwd) || "."}</code></dd></div>{Number.isFinite(preview.timeoutMs) && <div><dt>超时</dt><dd>{preview.timeoutMs} ms</dd></div>}</dl>
    <section className="agent-command-preview" aria-label="待执行的完整命令"><h5><Terminal size={14} aria-hidden="true" /> 完整命令</h5><pre>{text(preview.command)}</pre></section>
    <p className="agent-command-warning"><CircleAlert size={16} aria-hidden="true" /><span>命令以当前系统用户权限运行，不受工作目录沙箱限制，可能访问目录之外的文件、网络和当前用户可用的凭据。{preview.warning && <small>{text(preview.warning)}</small>}</span></p>
  </>;
  if (preview.kind === "download" || pending.tool === "download_file") return <>
    <dl className="agent-preview-meta"><div><dt>下载网址</dt><dd><code>{text(preview.url)}</code></dd></div><div><dt>保存位置</dt><dd><code>{text(preview.path)}</code></dd></div><div><dt>{Number.isFinite(preview.bytes) ? "文件大小" : "大小上限"}</dt><dd>{bytes(preview.bytes ?? preview.maximumBytes)}</dd></div></dl>
    <p className="agent-download-note">允许后将下载并写入该文件。应用不会自动打开或执行下载的内容。</p>
  </>;
  return <pre className="agent-preview-json">{json(preview)}</pre>;
}

/** Reviewable local execution history. Tool strings and previews remain text. */
export default function AgentTrace({ run, pending = null, onDecision, onOpenDirectory, busy = false }) {
  const activePending = run?.status === "running" && pending?.runId === run.id ? pending : null;
  const live = run?.status === "running";
  const [expanded, setExpanded] = useState(Boolean(live));
  const [deciding, setDeciding] = useState(false);
  const [decisionError, setDecisionError] = useState("");
  const decisionLock = useRef(false);
  const pendingKey = activePending ? `${activePending.runId}:${activePending.callId}` : "";
  const currentPendingKey = useRef(pendingKey);
  currentPendingKey.current = pendingKey;
  useEffect(() => { setExpanded(Boolean(live)); }, [run?.id, live]);
  useEffect(() => { decisionLock.current = false; setDeciding(false); setDecisionError(""); }, [pendingKey]);
  if (!run) return null;
  const events = Array.isArray(run.events) ? run.events : [];
  const toolCount=events.filter((entry)=>entry.tool!=='workspace').length;
  const artifacts = Array.isArray(run.artifacts) ? run.artifacts : [];
  const decide = async (approved) => {
    if (!activePending || !onDecision || busy || decisionLock.current) return;
    decisionLock.current = true;
    setDeciding(true);
    setDecisionError("");
    const decidedKey = pendingKey;
    try { await onDecision(approved); }
    catch (error) {
      if (currentPendingKey.current !== decidedKey) return;
      decisionLock.current = false;
      setDeciding(false);
      setDecisionError(error?.message || "提交确认失败，请重试。");
    }
  };
  return <section className="agent-trace" aria-label="Agent 运行记录" data-run-status={run.status}>
    <button type="button" className="agent-trace-heading" aria-expanded={expanded} onClick={() => { if (!live) setExpanded((value) => !value); }}>
      <StatusIcon status={run.status} /><strong role="status" aria-live="polite">Agent · {runLabels[run.status] || "执行记录"}</strong>
      {activePending && <span className="agent-pending-badge">待确认</span>}
      <small>{Number.isInteger(run.steps) ? run.steps : 0} 步 · {toolCount} 次工具</small><ChevronDown size={15} className={expanded ? "expanded" : ""} aria-hidden="true" />
    </button>
    {expanded && <div className="agent-trace-body">
      {activePending && <section className="agent-approval" role="region" aria-label="待确认操作" aria-busy={busy || deciding}>
        <header><ShieldCheck size={18} aria-hidden="true" /><div><h4>确认此次操作</h4><p>{text(activePending.summary) || toolNames[activePending.tool] || text(activePending.tool)}</p></div></header>
        <ApprovalPreview pending={activePending} />
        <p className="agent-approval-scope">仅批准当前操作。后续写入、下载和命令会分别请求确认。</p>
        {decisionError && <p className="agent-decision-error" role="alert">{decisionError}</p>}
        {typeof onDecision === "function" ? <div className="agent-approval-actions"><button type="button" className="button secondary" disabled={busy || deciding} onClick={() => decide(false)}>拒绝</button><button type="button" className="button primary" disabled={busy || deciding} onClick={() => decide(true)}>{deciding ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}允许此次操作</button></div>
          : <p className="agent-approval-unavailable">请回到正在执行此任务的会话确认操作。</p>}
      </section>}
      {events.length > 0 ? <ol className="agent-tool-list" aria-label="工具执行步骤">{events.map((event) => <ToolRecord key={event.id} event={event} />)}</ol> : <p className="agent-trace-empty">{live ? "正在准备任务，尚未调用工具。" : "本次任务没有工具执行记录。"}</p>}
      {artifacts.length > 0 && <section className="agent-artifacts" aria-label="任务产物"><header><h4>已生成的文件</h4>{onOpenDirectory && <button type="button" className="button secondary" disabled={busy} onClick={() => onOpenDirectory()}><FolderOpen size={14} aria-hidden="true" />打开工作目录</button>}</header><ul>{artifacts.map((artifact, index) => <li key={`${artifact.path}-${index}`}>{artifact.kind === "download" ? <FileDown size={16} aria-hidden="true" /> : <FileText size={16} aria-hidden="true" />}<span><code>{text(artifact.path)}</code>{artifact.summary && <small>{text(artifact.summary)}</small>}</span><small>{artifact.kind === "download" ? "下载" : "文件"}</small></li>)}</ul></section>}
    </div>}
    {["cancelled", "failed", "interrupted"].includes(run.status) && <p className="agent-trace-retained"><CircleAlert size={15} aria-hidden="true" />{run.status === "interrupted" ? "上次任务已中断，尚未确认的操作不会继续执行。" : run.status === "cancelled" ? "任务已停止。" : "任务未完成。"}已完成的文件操作不会自动撤销；再次运行可能重复执行。</p>}
  </section>;
}
