import { useCallback, useRef, useState } from "react";
import { summaryEvidenceFingerprint } from "../../shared/research.mjs";
import { buildContext } from "../../shared/core.mjs";

// Only relationship metadata reaches the summary prompt. Historical baselines
// can be large and are not evidence for the current transcript.
const mergeRelations = (node) => (node.merges || []).map(({ nodeId, title, createdAt, messageIds }) => ({
  nodeId, title, createdAt, messageIds,
}));

function snapshotKey(board, nodeId) {
  const node = board.nodes.find((item) => item.id === nodeId);
  return JSON.stringify({
    node: node && {
      messages: node.messages, source: node.source, title: node.title,
      mergeParents: node.mergeParents, merges: mergeRelations(node), status: node.status,
    },
    tree: board.nodes.map((item) => ({
      id: item.id, parentId: item.parentId, mergeParents: item.mergeParents, merges: mergeRelations(item),
      title: item.title, quote: item.source?.quote, status: item.status,
      summary: item.id === nodeId ? undefined : item.summary,
    })),
  });
}

const eligible = (board, node) => board?.status === "active" && node?.status === "active";
const findTarget = (workspace, job) => {
  const board = workspace?.boards.find((item) => item.id === job.boardId);
  return { board, node: board?.nodes.find((item) => item.id === job.nodeId) };
};

function automaticAllowed(board, node, settings) {
  if (!board || !node || settings?.autoSummary !== true) return false;
  if (settings.autoSummaryMaterials === true) return true;
  // Own metadata survives even when buildContext drops presentation fields;
  // inherited snapshots and focus-wrapped turns retain the material marker.
  const material = (message) => message.material || message.content?.includes("【本地资料：");
  return !node.messages.some(material) && !(node.source?.context || []).some(material)
    && !buildContext(board, node.id).some(material);
}

/** Serialize background summaries; chat generation can preempt and resume them. */
export function useSummaries({ wsRef, settingsRef, update, notify }) {
  const [states, setStates] = useState({});
  const queue = useRef([]);
  const active = useRef(null);
  const paused = useRef(false);
  const generation = useRef(0);
  const pump = useRef(null);
  const setStatus = useCallback((key, value) => setStates((old) => {
    const next = { ...old };
    if (value) next[key] = value;
    else delete next[key];
    return next;
  }), []);
  const schedulePump = useCallback(() => queueMicrotask(() => pump.current?.()), []);

  pump.current = async () => {
    if (active.current || paused.current) return;
    while (queue.current.length) {
      const job = queue.current.shift();
      if (job.generation !== generation.current) continue;
      const allowed = () => {
        const latest = findTarget(wsRef.current, job);
        return job.manual || automaticAllowed(latest.board, latest.node, settingsRef.current);
      };
      const { board, node } = findTarget(wsRef.current, job);
      if (!allowed() || !eligible(board, node)) {
        setStatus(job.key, null);
        continue;
      }
      const run = { job, controller: new AbortController(), generation: generation.current, reason: null };
      const current = () => run.generation === generation.current;
      const fail = (message) => {
        if (!current()) return;
        setStatus(job.key, { status: "error", error: message, retryable: true });
        if (job.manual) notify?.(`摘要生成失败：${message}`);
      };
      const retryStale = () => {
        if (!current()) return;
        if (job.retries < 2) {
          queue.current.push({ ...job, retries: job.retries + 1 });
          setStatus(job.key, { status: "pending" });
        } else fail("会话或关联分支持续变化，摘要未写入。请稍后重试。");
      };
      active.current = run;
      setStatus(job.key, { status: "generating" });
      const fingerprint = snapshotKey(board, node.id);
      const evidenceFingerprint = summaryEvidenceFingerprint(board, node.id);
      try {
        const response = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: run.controller.signal,
          body: JSON.stringify({
            workspace: { ...wsRef.current, activeBoardId: board.id, boards: [structuredClone(board)] },
            boardId: board.id, nodeId: node.id,
          }),
        });
        // Cancellation can happen while fetch or response.json() is pending.
        if (!current() || run.controller.signal.aborted) return;
        let result;
        try { result = await response.json(); }
        catch { throw new Error("摘要服务返回了无法读取的数据，请重试。"); }
        if (!current() || run.controller.signal.aborted) return;
        if (!response.ok) throw new Error(result?.error || `摘要生成失败（HTTP ${response.status}）`);
        if (result?.boardId !== job.boardId || result?.nodeId !== job.nodeId
            || typeof result.summary?.title !== "string" || !result.summary.title.trim()
            || typeof result.summary?.text !== "string" || !result.summary.text.trim()) {
          throw new Error("摘要服务返回的会话或摘要内容无效，请重试。");
        }
        const latest = findTarget(wsRef.current, job);
        if (!allowed() || !eligible(latest.board, latest.node)) {
          setStatus(job.key, null);
          return;
        }
        if (snapshotKey(latest.board, job.nodeId) !== fingerprint
            || summaryEvidenceFingerprint(latest.board, job.nodeId) !== evidenceFingerprint) {
          retryStale();
          return;
        }
        let written = false;
        update((workspace) => {
          const target = findTarget(workspace, job);
          if (current() && !run.controller.signal.aborted && allowed()
              && eligible(target.board, target.node) && snapshotKey(target.board, job.nodeId) === fingerprint
              && summaryEvidenceFingerprint(target.board, job.nodeId) === evidenceFingerprint) {
            target.node.summary = { ...result.summary, evidenceFingerprint };
            written = true;
          }
        });
        if (!current() || run.controller.signal.aborted) return;
        if (written) setStatus(job.key, null);
        else retryStale();
      } catch (error) {
        if (!current()) return;
        const target = findTarget(wsRef.current, job);
        if (!allowed() || !eligible(target.board, target.node)) {
          setStatus(job.key, null);
          return;
        }
        if (run.controller.signal.aborted) {
          // pause() queues synchronously, so resume() before this catch cannot
          // lose the job; cancel() invalidates this run's generation entirely.
          if (run.reason === "pause" && queue.current.some((item) => item.key === job.key)) {
            setStatus(job.key, { status: "pending" });
          }
        } else fail(error instanceof Error ? error.message : "摘要生成失败，请重试。");
      } finally {
        // An old cancellation must never clear a subsequently started run.
        if (active.current === run) active.current = null;
        schedulePump();
      }
      return;
    }
  };

  const enqueue = useCallback((boardId, nodeIds, { manual = false } = {}) => {
    if (!manual && settingsRef.current?.autoSummary !== true) return;
    for (const nodeId of new Set(Array.isArray(nodeIds) ? nodeIds : [])) {
      const key = `${boardId}:${nodeId}`;
      const queued = queue.current.find((job) => job.key === key);
      const running = active.current?.generation === generation.current && active.current.job.key === key
        ? active.current.job : null;
      // A manual retry can upgrade an automatically queued/paused job.
      if (queued || running) {
        if (manual) {
          if (queued) queued.manual = true;
          if (running) running.manual = true;
        }
        continue;
      }
      const job = { boardId, nodeId, key, manual, retries: 0, generation: generation.current };
      const { board, node } = findTarget(wsRef.current, job);
      if (!eligible(board, node) || (!manual && !automaticAllowed(board, node, settingsRef.current))) continue;
      queue.current.push(job);
      setStatus(key, { status: "pending" });
    }
    schedulePump();
  }, [settingsRef, wsRef, setStatus, schedulePump]);

  const pause = useCallback(() => {
    paused.current = true;
    const run = active.current;
    if (!run || run.generation !== generation.current || run.controller.signal.aborted) return;
    run.reason = "pause";
    if (!queue.current.some((job) => job.key === run.job.key)) queue.current.unshift(run.job);
    setStatus(run.job.key, { status: "pending" });
    run.controller.abort();
  }, [setStatus]);
  const resume = useCallback(() => {
    paused.current = false;
    schedulePump();
  }, [schedulePump]);
  const cancel = useCallback(() => {
    generation.current += 1;
    queue.current = [];
    const run = active.current;
    if (run) {
      run.reason = "cancel";
      run.controller.abort();
    }
    setStates({});
  }, []);
  return { states, enqueue, pause, resume, cancel };
}
