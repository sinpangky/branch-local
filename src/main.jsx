import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  ArrowUp,
  ArrowUpRight,
  ArrowLeft,
  Plus,
  GitBranch,
  Settings2,
  Search,
  X,
  Check,
  ChevronRight,
  ChevronDown,
  Maximize,
  Minus,
  Download,
  Upload,
  LayoutGrid,
  MessageSquare,
  MoreHorizontal,
  Trash2,
  Pencil,
  Copy,
  LoaderCircle,
  Square,
  Sprout,
  PanelLeftClose,
  PanelLeftOpen,
  CircleHelp,
  HardDrive,
  Waypoints,
  RotateCcw,
  Focus,
  FolderOpen,
  GitMerge, Archive, ArchiveRestore, Sparkles, RefreshCw, GripVertical, ListTree, GitCompareArrows, BookOpen, FilePlus2, ShieldCheck, ListFilter,
} from "lucide-react";
import {
  createBoard,
  createNode,
  buildContext,
  validateWorkspace,
  arrangeBoard,
  newId,
  CARD_SIZE, getNodeSize, LIMITS,
  resolveSourceAnchor,
} from "../shared/core.mjs";
import { readChatStream } from "./stream.mjs";
import { normalizeAgentRunForLoad } from '../shared/agent.mjs';
import AgentTrace from './components/AgentTrace.jsx';
import MessageContent from './components/MessageContent.jsx';
import ConversationOverview from './components/ConversationOverview.jsx';
import { captureTextAnchor, focusRenderedAnchor } from './anchors.mjs';
import { buildRequestContext, createRequestBranch, createConclusion, isSummaryStale, RESEARCH_STATUSES, syncConclusionMessages } from '../shared/research.mjs';
import { comparisonFingerprint } from '../shared/comparison.mjs';
import { ComparisonWorkbench, ContextPicker, ResearchStatus, ResearchResume, ConclusionView, conclusionMarkdown, getResearchProgress, displayDate } from './components/ResearchTools.jsx';
import Preferences from './components/Preferences.jsx';
import { useSummaries } from './hooks/useSummaries.js';
import { mergeWorkspace } from "../shared/import.mjs";
import { searchConversations } from '../shared/search.mjs';
import { SHORTCUT_ACTIONS, resolveShortcuts, formatShortcut, matchShortcut } from '../shared/shortcuts.mjs';
import {
  duplicateSubtree,
  duplicateBoard,
  getVisibleNodes,
  getDescendantIds,
  mergeConversations, setNodeStatus, setBoardStatus, purgeNode, purgeBoard,
} from "../shared/operations.mjs";
import {
  DesktopTitlebar,
  MiniMap,
  TreeNavigator,
  AnimatedPresence,
} from "./components/WorkspaceTools.jsx";
import "./style.css";
import './features.css';

const clone = (value) => structuredClone(value);
const time = () => new Date().toISOString();
const short = (s, n = 90) => (s.length > n ? s.slice(0, n) + "…" : s);
const strip = (s) => s.replace(/[#*`>\[\]]/g, "").trim();
const isDemoBoard = (board) => board?.nodes.some((node)=>node.messages.some((message)=>message.content.includes('这是内置演示内容，尚未调用 AI 模型。')));
async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || `请求失败 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return result;
}
async function download(name, text, type = "application/json") {
  if (window.branchDesktop?.saveFile) {
    return (await window.branchDesktop.saveFile({ name, text, type })).saved;
  }
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  return true;
}
function IconButton({ children, title, shortcut, className = "", ...props }) {
  return (
    <button
      className={`icon-button ${className}`}
      title={shortcut ? `${title} · ${formatShortcut(shortcut)}` : title}
      aria-label={title}
      {...props}
    >
      {children}
    </button>
  );
}
function Modal({ title, children, close, wide = false }) {
  const [leaving, setLeaving] = useState(false);
  const closeTimer = useRef(null);
  const shadeRef = useRef(null);
  const dismiss = useCallback(() => {
    setLeaving(true);
    closeTimer.current = setTimeout(close, 150);
  }, [close]);
  useEffect(() => {
    const previous = document.activeElement;
    const shade = shadeRef.current;
    if (shade && !shade.contains(document.activeElement))
      (shade.querySelector('.button.secondary') || shade.querySelector('button,input,textarea,select,[tabindex="0"]'))?.focus();
    return () => { if (previous?.isConnected && (shade?.contains(document.activeElement) || document.activeElement === document.body)) previous.focus(); };
  }, []);
  useEffect(() => {
    const handle = (e) => {
      if (e.defaultPrevented || e.isComposing || e.keyCode === 229) return;
      if ([...document.querySelectorAll('.modal-shade')].at(-1) !== shadeRef.current) return;
      if (e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        const focusable = [...shadeRef.current.querySelectorAll('button,input,textarea,select,a[href],[tabindex]')].filter((el)=>!el.matches(':disabled') && el.tabIndex >= 0 && !el.closest('[hidden]'));
        const index = focusable.indexOf(document.activeElement);
        if (!focusable.length) { e.preventDefault(); return; }
        if (index < 0 || (!e.shiftKey && index === focusable.length - 1) || (e.shiftKey && index === 0)) {
          e.preventDefault(); (e.shiftKey ? focusable.at(-1) : focusable[0]).focus();
        }
      }
      if (e.key === "Escape" && !e.repeat && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        e.stopImmediatePropagation();
        dismiss();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [dismiss]);
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  return (
    <div
      ref={shadeRef}
      className={`modal-shade ${leaving ? "presence-exit" : ""}`}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) dismiss();
      }}
    >
      <section
        className={`modal ${wide ? "wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <IconButton title="关闭弹窗" onClick={dismiss}>
            <X size={19} />
          </IconButton>
        </div>
        {children}
      </section>
    </div>
  );
}

function App() {
  const [workspace, setWorkspace] = useState(null),
    [loadError, setLoadError] = useState("");
  const [settings, setSettings] = useState(null),
    [showSettings, setShowSettings] = useState(false);
  const [settingsSection,setSettingsSection]=useState('model');
  const [agentPending,setAgentPending]=useState(null),[approvalBusy,setApprovalBusy]=useState(false),[activeAgent,setActiveAgent]=useState(null);
  const [activeId, setActiveId] = useState(null),
    [hovered, setHovered] = useState(null);
  const [panelWidth, setPanelWidth] = useState(560), [panelExpanded, setPanelExpanded] = useState(false);
  const [searchTrash, setSearchTrash] = useState(false);
  const [management, setManagement] = useState(null), [mergeTarget, setMergeTarget] = useState(null), [mergeSelection, setMergeSelection] = useState([]);
  const [mergeMode,setMergeMode] = useState('new'), [mergeMainId,setMergeMainId] = useState(null);
  const [overviewOpen,setOverviewOpen] = useState(false), [jumpTarget,setJumpTarget] = useState(null);
  const [sourceSnapshot,setSourceSnapshot] = useState(null);
  const [sourceReturn,setSourceReturn] = useState(null), [summaryExpanded,setSummaryExpanded] = useState(false);
  const [showLatest,setShowLatest] = useState(false), [searchIndex,setSearchIndex] = useState(0);
  const [managementQuery,setManagementQuery] = useState('');
  const [compareOpen,setCompareOpen]=useState(false),[compareSession,setCompareSession]=useState(null);
  const [contextPicker,setContextPicker]=useState(false),[resumeOpen,setResumeOpen]=useState(false);
  const [pathFocus,setPathFocus]=useState(false),[materialBusy,setMaterialBusy]=useState(false);
  const [lastVisits,setLastVisits]=useState(()=>{try{const value=JSON.parse(localStorage.getItem('branch-local:last-visits')||'{}');return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}});
  const [summaryFreshness,setSummaryFreshness]=useState({boardId:null,values:{}});
  const comparisonAbort=useRef(null);
  const chatScrollNode=useRef(null);
  const scrollPositions=useRef(new Map()), pinnedToBottom=useRef(true), previousReadingNode=useRef(null);
  useEffect(()=>{try{localStorage.setItem('branch-local:last-visits',JSON.stringify(lastVisits));}catch{}},[lastVisits]);
  const anchorClear = useRef(null);
  const settingsRef = useRef(null), summariesRef = useRef(null), panelResize = useRef(null), panelRef = useRef(null);
  const preferenceSave = useRef(Promise.resolve());
  const actionRunner = useRef(() => false);
  const menuTrigger=useRef(null);
  settingsRef.current = settings;
  const shortcuts = resolveShortcuts(settings?.shortcuts);
  const hint = (action) => shortcuts[action] ? <kbd className="shortcut-hint">{formatShortcut(shortcuts[action])}</kbd> : null;
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 800),
    [search, setSearch] = useState("");
  const [saveState, setSaveState] = useState("saved"),
    [saveError, setSaveError] = useState(""),
    [conflict, setConflict] = useState(false);
  const [toast, setToast] = useState(""),
    [dialog, setDialog] = useState(null),
    [help, setHelp] = useState(false);
  const [busyNode, setBusyNode] = useState(null),
    [requestError, setRequestError] = useState(null);
  const [quote, setQuote] = useState(null),
    [contextOpen, setContextOpen] = useState(false),
    [editMessage, setEditMessage] = useState(null);
  const [menu, setMenu] = useState(null),
    [dragging, setDragging] = useState(false),
    [globalSearch, setGlobalSearch] = useState(false),
    [globalQuery, setGlobalQuery] = useState("");
  const [collapsedByBoard, setCollapsedByBoard] = useState(() => {
    try {
      const stored = JSON.parse(
        localStorage.getItem("branch-local:collapsed") || "{}",
      );
      return stored && typeof stored === "object" && !Array.isArray(stored)
        ? Object.fromEntries(
            Object.entries(stored)
              .filter(([, ids]) => Array.isArray(ids))
              .map(([id, ids]) => [
                id,
                ids.filter((value) => typeof value === "string"),
              ]),
          )
        : {};
    } catch {
      return {};
    }
  });
  const wsRef = useRef(null),
    revision = useRef(0),
    epoch = useRef(0),
    saving = useRef(null),
    savedEpoch = useRef(0),
    timer = useRef(null),
    maxTimer = useRef(null),
    blocked = useRef(false),
    abort = useRef(null),
    noticeTimer = useRef(null),
    generationDone = useRef(Promise.resolve()),
    closeInProgress = useRef(false);
  const stageRef = useRef(null),
    chatEnd = useRef(null),
    fileInput = useRef(null),
    drag = useRef(null),
    dragMoved = useRef(false),
    composerRef = useRef(null);
  const focusAgentApproval=()=>{
    const scroll=panelRef.current?.querySelector('.chat-scroll');
    const actions=scroll?.querySelector('.agent-approval-actions');
    if(!scroll||!actions)return;
    const container=scroll.getBoundingClientRect(),target=actions.getBoundingClientRect();
    if(target.bottom>container.bottom-12||target.top<container.top+12)scroll.scrollTop+=target.bottom-container.bottom+16;
  };
  const board = workspace?.boards.find((b) => b.id === workspace.activeBoardId);
  const active = board?.nodes.find((n) => n.id === activeId);
  useEffect(()=>{setSearchIndex(0);},[globalQuery,globalSearch,searchTrash]);
  useEffect(()=>{setManagementQuery('');},[management]);
  useEffect(()=>{
    if(!board)return;
    const timer=setTimeout(()=>setSummaryFreshness({boardId:board.id,values:Object.fromEntries(board.nodes.filter((node)=>node.summary).map((node)=>[node.id,{baseline:node.summary.evidenceFingerprint,stale:isSummaryStale(board,node.id)}]))}),250);
    return()=>clearTimeout(timer);
  },[board]);
  useEffect(() => { if (settings?.panelWidth) setPanelWidth(settings.panelWidth); }, [settings?.panelWidth]);
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => { document.documentElement.dataset.theme = settings?.theme === 'dark' || (settings?.theme === 'system' && query.matches) ? 'dark' : 'light'; };
    apply(); query.addEventListener('change', apply); return () => query.removeEventListener('change', apply);
  }, [settings?.theme]);
  useEffect(() => {
    if (workspace) window.branchDesktop?.appReady?.();
  }, [Boolean(workspace)]);
  const collapsed = collapsedByBoard[board?.id] || [];
  const visibleNodes = board?.status === 'active' ? getVisibleNodes(board, collapsed) : [];
  useEffect(() => {
    try {
      localStorage.setItem(
        "branch-local:collapsed",
        JSON.stringify(collapsedByBoard),
      );
    } catch {
      /* A full localStorage must not prevent editing the workspace. */
    }
  }, [collapsedByBoard]);
  const notify = useCallback((text) => {
    clearTimeout(noticeTimer.current);
    setToast(text);
    noticeTimer.current = setTimeout(() => setToast(""), 4000);
  }, []);
  useEffect(() => {
    Promise.all([api("/api/workspace"), api("/api/settings")])
      .then(([ws, config]) => {
        let interrupted=false;
        for(const b of ws.boards)for(const node of b.nodes)for(const message of node.messages)if(message.agentRun?.status==='running'){message.agentRun=normalizeAgentRunForLoad(message.agentRun);interrupted=true;}
        wsRef.current = ws;
        revision.current = ws.revision;
        setWorkspace(ws);
        setSettings(config);
        if(interrupted){epoch.current++;setSaveState('pending');timer.current=setTimeout(()=>void persist(),600);}
      })
      .catch((error) => setLoadError(error.message));
    return () => {
      clearTimeout(timer.current);
      clearTimeout(maxTimer.current);
      clearTimeout(noticeTimer.current);
      abort.current?.abort();
    };
  }, []);
  const persist = useCallback(async () => {
    if (saving.current) {
      const success = await saving.current;
      return success && savedEpoch.current !== epoch.current
        ? persist()
        : success;
    }
    if (!wsRef.current || blocked.current) return false;
    clearTimeout(timer.current);
    clearTimeout(maxTimer.current);
    maxTimer.current = null;
    setSaveState("saving");
    setSaveError("");
    const task = (async () => {
      try {
        do {
          const savingEpoch = epoch.current;
          const payload = {
            ...clone(wsRef.current),
            revision: revision.current,
          };
          const result = await api("/api/workspace", {
            method: "PUT",
            body: JSON.stringify(payload),
          });
          revision.current = result.revision;
          savedEpoch.current = savingEpoch;
        } while (savedEpoch.current !== epoch.current);
        setSaveState("saved");
        return true;
      } catch (error) {
        if (error.status === 409) {
          blocked.current = true;
          setConflict(true);
        }
        setSaveError(error.message);
        setSaveState("error");
        return false;
      }
    })();
    saving.current = task;
    try {
      return await task;
    } finally {
      saving.current = null;
    }
  }, []);
  const update = useCallback(
    (fn) => {
      const next = clone(wsRef.current);
      fn(next);
      wsRef.current = next;
      epoch.current++;
      setWorkspace(next);
      setSaveState(blocked.current ? "error" : "pending");
      clearTimeout(timer.current);
      timer.current = setTimeout(persist, 600);
      if (!maxTimer.current) maxTimer.current = setTimeout(persist, 2000);
    },
    [persist],
  );
  const summaryJobs = useSummaries({ wsRef, settingsRef, update, notify });
  summariesRef.current = summaryJobs;
  useEffect(() => {
    if (!settings?.autoSummary) { summariesRef.current?.cancel(); return; }
    if (board?.status === 'active' && !isDemoBoard(board)) summariesRef.current.enqueue(board.id, board.nodes.filter((n) => n.status === 'active' && n.kind!=='conclusion' && !n.summary && n.messages.some((m) => m.role === 'assistant' && m.content.trim())).map((n) => n.id));
  }, [board?.id, settings?.model, settings?.baseUrl, settings?.autoSummary, settings?.autoSummaryMaterials]);
  useEffect(() => () => summariesRef.current?.cancel(), []);
  const savePreferences = async (patch) => {
    const task = preferenceSave.current.catch(() => {}).then(() => api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) }));
    preferenceSave.current = task;
    try { const result = await task; if (preferenceSave.current === task) setSettings(result); return result; }
    catch (error) { notify(`设置保存失败：${error.message}`); return null; }
  };
  const changeStorage = async (options) => {
    closeInProgress.current = true; summariesRef.current.cancel(); abort.current?.abort(); comparisonAbort.current?.abort();
    try { await generationDone.current; await preferenceSave.current.catch(() => {}); if (!await persist()) throw new Error('工作区未能保存，请先导出备份。'); await window.branchDesktop.applyDataDirectory(options); window.location.reload(); }
    finally { closeInProgress.current = false; summariesRef.current.resume(); }
  };
  const resolveConflict = async () => {
    if (busyNode) {
      notify("请先停止生成再恢复保存");
      return;
    }
    try {
      const latest = await api("/api/workspace");
      const merged = mergeWorkspace(latest, wsRef.current, {
        suffix: "（本窗口副本）",
      });
      revision.current = latest.revision;
      blocked.current = false;
      setConflict(false);
      setSaveError("");
      setActiveId(null);
      update((ws) => {
        Object.assign(ws, merged);
      });
      notify("已保留双方内容，本窗口的画布另存为副本");
    } catch (error) {
      notify(`恢复失败：${error.message}。请先导出备份。`);
    }
  };
  const updateBoard = (fn) =>
    update((ws) => {
      const b = ws.boards.find((b) => b.id === ws.activeBoardId);
      fn(b);
      b.updatedAt = time();
    });
  useEffect(() => {
    if (window.branchDesktop) return;
    const warn = (e) => {
      if (saveState !== "saved") {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [saveState]);
  useEffect(() => {
    const desktop = window.branchDesktop;
    if (!desktop) return;
    const unsubscribeCommand = desktop.onCommand?.((command) =>
      !closeInProgress.current && actionRunner.current(command),
    );
    const unsubscribeClose = desktop.onCloseRequested?.(async () => {
      if (closeInProgress.current) return;
      closeInProgress.current = true;
      document.activeElement?.blur?.();
      summariesRef.current?.cancel();
      abort.current?.abort();
      comparisonAbort.current?.abort();
      await generationDone.current;
      await preferenceSave.current.catch(() => {});
      const saved = await persist();
      desktop.closeReady(saved);
      closeInProgress.current = false;
    });
    return () => {
      unsubscribeCommand?.();
      unsubscribeClose?.();
    };
  }, [persist]);
  useEffect(() => {
    if (!menu) return;
    document.querySelector('.context-menu button:not(:disabled)')?.focus();
    const dismiss = (event) => {
      if (!event.target.closest(".context-menu")) setMenu(null);
    };
    window.addEventListener("pointerdown", dismiss);
    return () => window.removeEventListener("pointerdown", dismiss);
  }, [menu]);
  useEffect(() => {
    setQuote(null);
    setContextOpen(false);
    setEditMessage(null);
    setOverviewOpen(false);
    setSummaryExpanded(false);
    anchorClear.current?.();
  }, [activeId, workspace?.activeBoardId]);
  useEffect(()=>{setContextPicker(false);},[activeId,workspace?.activeBoardId]);
  useEffect(()=>{if(compareSession?.boardId!==workspace?.activeBoardId)setCompareOpen(false);setResumeOpen(false);setPathFocus(false);},[workspace?.activeBoardId]);
  useEffect(() => {
    setHovered(null);
    setMenu(null);
  }, [workspace?.activeBoardId]);
  useLayoutEffect(() => {
    const scroll=panelRef.current?.querySelector('.chat-scroll');
    if(!active||!scroll){chatScrollNode.current=null;return;}
    const changed=chatScrollNode.current!==active?.id;
    chatScrollNode.current=active?.id;
    if(changed){
      const saved=scrollPositions.current.get(active.id);
      scroll.scrollTop=saved?.top ?? (active.kind==='conclusion'?0:scroll.scrollHeight);
      pinnedToBottom.current=saved?.pinned ?? active.kind!=='conclusion';
    }else if(pinnedToBottom.current){
      scroll.scrollTop=scroll.scrollHeight;
    }
    setShowLatest(scroll.scrollHeight-scroll.clientHeight-scroll.scrollTop>100);
  }, [activeId, active?.messages.length, active?.messages.at(-1)?.content, busyNode]);
  useLayoutEffect(()=>{
    if(agentPending&&activeAgent?.nodeId===activeId&&pinnedToBottom.current)focusAgentApproval();
  },[agentPending?.callId,activeId]);
  useEffect(() => {
    if (!jumpTarget || activeId !== jumpTarget.nodeId) return;
    const target = [...(panelRef.current?.querySelectorAll('.message[data-message-id]') || [])].find((el)=>el.dataset.messageId===jumpTarget.messageId);
    if (target) {
      anchorClear.current?.();
      const result = focusRenderedAnchor(target,jumpTarget,{reduceMotion:settings?.reduceMotion});
      anchorClear.current = result.clear;
      if (!result.precise) notify('已定位来源消息；原片段在当前渲染中无法精确匹配。');
    } else {
      setSourceSnapshot({context:jumpTarget.snapshot || [],title:jumpTarget.sourceTitle,shown:20,reason:jumpTarget.reason,quote:jumpTarget.quote,index:jumpTarget.contextIndex});
      notify(jumpTarget.reason === 'edited' ? '来源消息已被编辑，已打开分支创建时的原始快照。' : '原锚点属于继承历史或已无法匹配，已打开保存的快照。');
    }
    setJumpTarget(null);
  }, [jumpTarget,activeId]);
  const fit = useCallback(
    (nodes, panel = false) => {
      if (!stageRef.current || !nodes?.length) return;
      const rect = stageRef.current.getBoundingClientRect();
      const width =
          rect.width -
          (panel && rect.width > 800 ? Math.min(panelWidth, rect.width * 0.85) : 0),
        height = rect.height;
      const minX = Math.min(...nodes.map((n) => n.x)),
        minY = Math.min(...nodes.map((n) => n.y));
      const maxX = Math.max(...nodes.map((n) => n.x + getNodeSize(n).width)),
        maxY = Math.max(...nodes.map((n) => n.y + getNodeSize(n).height));
      const zoom = Math.max(
        0.15,
        Math.min(
          1,
          (width - 130) / (maxX - minX),
          (height - 170) / (maxY - minY),
        ),
      );
      updateBoard((b) => {
        b.viewport = {
          x: (width - (maxX - minX) * zoom) / 2 - minX * zoom,
          y: (height - (maxY - minY) * zoom) / 2 - minY * zoom,
          zoom,
        };
      });
    },
    [update, workspace?.activeBoardId, panelWidth],
  );
  useEffect(() => {
    const key = (e) => {
      if (closeInProgress.current) return;
      if (e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229 || e.key === 'Process' || e.key === 'Dead') return;
      const input =
        Boolean(e.target.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]'));
      if (e.key === "Escape" && !e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey) {
        if (document.querySelector('.modal-shade')) return;
        if (editMessage) setEditMessage(null);
        else if (menu) setMenu(null);
        else if (quote) setQuote(null);
        else if (search) setSearch("");
        else if (!input) {rememberReadingPosition();setActiveId(null);}
        return;
      }
      if (e.defaultPrevented || e.repeat || e.isComposing || e.keyCode === 229 ||
          e.getModifierState?.('AltGraph') || drag.current || document.querySelector('.modal-shade')) return;
      const bindings = resolveShortcuts(settingsRef.current?.shortcuts);
      const action = SHORTCUT_ACTIONS.find((item) => matchShortcut(e, bindings[item.id]));
      const editingKey = ['Delete','Backspace','Enter'].includes(e.key) ||
        ((e.ctrlKey || e.metaKey) && (/^[acvxyz]$/i.test(e.key) || /^Key[ACVXYZ]$/.test(e.code)));
      if (input && editingKey) return;
      if (!action || (input && action.scope !== 'global')) return;
      if (actionRunner.current(action.id, { fromKeyboard: true, event: e })) {
        e.preventDefault(); e.stopPropagation();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [
    board,
    fit,
    dialog,
    showSettings,
    help,
    globalSearch,
    management,
    mergeTarget,
    editMessage,
    menu,
    quote,
    search,
    collapsed,
  ]);
  const switchBoard = (id) => {
    rememberReadingPosition();
    setActiveId(null);
    setSearch("");
    setMenu(null);
    update((ws) => {
      ws.activeBoardId = id;
    });
  };
  const rememberReadingPosition = () => {
    const scroll=panelRef.current?.querySelector('.chat-scroll');
    if(activeId&&scroll){
      scrollPositions.current.set(activeId,{top:scroll.scrollTop,pinned:pinnedToBottom.current});
      previousReadingNode.current={boardId:board.id,nodeId:activeId};
    }
  };
  const openNode = (node) => {
    if (dragMoved.current) return;
    if(node.id!==activeId)rememberReadingPosition();
    setActiveId(node.id);
    const boardId=wsRef.current.activeBoardId;
    setLastVisits((visits)=>({...visits,[boardId]:{nodeId:node.id,at:time()}}));
    setQuote(null);
    setRequestError(null);
  };
  const revealNode = (node, boardId = board.id) => {
    if (!node) return;
    const targetBoard = wsRef.current.boards.find(
      (item) => item.id === boardId,
    );
    if (!targetBoard) return;
    const ancestors = new Set();
    let parent = targetBoard.nodes.find((item) => item.id === node.parentId);
    while (parent) {
      ancestors.add(parent.id);
      parent = targetBoard.nodes.find((item) => item.id === parent.parentId);
    }
    setCollapsedByBoard((state) => ({
      ...state,
      [boardId]: (state[boardId] || []).filter((id) => !ancestors.has(id)),
    }));
    if (boardId !== wsRef.current.activeBoardId) switchBoard(boardId);
    openNode(node);
    fit([node], true);
  };
  const jumpToBranchOrigin = (sourceNode) => {
    const b = wsRef.current.boards.find((b)=>b.id===board.id);
    if(!b || !sourceNode?.source) return;
    const result = resolveSourceAnchor(b,sourceNode);
    const parent = b.nodes.find((n)=>n.id===result.nodeId);
    if(!parent) { setOverviewOpen(false);setSourceSnapshot({context:sourceNode.source.context,title:sourceNode.title,shown:20,reason:'missing',quote:sourceNode.source.quote,index:result.contextIndex});return; }
    if(active&&active.id!==parent.id)setSourceReturn({boardId:board.id,nodeId:active.id,title:active.title});
    revealNode(parent);
    setOverviewOpen(false);
    setJumpTarget({...result, messageId:result.resolved ? result.messageId : null, snapshot:sourceNode.source.context,sourceTitle:sourceNode.title});
  };
  const jumpFromOverview = (payload) => {
    const child = board.nodes.find((n)=>n.id===payload.sourceNodeId);
    if(child) jumpToBranchOrigin(child);
    else { const node=board.nodes.find((n)=>n.id===payload.nodeId);if(node) revealNode(node);notify('仅定位到会话，缺少可验证的原始锚点。'); }
  };
  const toggleCollapsed = (nodeId) => {
    setCollapsedByBoard((state) => {
      const ids = state[board.id] || [];
      return {
        ...state,
        [board.id]: ids.includes(nodeId)
          ? ids.filter((id) => id !== nodeId)
          : [...ids, nodeId],
      };
    });
    if (
      !collapsed.includes(nodeId) &&
      activeId !== nodeId &&
      getDescendantIds(board, nodeId).includes(activeId)
    )
      setActiveId(nodeId);
  };
  const showMenu = (event, type, id) => {
    event.preventDefault();
    event.stopPropagation();
    menuTrigger.current=event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setMenu({
      type,
      id,
      x: Math.min(window.innerWidth - 320, event.type === 'contextmenu' && event.clientX ? event.clientX : rect.right - 10),
      y: Math.max(40,Math.min(window.innerHeight - (type === 'node' ? 443 : 210), event.type==='contextmenu'&&event.clientY?event.clientY:rect.bottom + 5)),
    });
  };
  const copyNode = (nodeId) => {
    try {
      const source = board.nodes.find((n) => n.id === nodeId);
      if (board.status !== 'active' || source?.status !== 'active') throw new Error('请先恢复对话再复制分支');
      const result = duplicateSubtree(wsRef.current, {
        boardId: wsRef.current.activeBoardId,
        nodeId,
      });
      update((ws) => Object.assign(ws, result.workspace));
      const copied = result.workspace.boards
        .find((item) => item.id === wsRef.current.activeBoardId)
        .nodes.find((item) => item.id === result.nodeId);
      revealNode(copied);
      notify("已复制此对话和全部子分支");
    } catch (error) {
      notify(error.message);
    }
    setMenu(null);
  };
  const copyBoard = (boardId) => {
    try {
      const result = duplicateBoard(wsRef.current, boardId);
      update((ws) => Object.assign(ws, result.workspace));
      setActiveId(null);
      notify("画布已复制");
    } catch (error) {
      notify(error.message);
    }
    setMenu(null);
  };
  const changeBoardStatus = (boardId, status) => {
    const target = wsRef.current.boards.find((item) => item.id === boardId);
    setMenu(null);
    if (target.nodes.some((node) => node.id === busyNode)) {
      notify("请先停止该画布的生成");
      return;
    }
    setDialog({
      title: status === 'archived' ? '归档这张画布？' : '删除这张画布？',
      description: status === 'archived' ? `「${target.title}」将隐藏在归档中，内容仍会保存，可以恢复。` : `「${target.title}」及其全部会话将移入回收站，可以恢复。`,
      danger: status === 'trashed',
      button: status === 'archived' ? '归档画布' : '移入回收站',
      confirm: () => {
        try {
          const next = setBoardStatus(wsRef.current, { boardId, status });
          if (next.activeBoardId === boardId) {
            let replacement = next.boards.find((b) => b.status === 'active');
            if (!replacement && next.boards.length < 100) { replacement = createBoard(); next.boards.push(replacement); }
            if (replacement) next.activeBoardId = replacement.id;
          }
          update((ws) => Object.assign(ws, next));
          setActiveId(null);
          setUndo(null);
          notify(status === 'archived' ? '画布已归档' : '画布已移入回收站');
        } catch (error) {
          notify(error.message);
        }
      },
    });
  };
  const deleteBoard = (boardId) => changeBoardStatus(boardId, 'trashed');
  const newConversation = () => {
    if (board.status !== 'active') { notify('请先恢复画布再新建会话'); return; }
    let node;
    updateBoard((b) => { node = createNode(b);if(settingsRef.current?.autoLayout!==false)arrangeBoard(b); });
    revealNode(node);
    setTimeout(() => composerRef.current?.focus(), 0);
  };
  const newBoard = () =>
    setDialog({
      title: "新建画布",
      value: "",
      placeholder: "给这次探索起个名字",
      confirm: (value) => {
        rememberReadingPosition();
        const b = createBoard(value || "未命名画布");
        update((ws) => {
          ws.boards.push(b);
          ws.activeBoardId = b.id;
        });
        setActiveId(b.nodes[0].id);
      },
    });
  const rename = (type, id, title) =>
    setDialog({
      title: type === "board" ? "重命名画布" : "重命名对话",
      value: title,
      confirm: (value) => {
        if (!value.trim()) return;
        update((ws) => {
          if (type === "board")
            ws.boards.find((b) => b.id === id).title = value.trim();
          else
            ws.boards
              .find((b) => b.id === ws.activeBoardId)
              .nodes.find((n) => n.id === id).title = value.trim();
        });
      },
    });
  const addBranch = (parent, messageId = null, text = "", anchor = null, focusText) => {
    if (parent.status !== 'active' || board.status !== 'active') { notify('请先恢复对话再创建分支'); return; }
    let node;
    updateBoard((b) => {
      node = createRequestBranch(b, { parentId: parent.id, messageId, quote: text.slice(0,LIMITS.contentLength), anchor:anchor || (text ? {kind:'text',occurrence:0} : {kind:'after'}), ...(focusText===undefined?{}:{focusText}) });
      node.executionMode=parent.executionMode||'chat';
      let overlapping;
      while ((overlapping = b.nodes.filter((n) => n.id !== node.id &&
        node.x < n.x + getNodeSize(n).width + 30 && node.x + getNodeSize(node).width + 30 > n.x &&
        node.y < n.y + getNodeSize(n).height + 35 && node.y + getNodeSize(node).height + 35 > n.y)).length)
        node.y = Math.max(...overlapping.map((n) => n.y + getNodeSize(n).height + 55));
      if(settingsRef.current?.autoLayout!==false)arrangeBoard(b);
    });
    revealNode(node);
    setQuote(null);
    window.getSelection()?.removeAllRanges();
    notify("新分支已创建，继承截至此处的上下文");
    if(!isDemoBoard(board))summariesRef.current.enqueue(board.id, [node.id, parent.id]);
    setTimeout(() => composerRef.current?.focus(), 50);
  };
  const selectQuote = (event, message) => {
    if (active?.status !== 'active' || board.status !== 'active') return;
    const selection = window.getSelection();
    const text = selection?.toString().trim();
    if (
      !text ||
      !selection.rangeCount ||
      !event.currentTarget.contains(selection.anchorNode) ||
      !event.currentTarget.contains(selection.focusNode)
    ) {
      setQuote(null);
      return;
    }
    const box = selection.getRangeAt(0).getBoundingClientRect();
    const range = selection.getRangeAt(0);
    const content = event.currentTarget.querySelector('.message-content') || event.currentTarget;
    const table = (selection.anchorNode.nodeType===1 ? selection.anchorNode : selection.anchorNode.parentElement)?.closest('table');
    const anchor = table && table.contains(selection.focusNode) ? {kind:'table',blockIndex:[...content.querySelectorAll('table')].indexOf(table)} : captureTextAnchor(content,range,text);
    setQuote({
      messageId: message.id,
      text: text.slice(0, 100000),
      anchor,
      x: Math.max(8, Math.min(window.innerWidth - 200, box.x)),
      y: Math.max(8, box.y - 44),
    });
  };
  const changeNodeStatus = (node, status) => {
    const ids = new Set([node.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const n of board.nodes)
        if (ids.has(n.parentId) && !ids.has(n.id)) {
          ids.add(n.id);
          changed = true;
        }
    }
    if (ids.has(busyNode)) {
      notify("请先停止这个分支的生成");
      return;
    }
    setDialog({
      title: status === 'archived' ? '归档这条分支？' : '删除这条分支？',
      description: `「${node.title}」及其 ${ids.size - 1} 个子分支将${status === 'archived' ? '归档隐藏' : '移入回收站'}，内容可以恢复。`,
      danger: status === 'trashed',
      button: status === 'archived' ? '归档分支' : '移入回收站',
      confirm: () => {
        const previous = {
          boardId: board.id,
          nodes: board.nodes.filter((n) => ids.has(n.id)).map((n) => ({ id: n.id, status: n.status, archivedAt: n.archivedAt, deletedAt: n.deletedAt })),
        };
        const next = setNodeStatus(wsRef.current, { boardId: board.id, nodeId: node.id, status });
        update((ws) => Object.assign(ws, next));
        if (ids.has(activeId)) setActiveId(null);
        setUndo(previous);
        notify(status === 'archived' ? '分支已归档，可撤销' : '分支已移入回收站，可撤销');
      },
    });
  };
  const removeNode = (node) => changeNodeStatus(node, 'trashed');
  const [undo, setUndo] = useState(null);
  const undoDelete = () => {
    if (!undo || busyNode) return;
    try {
      update((ws) => {
        const b = ws.boards.find((b) => b.id === undo.boardId);
        for (const previous of undo.nodes) { const n = b?.nodes.find((n) => n.id === previous.id); if (n) Object.assign(n, previous); }
      });
      setUndo(null);
      notify("已恢复移除的内容");
    } catch (error) {
      notify(error.message);
    }
  };
  const openMerge = (nodeId) => { setMergeTarget({ boardId: board.id, nodeId }); setMergeSelection([nodeId]); setMergeMode('new');setMergeMainId(nodeId);setMenu(null); };
  const commitMerge = () => {
    try {
      const primary = mergeSelection.includes(mergeMainId) ? mergeMainId : mergeSelection[0];
      const nodeIds = [primary,...mergeSelection.filter((id)=>id!==primary)];
      const result = mergeConversations(wsRef.current, { boardId: mergeTarget.boardId, nodeIds, mode:mergeMode, targetId:primary });
      if(result.changed===false) {setMergeTarget(null);notify('这些来源没有新的差异内容，无需重复追加或重新总结');return;}
      update((ws) => Object.assign(ws, result.workspace));
      const b = result.workspace.boards.find((b) => b.id === mergeTarget.boardId), n = b.nodes.find((n) => n.id === result.nodeId);
      revealNode(n, b.id); if(!isDemoBoard(b))summariesRef.current.enqueue(b.id, mergeMode==='append' ? [n.id] : [n.id,primary]);
      if(mergeMode==='append'&&n.contextPolicy?.mode!=='full')setContextPicker(true);
      setMergeTarget(null); notify(result.changed===false ? '这些来源没有新的差异内容，无需重复追加' : mergeMode==='append' ? '已把来源分支的新差异追加到所选主干，已有消息保持原样' : '已创建合并会话，保留主干前缀并追加其余分支差异');
    } catch (error) { notify(error.message); }
  };
  const restoreEntry = (boardId, nodeId = null) => {
    try {
      let next = setBoardStatus(wsRef.current, { boardId, status: 'active' });
      if (nodeId) {
        next = setNodeStatus(next, { boardId, nodeId, status: 'active' });
        const b = next.boards.find((b) => b.id === boardId); let n = b.nodes.find((n) => n.id === nodeId);
        while (n?.parentId) { n = b.nodes.find((p) => p.id === n.parentId); if (n) { n.status='active'; n.archivedAt=null; n.deletedAt=null; } }
      }
      next.activeBoardId = boardId; update((ws) => Object.assign(ws, next)); setManagement(null);
      if (nodeId) revealNode(next.boards.find((b)=>b.id===boardId).nodes.find((n)=>n.id===nodeId), boardId);
      notify('已恢复');
    } catch (error) { notify(error.message); }
  };
  const purgeEntry = (boardId, nodeId = null) => {
    setDialog({ title:'永久删除？', description:'这会永久删除选中的回收站内容，无法在应用中恢复。已有合并会话的上下文快照会保留。', danger:true, button:'永久删除', confirm:()=>{
      try { const next = nodeId ? purgeNode(wsRef.current,{boardId,nodeId}) : purgeBoard(wsRef.current,boardId); update((ws)=>Object.assign(ws,next)); setUndo(null); notify('已永久删除'); } catch(error){notify(error.message);}
    }});
  };
  const send = async (retry = false, regenerateId = null, {mode} = {}) => {
    if (!active || active.status !== 'active' || board.status !== 'active' || busyNode || abort.current || closeInProgress.current) return;
    const isAgent=mode?mode==='agent':active.executionMode==='agent';
    if(isAgent&&(!settingsRef.current?.agentEnabled||!settingsRef.current?.agentAvailable||!settingsRef.current?.agentWorkspace)){
      setSettingsSection('agent');setShowSettings(true);notify('请先启用 Agent 并选择工作目录；直接聊天可以继续使用。');return;
    }
    const content = active.draft.trim();
    const replacedId = isAgent?null:
      regenerateId || (retry ? requestError?.regenerateId : null);
    if (!retry && !replacedId && !content) return;
    pinnedToBottom.current=true;
    const boardId = board.id,
      nodeId = active.id,
      assistantId = newId();
    const retryId = retry ? requestError?.assistantId : null;
    const runId=isAgent?newId():null;
    const startedAt=time();
    summariesRef.current.pause();
    setRequestError(null);
    setBusyNode(nodeId);
    setQuote(null);
    const controller = new AbortController();
    let cancelAgent=Promise.resolve();
    const onAbortAgent=()=>{cancelAgent=api('/api/agent/cancel',{method:'POST',body:JSON.stringify({runId})}).catch(()=>{});};
    if(isAgent){controller.signal.addEventListener('abort',onAbortAgent,{once:true});setActiveAgent({runId,boardId,nodeId,status:'running'});setAgentPending(null);}
    abort.current = controller;
    let completeGeneration;
    generationDone.current = new Promise((resolve) => {
      completeGeneration = resolve;
    });
    let completed = false;
    let messages;
    updateBoard((b) => {
      const n = b.nodes.find((n) => n.id === nodeId);
      if (retryId&&!isAgent) {
        n.messages = n.messages.filter((m) => m.id !== retryId);
        for (const child of b.nodes)
          if (child.parentId === nodeId && child.source?.messageId === retryId)
            child.source.messageId = assistantId;
      }
      if (isAgent&&retry) {
        n.messages.push({id:newId(),role:'user',content:'继续完成上一轮 Agent 请求。先检查已经完成的操作和文件现状，避免重复执行有副作用的动作。',createdAt:time()});
      }else if (!retry && !replacedId) {
        n.messages.push({
          id: newId(),
          role: "user",
          content,
          createdAt: time(),
        });
        n.draft = "";
        if (n.title === "新的对话" || n.title === "新的分支")
          n.title = short(content, 28);
      }
      messages = buildRequestContext(
        {
          ...b,
          nodes: b.nodes.map((item) =>
            item.id === nodeId
              ? {
                  ...item,
                  messages: item.messages.filter(
                    (message) => message.id !== replacedId,
                  ),
                }
              : item,
          ),
        },
        nodeId,
      );
      n.messages.push({
        id: assistantId,
        role: "assistant",
        content: "",
        createdAt: time(),
        ...(isAgent?{agentRun:{id:runId,engine:'compatible',status:'running',startedAt,steps:0,events:[],artifacts:[]}}:{}),
      });
    });
    const editAnswer = (fn) =>
      update((ws) => {
        const b = ws.boards.find((b) => b.id === boardId);
        const n = b?.nodes.find((n) => n.id === nodeId);
        if (n) {
          fn(n, b);
          b.updatedAt = time();
        }
      });
    try {
      const response = await fetch(isAgent?'/api/agent/run':"/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages,...(isAgent?{runId}: {}) }),
        signal: controller.signal,
      });
      await readChatStream(response, (delta) =>
        editAnswer((n) => {
          const m = n.messages.find((m) => m.id === assistantId);
          if (m) {
            if (m.content.length + delta.length > 100000) {
              controller.abort();
              throw new Error(
                "回答达到 100000 字符上限，已保留收到的内容。请从这里建立分支继续。",
              );
            }
            m.content += delta;
          }
        }),
        (usage)=>editAnswer((n)=>{const m=n.messages.find((m)=>m.id===assistantId);if(m)m.usage=usage;}),
        isAgent?(event)=>{
          if(!isAgent||event?.runId!==runId)return;
          if(event.type==='approval.required'){
            setAgentPending({runId,callId:event.callId,tool:event.tool,summary:event.summary,preview:event.preview});
            setActiveAgent({runId,boardId,nodeId,status:'awaiting-approval'});
          }else if(event.type.startsWith('tool.')||event.type==='run.finished'){
            setAgentPending((pending)=>pending?.runId===runId&&(event.type==='run.finished'||pending.callId===event.callId)?null:pending);
            if(event.type!=='run.finished')setActiveAgent({runId,boardId,nodeId,status:'running'});
          }
          editAnswer((n)=>{
            const run=n.messages.find((m)=>m.id===assistantId)?.agentRun;
            if(!run)return;
            const at=event.at||time();
            if(event.type==='model.started')run.steps=event.step;
            if(event.type==='run.started')run.events.push({id:`root_${runId}`,tool:'workspace',status:'completed',summary:'本次工作目录',detail:event.workspace,at});
            if(event.type==='approval.required'||event.type.startsWith('tool.')){
              const states={'approval.required':'awaiting-approval','tool.started':'running','tool.completed':'completed','tool.denied':'denied','tool.failed':'failed','tool.cancelled':'cancelled'};
              const status=states[event.type];
              if(status){let entry=run.events.find((item)=>item.id===event.callId);if(!entry){entry={id:event.callId,tool:event.tool,status,summary:String(event.summary||event.tool).slice(0,500),at};run.events.push(entry);}Object.assign(entry,{status,at,...(event.detail?{detail:String(event.detail).replace(/\0/g,'�').slice(0,12000)}:{})});}
            }
            if(event.type==='artifact'&&!run.artifacts.some((item)=>item.path===event.path&&item.kind===event.kind))run.artifacts.push({path:event.path,kind:event.kind,summary:String(event.summary||'').slice(0,500)});
            if(event.type==='run.finished'){run.status=event.status;run.steps=event.steps;run.finishedAt=at;}
          });
        }:undefined,
      );
      const generated = wsRef.current.boards
        .find((item) => item.id === boardId)
        ?.nodes.find((item) => item.id === nodeId)
        ?.messages.find((message) => message.id === assistantId);
      if (!generated?.content.trim()&&!(isAgent&&generated?.agentRun?.status==='completed'))
        throw new Error("模型返回了空回答，请检查连接后重试。");
      completed = true;
    } catch (error) {
      if (error.name !== "AbortError")
        setRequestError({
          nodeId,
          assistantId,
          regenerateId: replacedId,
          text: `${error.message}${replacedId ? " 原回答已保留。" : ""}`,
          agent:isAgent,
        });
      else notify("已停止生成，已收到的内容会保留");
    } finally {
      if(isAgent&&controller.signal.aborted)await cancelAgent;
      editAnswer((n, b) => {
        if (completed && replacedId) {
          n.messages = n.messages.filter(
            (message) => message.id !== replacedId,
          );
          const answer = n.messages.find(
            (message) => message.id === assistantId,
          );
          if (answer) answer.id = replacedId;
          for (const child of b.nodes)
            if (
              child.parentId === nodeId &&
              child.source?.messageId === assistantId
            )
              child.source.messageId = replacedId;
        }
        const run=n.messages.find((m)=>m.id===assistantId)?.agentRun;
        if(run?.status==='running'){run.status=controller.signal.aborted?'cancelled':'failed';run.finishedAt=time();}
        if(run)for(const entry of run.events)if(['running','awaiting-approval'].includes(entry.status))entry.status=controller.signal.aborted?'cancelled':'failed';
        n.messages = n.messages.filter((m) => m.id !== assistantId || m.content.trim() || m.agentRun);
      });
      if(isAgent){controller.signal.removeEventListener('abort',onAbortAgent);setAgentPending((pending)=>pending?.runId===runId?null:pending);setActiveAgent(null);}
      setBusyNode(null);
      abort.current = null;
      completeGeneration();
      if (!closeInProgress.current) summariesRef.current.resume();
      const latestNode = wsRef.current.boards.find((b) => b.id === boardId)?.nodes.find((n) => n.id === nodeId);
      const mergeMessageIds = new Set(latestNode?.merges?.flatMap((record)=>record.messageIds) || []);
      const latestBoard=wsRef.current.boards.find((b)=>b.id===boardId);
      if (!closeInProgress.current && completed && latestNode?.kind!=='conclusion' && !isDemoBoard(latestBoard) && (!latestNode?.summary || latestNode.messages.filter((m) => m.role === 'user' && !mergeMessageIds.has(m.id)).length === 1 || replacedId)) summariesRef.current.enqueue(boardId, [nodeId]);
    }
  };
  const rerunAgent=()=>setDialog({title:'重新运行 Agent？',description:'已经完成的文件修改和命令不会自动撤销。将保留原运行记录，先检查当前状态，再创建一次新的运行；仍需逐次确认修改和命令。',button:'检查现状并继续',confirm:()=>send(true,null,{mode:'agent'})});
  const decideAgent=async(approved)=>{
    if(!agentPending||approvalBusy)return;
    const pending=agentPending;setApprovalBusy(true);pinnedToBottom.current=true;
    try{await api('/api/agent/approve',{method:'POST',body:JSON.stringify({runId:pending.runId,callId:pending.callId,approved})});setAgentPending((value)=>value?.runId===pending.runId&&value.callId===pending.callId?null:value);}
    catch(error){if(error.status===409){setAgentPending((value)=>value?.runId===pending.runId&&value.callId===pending.callId?null:value);notify(error.message);}else throw error;}
    finally{setApprovalBusy(false);}
  };
  const exportWorkspace = async () => {
    try {
      const saved = await download(
        `枝间-工作区-${new Date().toISOString().slice(0, 10)}.json`,
        JSON.stringify(
          { ...wsRef.current, revision: revision.current },
          null,
          2,
        ),
      );
      if (saved) notify("已导出工作区，不包含 API 密钥");
    } catch (error) {
      notify(`导出失败：${error.message}`);
    }
  };
  const importWorkspace = async (event = null) => {
    if (closeInProgress.current) return;
    let file = event?.target.files?.[0];
    if (event) event.target.value = "";
    if (!event && window.branchDesktop?.openFile) {
      try {
        const opened = await window.branchDesktop.openFile();
        if (!opened) return;
        file = {
          size: new Blob([opened.text]).size,
          text: async () => opened.text,
        };
      } catch (error) {
        notify(`导入失败：${error.message}`);
        return;
      }
    } else if (!event) {
      fileInput.current.click();
      return;
    }
    if (!file) return;
    if (busyNode) {
      notify("请先停止生成再导入");
      return;
    }
    try {
      if (file.size > 64 * 1024 * 1024)
        throw new Error("导入文件不能超过 64 MB");
      const imported = validateWorkspace(JSON.parse(await file.text()));
      for(const b of imported.boards)for(const node of b.nodes)for(const message of node.messages)if(message.agentRun?.status==='running')message.agentRun=normalizeAgentRunForLoad(message.agentRun);
      if (closeInProgress.current) return;
      const merged = mergeWorkspace(wsRef.current, imported);
      update((ws) => {
        Object.assign(ws, merged);
      });
      setActiveId(null);
      notify(`已导入 ${imported.boards.length} 个画布`);
    } catch (error) {
      notify(`导入失败：${error.message}`);
    }
  };
  const exportMarkdown = async (target = active) => {
    const conversation = target?.id ? target : active;
    if (!conversation) return;
    const nodes = [];
    let n = conversation;
    while (n) {
      nodes.unshift(n);
      n = board.nodes.find((p) => p.id === n.parentId);
    }
    const context = buildContext(board, conversation.id);
    try {
      const saved = await download(
        `${conversation.title.replace(/[<>:"/\\|?*]/g, "-")}.md`,
        conversation.kind==='conclusion' ? conclusionMarkdown(conversation,board) : `# ${conversation.title}\n\n> 分支路径：${nodes.map((n) => n.title).join(" → ")}\n\n${context.map((m) => `## ${m.role === "user" ? "你" : m.role === "assistant" ? "AI" : "分支上下文"}\n\n${m.content}`).join("\n\n---\n\n")}`,
        "text/markdown;charset=utf-8",
      );
      if (saved) notify("已导出当前对话");
    } catch (error) {
      notify(`导出失败：${error.message}`);
    }
  };
  const openComparison = () => {
    if(busyNode){notify('请先停止当前回答，再比较分支。');return;}
    if(board.status!=='active'){notify('请先恢复画布。');return;}
    if(compareSession?.boardId!==board.id)setCompareSession({boardId:board.id,selection:active&&active.kind!=='conclusion'?[active.id]:[],result:null,items:[],title:''});
    setResumeOpen(false);setCompareOpen(true);setMenu(null);
  };
  const saveComparison = (comparison) => {
    try {
      const currentBoard=wsRef.current.boards.find((entry)=>entry.id===board.id);
      if(comparisonFingerprint(currentBoard,comparison.sourceNodeIds)!==comparison.fingerprint)throw new Error('来源会话已变化，请重新比较后再保存。');
      const result=createConclusion(wsRef.current,{boardId:board.id,nodeIds:comparison.sourceNodeIds,title:comparison.title,items:comparison.items,model:comparison.model,fingerprint:comparison.fingerprint,createdAt:comparison.createdAt});
      const b=result.workspace.boards.find((entry)=>entry.id===board.id),node=b.nodes.find((entry)=>entry.id===result.nodeId);
      for(const item of node.conclusion.items){const reviewed=comparison.items.find((entry)=>entry.id===item.id);item.verified=reviewed?.verified===true;item.adopted=reviewed?.adopted===true;}
      syncConclusionMessages(node);
      if(settingsRef.current?.autoLayout!==false)arrangeBoard(b);
      const validated=validateWorkspace(result.workspace);update((ws)=>Object.assign(ws,validated));
      setCompareOpen(false);setCompareSession(null);revealNode(node);notify('已保存结论卡；可继续核对依据或导出。');
    }catch(error){notify(error.message);}
  };
  const changeConclusionItem = (id,patch) => {
    updateBoard((b)=>{const node=b.nodes.find((entry)=>entry.id===activeId);if(!node?.conclusion)return;const item=node.conclusion.items.find((entry)=>entry.id===id);if(!item)return;Object.assign(item,patch);if(patch.text!==undefined&&node.researchStatus==='adopted')node.researchStatus='verify';syncConclusionMessages(node);});
  };
  const jumpToCitation = (citation) => {
    setCompareOpen(false);setResumeOpen(false);
    const source=board.nodes.find((node)=>node.id===citation.nodeId);
    if(active&&source&&active.id!==source.id)setSourceReturn({boardId:board.id,nodeId:active.id,title:active.title});
    const message=citation.messageId?source?.messages.find((entry)=>entry.id===citation.messageId):null;
    const matches=message&&message.content.replace(/\s+/g,' ').includes(citation.quote.replace(/\s+/g,' '));
    if(source&&matches){revealNode(source);setJumpTarget({nodeId:source.id,messageId:message.id,quote:citation.quote,anchor:{kind:'text',occurrence:0}});}
    else {if(source)revealNode(source);setSourceSnapshot({context:citation.contextIndex!==undefined&&source?.source?.context?.[citation.contextIndex]?[source.source.context[citation.contextIndex]]:[],title:titleOfSource(source),shown:20,quote:citation.quote,reason:'citation'});}
  };
  const titleOfSource=(source)=>source?.summary?.title || source?.title || '原来源会话';
  const importMaterials = async () => {
    if(!active || readOnly || busyNode || materialBusy)return;
    if(!window.branchDesktop?.importMaterials){notify('资料导入请使用桌面应用。');return;}
    const boardId=board.id,nodeId=active.id;setMaterialBusy(true);
    summariesRef.current.cancel();
    try {
      const imported=await window.branchDesktop.importMaterials();
      if(imported.canceled || closeInProgress.current)return;
      const next=clone(wsRef.current),b=next.boards.find((entry)=>entry.id===boardId),node=b?.nodes.find((entry)=>entry.id===nodeId);
      if(!node || b.status!=='active' || node.status!=='active')throw new Error('原会话已不可编辑，请重新选择。');
      for(const document of imported.documents)for(const part of document.parts)node.messages.push({id:newId(),role:'user',content:`【本地资料：${document.name}${part.page?`；第 ${part.page} 页`:''}】\n\n${part.text}`,createdAt:time(),material:{name:document.name,kind:document.kind,...(part.page?{page:part.page}:{})}});
      b.updatedAt=time();const validated=validateWorkspace(next);update((ws)=>Object.assign(ws,validated));
      notify(`已导入 ${imported.documents.length} 份本地资料；后续回答、比较或摘要会使用所选内容。`);
    }catch(error){notify(`资料导入失败：${error.message}`);}finally{setMaterialBusy(false);}
  };
  const startOfflineDemo = () => {
    const demo=createBoard('离线体验：分支、比较与结论',{demo:true});
    update((ws)=>{ws.boards.push(demo);ws.activeBoardId=demo.id;});
    const first=demo.nodes[0],left=demo.nodes[1],right=demo.nodes[2],ids=[left.id,right.id];
    const result={title:'演示结论：独立探索并保留依据',sourceNodeIds:ids,model:'内置演示（未调用模型）',fingerprint:comparisonFingerprint(demo,ids),createdAt:time(),items:[
      {id:newId(),category:'agreement',text:'两条讨论都保留共同起点，可以独立深入。',citations:[{nodeId:left.id,contextIndex:1,quote:'分支让不同思路保留各自的上下文'}]},
      {id:newId(),category:'difference',text:'一条讨论比较保存方案，另一条讨论分支如何继承上下文。',citations:[{nodeId:left.id,messageId:left.messages[1].id,quote:'一条分支研究本地文件，另一条研究数据库'},{nodeId:right.id,messageId:right.messages[1].id,quote:'父对话之后的新消息和其他分支不会混入'}]},
      {id:newId(),category:'open',text:'这是静态示例；真实方案的成本与失败条件仍需要进一步验证。',citations:[{nodeId:left.id,contextIndex:1,quote:'这是内置演示内容，尚未调用 AI 模型。'}]},
    ]};
    setCompareSession({boardId:demo.id,selection:ids,result,title:result.title,items:result.items.map((item)=>({...item,included:true,verified:false,adopted:false}))});
    setActiveId(first.id);setResumeOpen(false);setCompareOpen(true);notify('离线演示：可查看依据、修改草稿并保存结论，不会调用模型。');
  };
  actionRunner.current = (id, { event } = {}) => {
    if (!board || closeInProgress.current || drag.current || document.querySelector('.modal-shade')) return false;
    if(id==='import-materials'){void importMaterials();return true;}
    const definition = SHORTCUT_ACTIONS.find((item) => item.id === id);
    if (!definition) return false;
    const focus = event?.target?.closest ? event.target : document.activeElement;
    if (definition.scope !== 'global' && focus?.closest?.('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"]')) return false;
    const focusedNode = focus?.closest?.('[data-node-id]')?.dataset.nodeId;
    const focusedBoard = focus?.closest?.('[data-board-id]')?.dataset.boardId;
    const context = menu || (focusedNode ? { type:'node', id:focusedNode } : focusedBoard ? {type:'board',id:focusedBoard} : {type:'node',id:activeId});
    const targetBoard = context.type === 'board' ? workspace.boards.find((b) => b.id === context.id) : board;
    const node = context.type === 'node' ? board.nodes.find((n) => n.id === context.id) : null;
    const focusedMessage = !menu && node?.id === activeId ? focus?.closest?.('[data-message-id]')?.dataset.messageId : null;
    const globalActions = {
      'new-conversation':newConversation, 'new-board':newBoard,
      search:()=>setGlobalSearch(true), settings:()=>setShowSettings(true),
      'show-archive':()=>setManagement('archived'), 'show-trash':()=>setManagement('trashed'),
      import:()=>void importWorkspace(), export:()=>void exportWorkspace(), help:()=>setHelp(true),
      'undo-remove':()=>undoDelete(), fit:()=>fit(visibleNodes),
      arrange:()=>{updateBoard(arrangeBoard);fit(getVisibleNodes(wsRef.current.boards.find((b)=>b.id===board.id),collapsed));},
    };
    if (globalActions[id]) { setMenu(null); globalActions[id](); return true; }
    if (context.type === 'board' && ['rename','duplicate','archive','trash'].includes(id) && targetBoard) {
      setMenu(null);
      if(id==='rename') rename('board',targetBoard.id,targetBoard.title);
      if(id==='duplicate') copyBoard(targetBoard.id);
      if(id==='archive') changeBoardStatus(targetBoard.id,'archived');
      if(id==='trash') deleteBoard(targetBoard.id);
      return true;
    }
    if (!node) { notify('请先选择一张卡片或树目录中的会话'); return true; }
    if ((node.status !== 'active' || board.status !== 'active') && !['focus-node','export-conversation'].includes(id)) { notify('请先恢复会话再执行此操作'); return true; }
    setMenu(null);
    switch (id) {
      case 'branch': addBranch(node, quote && node.id === activeId ? quote.messageId : node.messages.some((m)=>m.id===focusedMessage) ? focusedMessage : null, quote && node.id === activeId ? quote.text : '', quote && node.id === activeId ? quote.anchor : null); break;
      case 'merge': if(busyNode) notify('请先停止生成再合并'); else openMerge(node.id); break;
      case 'rename': rename('node',node.id,node.title); break;
      case 'duplicate': copyNode(node.id); break;
      case 'summary': summaryJobs.enqueue(board.id,[node.id],{manual:true}); break;
      case 'archive': changeNodeStatus(node,'archived'); break;
      case 'trash': removeNode(node); break;
      case 'toggle-children': toggleCollapsed(node.id); break;
      case 'focus-node': fit([node],Boolean(activeId)); break;
      case 'focus-composer': revealNode(node);setTimeout(()=>composerRef.current?.focus(),0);break;
      case 'export-conversation': void exportMarkdown(node);break;
      default:return false;
    }
    return true;
  };
  const zoomAt = (factor, cx, cy) => {
    updateBoard((b) => {
      const v = b.viewport,
        zoom = Math.min(2, Math.max(0.15, v.zoom * factor));
      b.viewport = {
        x: cx - ((cx - v.x) * zoom) / v.zoom,
        y: cy - ((cy - v.y) * zoom) / v.zoom,
        zoom,
      };
    });
  };
  const panStart = (event) => {
    if (
      event.button !== 0 ||
      event.target.closest(
        ".node-card,.floating-control,.canvas-guide,.empty-canvas",
      )
    )
      return;
    const v = board.viewport;
    drag.current = {
      mode: "pan",
      startX: event.clientX,
      startY: event.clientY,
      x: v.x,
      y: v.y,
    };
    dragMoved.current = false;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
    setQuote(null);
  };
  const nodeDrag = (event, node) => {
    if (event.button !== 0 || event.target.closest("button")) return;
    event.stopPropagation();
    drag.current = {
      mode: "node",
      id: node.id,
      startX: event.clientX,
      startY: event.clientY,
      x: node.x,
      y: node.y,
    };
    dragMoved.current = false;
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const pointerMove = (event) => {
    const d = drag.current;
    if (!d) return;
    const dx = event.clientX - d.startX,
      dy = event.clientY - d.startY;
    if (!dragMoved.current && Math.abs(dx) + Math.abs(dy) < 4) return;
    dragMoved.current = true;
    if (d.mode === "pan")
      updateBoard((b) => {
        b.viewport.x = d.x + dx;
        b.viewport.y = d.y + dy;
      });
    else
      updateBoard((b) => {
        const n = b.nodes.find((n) => n.id === d.id);
        if (n) {
          if (d.mode === 'resize') {
            n.width = Math.round(Math.max(CARD_SIZE.minWidth, Math.min(CARD_SIZE.maxWidth, d.width + dx / b.viewport.zoom)));
            n.height = Math.round(Math.max(CARD_SIZE.minHeight, Math.min(CARD_SIZE.maxHeight, d.height + dy / b.viewport.zoom)));
          } else {
            n.x = d.x + dx / b.viewport.zoom;
            n.y = d.y + dy / b.viewport.zoom;
          }
        }
      });
  };
  const resizeCard = (event, node) => {
    if (event.button !== 0) return;
    event.preventDefault(); event.stopPropagation();
    drag.current = {mode:'resize', id:node.id, startX:event.clientX, startY:event.clientY, ...getNodeSize(node)};
    dragMoved.current = false; setDragging(true); setQuote(null);
    event.currentTarget.setPointerCapture(event.pointerId);
  };
  const resizeCardKey = (event, node) => {
    if (!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    updateBoard((b) => {
      const n = b.nodes.find((n) => n.id === node.id), size = getNodeSize(n);
      n.width = event.key === 'Home' ? CARD_SIZE.width : Math.max(CARD_SIZE.minWidth, Math.min(CARD_SIZE.maxWidth, size.width + (event.key === 'ArrowLeft' ? -20 : event.key === 'ArrowRight' ? 20 : 0)));
      n.height = event.key === 'Home' ? CARD_SIZE.height : Math.max(CARD_SIZE.minHeight, Math.min(CARD_SIZE.maxHeight, size.height + (event.key === 'ArrowUp' ? -20 : event.key === 'ArrowDown' ? 20 : 0)));
    });
  };
  const pointerEnd = (event) => {
    if (drag.current?.mode === "pan" && !dragMoved.current) setActiveId(null);
    drag.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    setTimeout(() => {
      dragMoved.current = false;
    }, 0);
  };
  if (loadError)
    return (
      <div className="boot-screen">
        <Sprout size={42} />
        <h1>暂时无法打开本地工作区</h1>
        <p>{loadError}</p>
        <button
          className="button primary"
          onClick={() => window.location.reload()}
        >
          重新连接
        </button>
        <p className="muted">请确认本地服务正在运行，且 data 目录可读写。</p>
      </div>
    );
  if (!board)
    return (
      <div className="boot-screen">
        <Sprout size={42} />
        <LoaderCircle className="spin" />
        <p>正在打开你的画布…</p>
      </div>
    );
  const v = board.viewport;
  const highlighted = new Set();
  let current = board.nodes.find((n) => n.id === (hovered || activeId));
  while (current) {
    highlighted.add(current.id);
    current = board.nodes.find((n) => n.id === current.parentId);
  }
  const searchNodes = search.trim() ? searchConversations({ boards: [board] }, search).map(({node}) => node) : [];
  const ancestry = [];
  current = active;
  while (current) {
    ancestry.unshift(current);
    current = board.nodes.find((n) => n.id === current.parentId);
  }
  const selectedContext = active?.source?.context || [];
  const activeChildren = active ? board.nodes.filter((node)=>node.parentId===active.id && node.status==='active').map((node)=>({node,origin:resolveSourceAnchor(board,node)})) : [];
  const messageBranches = (messageId) => activeChildren.filter(({origin})=>origin?.resolved && origin.messageId===messageId);
  const mergeRecord = (messageId) => active?.merges?.find((record)=>record.messageIds.includes(messageId));
  const originLabel = (source) => source?.anchor?.kind==='table' ? '表格' : source?.anchor?.kind==='image' ? '图片' : source?.quote ? '选中文字' : '消息之后';
  const allGlobalResults = globalSearch ? searchConversations(workspace, globalQuery, {includeTrashed:searchTrash}) : [];
  const globalResults = globalQuery.trim() ? allGlobalResults : [...allGlobalResults].sort((a,b)=>{
    const visitA=lastVisits[a.board.id]?.nodeId===a.node.id?lastVisits[a.board.id].at:a.node.updatedAt||a.board.updatedAt;
    const visitB=lastVisits[b.board.id]?.nodeId===b.node.id?lastVisits[b.board.id].at:b.node.updatedAt||b.board.updatedAt;
    return String(visitB||'').localeCompare(String(visitA||''));
  }).slice(0,12);
  const openSearchResult = (result) => {if(!result)return;revealNode(result.node,result.board.id);setGlobalSearch(false);setGlobalQuery('');};
  const readOnly = board.status !== 'active' || active?.status !== 'active';
  const activeSummaryState = active ? summaryJobs.states[`${board.id}:${active.id}`] : null;
  const menuReadOnly = menu?.type==='board' ? workspace.boards.find((b)=>b.id===menu.id)?.status!=='active' : board.status!=='active'||board.nodes.find((n)=>n.id===menu?.id)?.status!=='active';
  const progress=getResearchProgress(board,lastVisits?.[board.id]);
  const summaryIsStale=(node)=>Boolean(node.summary&&(!node.summary.evidenceFingerprint||(summaryFreshness.boardId===board.id&&summaryFreshness.values[node.id]?.baseline===node.summary.evidenceFingerprint&&summaryFreshness.values[node.id].stale)));
  const activeStale=active?.summary ? busyNode===active.id || isSummaryStale(board,active.id) : false;
  const focusPathIds=new Set(ancestry.map((node)=>node.id));
  if(active?.conclusion)for(const id of active.conclusion.sourceNodeIds)focusPathIds.add(id);
  const changePanelWidth = (width, persistWidth = false) => {
    const bounded = Math.round(Math.max(360, Math.min(1600, width)));
    setPanelWidth(bounded); setPanelExpanded(false);
    if (persistWidth) void savePreferences({panelWidth:bounded});
  };
  const setView = (mode) => {
    if(mode==='canvas'){rememberReadingPosition();setActiveId(null);setPanelExpanded(false);return;}
    if(!active){
      const remembered=previousReadingNode.current;
      const node=board.nodes.find((n)=>n.id===(remembered?.boardId===board.id?remembered.nodeId:lastVisits[board.id]?.nodeId)&&n.status==='active')||board.nodes.find((n)=>n.status==='active');
      if(!node){newConversation();}else openNode(node);
    }
    setPanelExpanded(mode==='reading');
  };
  return (
    <div
      className={`application-shell ${window.branchDesktop ? "desktop-app" : ""} ${settings?.reduceMotion ? 'reduce-motion' : ''}`}
      style={{'--chat-panel-width':`${panelWidth}px`, '--reading-font-size':`${settings?.fontSize || 16}px`, '--reading-line-height':settings?.lineHeight || 1.65}}
    >
      <DesktopTitlebar title={board.title} />
      <div className={`app ${!sidebar ? "sidebar-hidden" : ""}`}>
        <AnimatedPresence>
          {sidebar && (
            <aside className="sidebar">
              <div className="brand">
                <div className="brand-icon">
                  <GitBranch size={23} />
                </div>
                <span>
                  枝间<small>BRANCH LOCAL</small>
                </span>
                <IconButton title="收起侧栏" onClick={() => setSidebar(false)}>
                  <PanelLeftClose size={17} />
                </IconButton>
              </div>
              <div className="sidebar-primary">
                <button className="sidebar-action primary" onClick={newConversation}><Plus size={18}/>新建会话 {hint('new-conversation')}</button>
                <button className="sidebar-action" onClick={()=>setGlobalSearch(true)}><Search size={17}/>搜索对话 {hint('search')}</button>
              </div>
              <div className="sidebar-label">
                <span>画布 · {workspace.boards.filter((b) => b.status === 'active').length}</span>
                <IconButton title="新建画布" shortcut={shortcuts['new-board']} onClick={newBoard}><Plus size={15}/></IconButton>
              </div>
              <nav className="board-list">
                {workspace.boards.filter((b) => b.status === 'active').map((b) => (
                  <div
                    key={b.id}
                    className={`board-item ${b.id === board.id ? "active" : ""}`}
                    data-board-id={b.id}
                    onContextMenu={(event)=>showMenu(event,'board',b.id)}
                  >
                    <button onClick={() => switchBoard(b.id)}>
                      <Waypoints size={17} />
                      <span>{b.title}</span>
                    </button>
                    <IconButton
                      title={`画布菜单：${b.title}`}
                      onClick={(event) => showMenu(event, "board", b.id)}
                    >
                      <MoreHorizontal size={16} />
                    </IconButton>
                  </div>
                ))}
              </nav>
              <TreeNavigator
                board={board}
                activeId={activeId}
                collapsed={collapsed}
                onToggle={toggleCollapsed}
                onSelect={revealNode}
                onContextMenu={(event,node)=>showMenu(event,'node',node.id)}
                shortcutLabel={formatShortcut(shortcuts['toggle-children'])}
              />
              <div className="sidebar-bottom">
                <div className="management-shortcuts">
                  <button title={formatShortcut(shortcuts['show-archive'])} onClick={() => setManagement('archived')}><Archive size={15}/>归档</button>
                  <button title={formatShortcut(shortcuts['show-trash'])} onClick={() => setManagement('trashed')}><Trash2 size={15}/>回收站</button>
                </div>
                <div className="sidebar-tools">
                  <button title={formatShortcut(shortcuts.export)} onClick={exportWorkspace}>
                    <Download size={16} /> 导出
                  </button>
                  <button title={formatShortcut(shortcuts.import)} onClick={() => importWorkspace()}>
                    <Upload size={16} /> 导入
                  </button>
                </div>
                <button
                  className="settings-entry"
                  onClick={() => setShowSettings(true)}
                >
                  <Settings2 size={17} />
                  <span>设置</span>
                  {hint('settings')}
                </button>
                <div className="sidebar-footnote">
                  本地工作区
                  <span>v{window.branchDesktop?.version || "1.5.1"}</span>
                </div>
              </div>
            </aside>
          )}
        </AnimatedPresence>
        <main className="main">
          <header className="topbar">
            <div className="breadcrumb">
              {!sidebar && (
                <IconButton title="展开侧栏" onClick={() => setSidebar(true)}>
                  <PanelLeftOpen size={18} />
                </IconButton>
              )}
              <span className="desktop-only">我的空间</span>
              <ChevronRight size={13} className="desktop-only" />
              <button
                className="board-title"
                onClick={() => rename("board", board.id, board.title)}
              >
                {board.title}
                <Pencil size={13} />
              </button>
            </div>
            <div className="view-switcher" role="group" aria-label="工作区视图">
              <button aria-pressed={!active} onClick={()=>setView('canvas')}>画布</button>
              <button aria-pressed={!!active&&!panelExpanded} onClick={()=>setView('split')}>分屏</button>
              <button aria-pressed={!!active&&panelExpanded} onClick={()=>setView('reading')}>阅读</button>
            </div>
            <div className="topbar-right">
              <IconButton
                title="搜索所有画布"
                shortcut={shortcuts.search}
                onClick={() => setGlobalSearch(true)}
              >
                <Search size={18} />
              </IconButton>
              <button
                className={`save-indicator ${saveState === "error" ? "failed" : ""}`}
                title={
                  saveError ||
                  (window.branchDesktop
                    ? "保存在应用数据目录"
                    : "保存在项目 data/workspace.json")
                }
                onClick={() => {
                  if (saveState === "error") persist();
                }}
              >
                {saveState === "saving" || saveState === "pending" ? (
                  <LoaderCircle size={13} className="spin" />
                ) : saveState === "error" ? (
                  <RotateCcw size={13} />
                ) : (
                  <Check size={13} />
                )}
                <span>
                  {saveState === "saved"
                    ? "已保存到本地"
                    : saveState === "error"
                      ? "保存失败 · 重试"
                      : "保存中"}
                </span>
              </button>
              <span className="top-divider" />
              <IconButton title="使用指南" shortcut={shortcuts.help} onClick={() => setHelp(true)}>
                <CircleHelp size={18} />
              </IconButton>
              <button
                className="model-chip"
                onClick={() => setShowSettings(true)}
              >
                <span className="status-dot" />
                {settings?.model || "连接模型"}
                <ChevronDown size={13} />
              </button>
            </div>
          </header>
          {saveError && (
            <div className="save-error" role="alert">
              {saveError}
              <button onClick={exportWorkspace}>导出备份</button>
              {conflict && (
                <button onClick={resolveConflict}>
                  保留双方内容，恢复保存
                </button>
              )}
            </div>
          )}
          <div className={`canvas-wrap ${active&&panelExpanded?'reading-mode':''} ${active?'with-conversation':''}`}>
            {activeAgent&&(!active||activeAgent.nodeId!==active.id)&&<div className="agent-background-status" role="status"><LoaderCircle size={14} className="spin"/><span>{activeAgent.status==='awaiting-approval'?'Agent 等待确认操作':'Agent 正在后台执行'}</span><button onClick={()=>{const target=workspace.boards.find((b)=>b.id===activeAgent.boardId)?.nodes.find((n)=>n.id===activeAgent.nodeId);if(target)revealNode(target,activeAgent.boardId);}}>查看运行<ArrowUpRight size={13}/></button><IconButton title="停止 Agent" onClick={()=>abort.current?.abort()}><Square size={12}/></IconButton></div>}
            <div className="canvas-toolbar floating-control">
              <div className="view-label">
                <Waypoints size={17} />
                <span>分支画布</span>
                <span
                  className="count-badge"
                  title={`${visibleNodes.length} 个可见，共 ${board.nodes.length} 个对话`}
                >
                  {visibleNodes.length === board.nodes.length
                    ? board.nodes.length
                    : `${visibleNodes.length}/${board.nodes.length}`}
                </span>
              </div>
              <span className="toolbar-divider" />
              <button className="research-tool" aria-label="比较分支" disabled={board.status!=='active'||!!busyNode} onClick={openComparison}><GitCompareArrows size={16}/><span>比较分支</span></button>
              <button className="research-tool" aria-label="研究进展" onClick={()=>setResumeOpen(true)}><BookOpen size={16}/><span>进展</span></button>
              <IconButton title="聚焦当前路径" aria-pressed={pathFocus} disabled={!active} onClick={()=>setPathFocus(!pathFocus)}><ListFilter size={16}/></IconButton>
              <IconButton
                title="添加独立对话"
                shortcut={shortcuts['new-conversation']}
                onClick={newConversation}
              >
                <Plus size={18} />
              </IconButton>
              <IconButton
                title="自动排列节点"
                shortcut={shortcuts.arrange}
                onClick={() => {
                  updateBoard(arrangeBoard);
                  fit(
                    getVisibleNodes(
                      wsRef.current.boards.find((b) => b.id === board.id),
                      collapsed,
                    ),
                  );
                }}
              >
                <LayoutGrid size={17} />
              </IconButton>
              <IconButton
                title="适应画布"
                shortcut={shortcuts.fit}
                onClick={() => fit(visibleNodes)}
              >
                <Maximize size={17} />
              </IconButton>
              {active && (
                <IconButton
                  title="居中当前对话"
                  shortcut={shortcuts['focus-node']}
                  onClick={() => fit([active], true)}
                >
                  <Focus size={17} />
                </IconButton>
              )}
            </div>
            <button className="research-brief" aria-label="继续上次研究" onClick={()=>setResumeOpen(true)}><BookOpen size={14}/><span className="resume-label">{progress.latest?`上次：${progress.latest.summary?.title||progress.latest.title}`:'从一个复杂问题开始'}</span><small>{progress.confirmed.length} 项已确认 · {progress.open.length+progress.waiting.length} 项待处理</small><ChevronRight size={13}/></button>
            <div className="canvas-search floating-control">
              <Search size={15} />
              <input
                aria-label="搜索当前画布"
                placeholder="搜索当前画布…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <IconButton title="清空搜索" onClick={() => setSearch("")}>
                  <X size={13} />
                </IconButton>
              )}
              {search && (
                <div className="search-results">
                  {searchNodes.length ? (
                    searchNodes.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => {
                          revealNode(n);
                          setSearch("");
                        }}
                      >
                        <MessageSquare size={14} />
                        {n.title}
                      </button>
                    ))
                  ) : (
                    <p>没有找到相关对话</p>
                  )}
                </div>
              )}
            </div>
            <div
              className={`canvas ${drag.current?.mode === "pan" ? "panning" : ""} ${dragging ? "dragging" : ""} ${v.zoom<0.6?'compact-view':''}`}
              ref={stageRef}
              onPointerDown={panStart}
              onPointerMove={pointerMove}
              onPointerUp={pointerEnd}
              onPointerCancel={pointerEnd}
              onWheel={(e) => {
                if (e.target.closest(".floating-control")) return;
                const rect = stageRef.current.getBoundingClientRect();
                zoomAt(
                  Math.exp(-e.deltaY * 0.0015),
                  e.clientX - rect.left,
                  e.clientY - rect.top,
                );
              }}
              style={{
                backgroundPosition: `${v.x}px ${v.y}px`,
                backgroundSize: `${24 * v.zoom}px ${24 * v.zoom}px`,
              }}
            >
              <div
                className="world"
                style={{
                  transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`,
                }}
              >
                <svg className="edges" aria-hidden="true">
                  {visibleNodes
                    .filter((n) => n.parentId)
                    .map((n) => {
                      const p = board.nodes.find((p) => p.id === n.parentId);
                      if (!p) return null;
                      const x1 = p.x + getNodeSize(p).width,
                        y1 = p.y + getNodeSize(p).height / 2,
                        x2 = n.x,
                        y2 = n.y + getNodeSize(n).height / 2;
                      return (
                        <g
                          key={n.id}
                          className={
                            highlighted.has(n.id) || n.id === activeId
                              ? "edge selected"
                              : "edge"
                          }
                        >
                          <path
                            d={`M${x1} ${y1} C${x1 + 85} ${y1},${x2 - 85} ${y2},${x2} ${y2}`}
                          />
                          <circle cx={x1} cy={y1} r="3.5" />
                          <circle cx={x2} cy={y2} r="3.5" />
                        </g>
                      );
                    })}
                  {visibleNodes.flatMap((n) => [...new Set([...(n.mergeParents || []),...(n.merges || []).map((record)=>record.nodeId),...(n.conclusion?.sourceNodeIds||[])])].filter((id)=>id!==n.parentId && id!==n.id).map((parentId) => {
                    const p = visibleNodes.find((item) => item.id === parentId);
                    return p ? <g key={`${n.id}:${parentId}`} className={`edge merge-edge ${n.mergeParents?.includes(parentId)?'':'append-edge'}`}><title>{n.conclusion?.sourceNodeIds.includes(parentId)?'结论依据来源':n.mergeParents?.includes(parentId)?'合并来源':'资料追加来源，不改变分支父子关系'}</title><path d={`M${p.x + getNodeSize(p).width} ${p.y + getNodeSize(p).height / 2} C${p.x + getNodeSize(p).width + 85} ${p.y + getNodeSize(p).height / 2},${n.x - 85} ${n.y + getNodeSize(n).height / 2},${n.x} ${n.y + getNodeSize(n).height / 2}`}/></g> : null;
                  }))}
                </svg>
                {visibleNodes.map((n, index) => {
                  const children = board.nodes.filter(
                    (child) => child.parentId === n.id,
                  );
                  const answer = n.messages
                    .filter((m) => m.role === "assistant")
                    .at(-1);
                  const mergedIds=new Set(n.merges?.flatMap((record)=>record.messageIds)||[]);
                  const question = n.messages.find((m) => m.role === 'user'&&!m.material&&!mergedIds.has(m.id)) || n.source?.context?.findLast((m) => m.role === 'user');
                  const summaryState = summaryJobs.states[`${board.id}:${n.id}`];
                  const size = getNodeSize(n);
                  return (
                    <article
                      key={n.id}
                      data-node-id={n.id}
                      className={`node-card ${n.kind==='conclusion'?'conclusion-card':''} ${pathFocus&&active&&!focusPathIds.has(n.id)?'path-muted':''} ${activeId === n.id ? "selected" : ""} ${highlighted.has(n.id) ? "ancestor" : ""} ${hovered && !highlighted.has(n.id) ? "dimmed" : ""} ${n.parentId ? "branch-card" : "root-card"} ${collapsed.includes(n.id) ? "collapsed-node" : ""}`}
                      style={{
                        left: n.x,
                        top: n.y,
                        width: size.width,
                        height: size.height,
                        '--card-summary-lines': Math.max(2, Math.floor((size.height - 150) / 21)),
                      }}
                      onMouseEnter={() => setHovered(n.id)}
                      onMouseLeave={() => setHovered(null)}
                      onClick={() => openNode(n)}
                      onContextMenu={(event) => showMenu(event, "node", n.id)}
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.target === e.currentTarget && e.key === "Enter")
                          openNode(n);
                      }}
                      aria-label={`打开对话：${n.title}`}
                    >
                      <div
                        className="node-header"
                        onPointerDown={(e) => nodeDrag(e, n)}
                      >
                        <span className="node-number">
                          {String(index + 1).padStart(2, "0")}
                        </span>
                        <span className="node-type">
                          {n.kind==='conclusion'?<><ShieldCheck size={12}/>结论卡</>:n.mergeParents?.length || n.merges?.length ? <><GitMerge size={12}/> {n.mergeParents?.length?'合并对话':'含合并资料'}</> : n.parentId ? (
                            <>
                              <GitBranch size={12} /> 分支对话
                            </>
                          ) : (
                            <>
                              <Sprout size={13} /> 思考起点
                            </>
                          )}
                        </span>
                        {n.researchStatus!=='exploring'&&<span className={`node-research-status status-${n.researchStatus}`}>{RESEARCH_STATUSES.find((status)=>status.value===n.researchStatus)?.label}</span>}
                        <IconButton
                          className="node-menu-button"
                          title={`对话菜单：${n.title}`}
                          onClick={(event) => showMenu(event, "node", n.id)}
                        >
                          <MoreHorizontal size={16} />
                        </IconButton>
                        <button
                          className="node-open"
                          aria-label={`进入：${n.title}`}
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            openNode(n);
                          }}
                        >
                          <ArrowUpRight size={16} />
                        </button>
                      </div>
                      <div className={`node-content ${size.height >= 340 ? 'roomy' : ''}`}>
                      <h3 title={n.summary?.title || n.title}>{n.summary?.title || n.title}</h3>
                      <p className="node-summary">{n.conclusion?.items.map((item)=>item.text).join('；') || n.summary?.text || (n.messages.length || n.source ? '等待模型概括此分支的内容与方向。' : '从一个问题开始，模型将在首轮回答后总结这段探索。')}</p>
                      <div className="node-excerpts">
                        {n.conclusion?<><p><b>据</b>{n.conclusion.sourceNodeIds.length} 段来源 · {n.conclusion.items.length} 项结论</p><p><b>确</b>{n.conclusion.items.filter((item)=>item.verified||item.adopted).length} 项人工确认</p></>:<>{question && <p><b>问</b>{short(strip(question.content),280)}</p>}{answer && <p><b>答</b>{short(strip(answer.content),280)}</p>}</>}
                        {n.summary&&n.kind!=='conclusion'&&summaryIsStale(n)&&<span className="card-stale"><RefreshCw size={10}/>内容或关系已变化 · 总结待更新</span>}
                      </div>
                      </div>
                      {summaryState && <button className={`card-summary-state ${summaryState.status}`} onClick={(e)=>{e.stopPropagation(); if(summaryState.status==='error') summaryJobs.enqueue(board.id,[n.id],{manual:true});}} title={summaryState.error || '使用当前模型生成总结'}>{summaryState.status==='error' ? <><RefreshCw size={10}/>总结失败 · 重试</> : <><LoaderCircle className="spin" size={10}/>{summaryState.status==='pending'?'总结排队中':'正在总结'}</>}</button>}
                      <div className="node-footer">
                        <span>
                          <MessageSquare size={12} />
                          {
                            n.messages.filter((m) => m.role === "user").length
                          }{" "}
                          轮对话
                        </span>
                        <button
                          className="node-collapse"
                          disabled={!children.length}
                          title={
                            children.length
                              ? collapsed.includes(n.id)
                                ? "展开全部子分支"
                                : "折叠子分支"
                              : "暂无子分支"
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            toggleCollapsed(n.id);
                          }}
                        >
                          <GitBranch size={12} />
                          {collapsed.includes(n.id)
                            ? `展开 ${getDescendantIds(board, n.id).length - 1} 个`
                            : `${children.length} 个分支`}
                          {children.length > 0 && (
                            <ChevronDown
                              size={11}
                              className={
                                collapsed.includes(n.id) ? "tree-closed" : ""
                              }
                            />
                          )}
                        </button>
                        {busyNode === n.id && (
                          <LoaderCircle size={13} className="spin" />
                        )}
                        <span className="card-dot" />
                      </div>
                      <button className="card-resizer" aria-label={`调整卡片大小：${n.title}`} title="拖动调整这张卡片的大小；方向键微调，Home 恢复默认" onPointerDown={(e)=>resizeCard(e,n)} onKeyDown={(e)=>resizeCardKey(e,n)} onClick={(e)=>e.stopPropagation()}>
                        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 13 13 3M8 13 13 8M12 13 13 12" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/></svg>
                      </button>
                    </article>
                  );
                })}
              </div>
              {!visibleNodes.length && (
                <div className="empty-canvas">
                  <Sprout size={34} />
                  <h2>留一点空间，给新的想法。</h2>
                  <p>从一个问题出发，再向感兴趣的方向展开。</p>
                  <button
                    className="button primary"
                    onClick={newConversation}
                  >
                    开始一段对话 <Plus size={16} /> {hint('new-conversation')}
                  </button>
                </div>
              )}
            </div>
            {!active && (
              <div className="canvas-guide">
                <span className="guide-symbol">
                  <GitBranch size={19} />
                </span>
                <div>
                  <strong>让好奇心，有迹可循。</strong>
                  <p>打开对话，选中一句回答，让想法继续生长。</p>
                </div>
                <button onClick={() => setHelp(true)} aria-label="查看操作提示">
                  <ChevronRight size={18} />
                </button>
              </div>
            )}
            <div className="canvas-bottom floating-control">
              <span className="canvas-tip">
                拖动空白处平移 <span>·</span> 滚轮缩放 {shortcuts.fit && <><span>·</span> {formatShortcut(shortcuts.fit)} 适应画布</>}
              </span>
              <div className="zoom-control">
                <IconButton
                  title="缩小"
                  onClick={() =>
                    zoomAt(
                      0.8,
                      stageRef.current.clientWidth / 2,
                      stageRef.current.clientHeight / 2,
                    )
                  }
                >
                  <Minus size={15} />
                </IconButton>
                <button title="重置视图" onClick={() => fit(visibleNodes)}>
                  {Math.round(v.zoom * 100)}%
                </button>
                <IconButton
                  title="放大"
                  onClick={() =>
                    zoomAt(
                      1.25,
                      stageRef.current.clientWidth / 2,
                      stageRef.current.clientHeight / 2,
                    )
                  }
                >
                  <Plus size={15} />
                </IconButton>
              </div>
            </div>
            {settings?.showMinimap !== false && !panelExpanded && <MiniMap
              nodes={visibleNodes}
              viewport={v}
              stageRef={stageRef}
              activeId={activeId}
              onSelect={revealNode}
              panelOpen={!!active}
              panelWidth={panelWidth}
              onPan={(position) =>
                updateBoard((item) => Object.assign(item.viewport, position))
              }
            />}
            {undo && (
              <button
                className="undo-button floating-control"
                disabled={!!busyNode}
                onClick={undoDelete}
                title={formatShortcut(shortcuts['undo-remove'])}
              >
                <RotateCcw size={14} /> 撤销移除 {hint('undo-remove')}
              </button>
            )}
            <AnimatedPresence>
              {active && (
                <section ref={panelRef} className={`chat-panel ${panelExpanded ? 'expanded' : ''}`} aria-label="分支对话面板">
                  {!panelExpanded && <div className="panel-resizer" role="separator" aria-label="调整会话宽度" aria-orientation="vertical" aria-valuemin={360} aria-valuemax={1600} aria-valuenow={panelWidth} tabIndex={0}
                    onPointerDown={(e)=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId);panelResize.current={x:e.clientX,width:panelRef.current.getBoundingClientRect().width,value:panelWidth};}}
                    onPointerMove={(e)=>{if(panelResize.current){const width=Math.max(360,Math.min(1600,panelResize.current.width+panelResize.current.x-e.clientX));panelResize.current.value=width;changePanelWidth(width);}}}
                    onPointerUp={()=>{if(panelResize.current){void savePreferences({panelWidth:Math.round(panelResize.current.value)});panelResize.current=null;}}}
                    onPointerCancel={()=>{panelResize.current=null;}}
                    onKeyDown={(e)=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();changePanelWidth(panelWidth+(e.key==='ArrowLeft'?40:-40),true);}}}><GripVertical size={15}/></div>}
                  <div className="chat-heading">
                    <div className="chat-heading-top">
                      <button className="chat-title" title={shortcuts.rename ? `重命名 · ${formatShortcut(shortcuts.rename)}` : '重命名'} disabled={readOnly} onClick={()=>rename('node',active.id,active.title)}><span>{active.title}</span><Pencil size={13}/></button>
                      <div>
                        <IconButton title="切换会话概览" data-conversation-overview-toggle aria-expanded={overviewOpen} onClick={()=>setOverviewOpen(!overviewOpen)}><ListTree size={17}/></IconButton>
                        <IconButton title={panelExpanded ? '恢复面板宽度' : '展开阅读'} onClick={()=>setPanelExpanded(!panelExpanded)}><Maximize size={16}/></IconButton>
                        <IconButton title="会话更多操作" aria-expanded={menu?.type==='node'&&menu.id===active.id} onClick={(event)=>showMenu(event,'node',active.id)}><MoreHorizontal size={18}/></IconButton>
                        <IconButton
                          title="关闭对话面板"
                          onClick={() => {rememberReadingPosition();setActiveId(null);}}
                        >
                          <X size={19} />
                        </IconButton>
                      </div>
                    </div>
                    {sourceReturn&&sourceReturn.nodeId!==active.id&&<button className="source-return" aria-label="返回跳转前的会话" onClick={()=>{const previous=sourceReturn;const target=workspace.boards.find((b)=>b.id===previous.boardId)?.nodes.find((n)=>n.id===previous.nodeId);setSourceReturn(null);if(target)revealNode(target,previous.boardId);}}><ArrowLeft size={13}/>返回 {short(sourceReturn.title,24)}</button>}
                    <div className="chat-path">
                      <span className="path-kind">{active.kind==='conclusion'?'结论卡':active.parentId?'分支':'起点'}</span><ChevronRight size={11}/>
                      {ancestry.map((n, i) => (
                        <React.Fragment key={n.id}>
                          {i > 0 && <ChevronRight size={11} />}
                          <button onClick={() => revealNode(n)} title={n.title}>
                            {short(n.title, 12)}
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                    <div className="chat-research-tools"><ResearchStatus value={active.researchStatus} disabled={readOnly} onChange={(value)=>updateBoard((b)=>{b.nodes.find((node)=>node.id===active.id).researchStatus=value;})}/><button disabled={readOnly||!!busyNode} onClick={openComparison}><GitCompareArrows size={13}/>比较与结论</button></div>
                    {active.kind!=='conclusion'&&<><div className={`chat-summary ${summaryExpanded?'is-expanded':''}`}><Sparkles size={14}/><p>{active.summary?.text || '尚无模型总结'}</p>{active.summary&&<button className="summary-toggle" aria-label={summaryExpanded?'收起总结':'展开总结'} aria-expanded={summaryExpanded} onClick={()=>setSummaryExpanded(!summaryExpanded)}><ChevronDown size={13} className={summaryExpanded?'rotate':''}/></button>}<button disabled={readOnly || ['pending','generating'].includes(activeSummaryState?.status)} title={activeSummaryState?.error || `按当前完整会话和分支关系重新总结 ${formatShortcut(shortcuts.summary)}`} onClick={()=>summaryJobs.enqueue(board.id,[active.id],{manual:true})}>{activeSummaryState?.status==='generating'?'生成中…':activeSummaryState?.status==='pending'?'排队中…':activeSummaryState?.status==='error'?'重试总结':'更新总结'}</button></div>
                    {active.summary&&<div className="summary-freshness"><span>总结更新于 {displayDate(active.summary.updatedAt)}</span>{activeStale&&<><span className="stale">内容或关系已变化，总结可能过时</span><button disabled={readOnly} onClick={()=>summaryJobs.enqueue(board.id,[active.id],{manual:true})}>更新</button></>}</div>}</>}
                    {overviewOpen && <div className="overview-popover"><ConversationOverview board={board} node={active} summaryState={activeSummaryState}
                      usage={active.messages.findLast((message)=>message.role==='assistant')?.usage}
                      onClose={()=>setOverviewOpen(false)} onNavigate={(node)=>{setOverviewOpen(false);revealNode(node);}}
                      onJump={jumpFromOverview} onSummarize={()=>summaryJobs.enqueue(board.id,[active.id],{manual:true})}/></div>}
                  </div>
                  <div className="context-strip">
                    <button onClick={() => setContextOpen(!contextOpen)}>
                      <GitBranch size={14} />
                      {active.kind==='conclusion'?`结论卡 · ${active.conclusion.sourceNodeIds.length} 段讨论依据`:active.source
                        ? `继承 ${selectedContext.length} 条上下文 · 创建时快照`
                        : "独立起点 · 无继承上下文"}
                      <ChevronDown
                        size={14}
                        className={contextOpen ? "rotate" : ""}
                      />
                    </button>
                    {contextOpen && (
                      <div className="context-details">
                        <p>这是本地保存的创建时历史；下一次回答使用{active.contextPolicy?.mode==='selected'?'你指定的消息':active.contextPolicy?.mode==='conclusions'?'你选中的关键结论与本会话消息':'这份快照与本卡片的消息'}。<button onClick={()=>setContextPicker(true)}>选择并预览实际上下文</button></p>
                        {selectedContext.length ? (
                          selectedContext.map((m, i) => (
                            <div key={i}>
                              <b>{m.role}</b>
                              <pre>{m.content}</pre>
                            </div>
                          ))
                        ) : (
                          <p>当前没有继承的消息。</p>
                        )}
                      </div>
                    )}
                  </div>
                  <div key={active.id} className="chat-scroll" onScroll={(event)=>{const el=event.currentTarget;const pinned=el.scrollHeight-el.scrollTop-el.clientHeight<100;pinnedToBottom.current=pinned;scrollPositions.current.set(active.id,{top:el.scrollTop,pinned});setShowLatest(!pinned);}}>
                    {active.kind==='conclusion'&&<ConclusionView node={active} board={board} onChangeItem={changeConclusionItem} onJump={jumpToCitation} onExport={()=>exportMarkdown(active)} readOnly={readOnly}/>}
                    {active.source && (
                      <div className="branch-source">
                        <div>
                          <GitBranch size={13} /> 分支来源 · {originLabel(active.source)}
                        </div>
                        {active.source.quote && <blockquote>{active.source.quote}</blockquote>}
                        <button
                          onClick={() => jumpToBranchOrigin(active)}
                        >
                          <ArrowLeft size={12} /> 定位父对话中的来源
                        </button>
                      </div>
                    )}
                    {!active.messages.length && (
                      <div className="chat-empty">
                        <div>
                          <Sprout size={30} />
                        </div>
                        <h3>
                          {active.source
                            ? "沿着这条思路，再走一步。"
                            : "每次探索，始于一个问题。"}
                        </h3>
                        <p>
                          {active.source
                            ? "引用和此前的对话已带到这里。现在，可以放心向下追问。"
                            : "输入你想讨论的问题。回答中的任何一句话，都能成为新的分支。"}
                        </p>
                        <button
                          className="suggestion"
                          disabled={readOnly}
                          onClick={() =>
                            updateBoard((b) => {
                              b.nodes.find((n) => n.id === active.id).draft =
                                active.source
                                  ? "请进一步解释这段内容，并给一个具体例子。"
                                  : "帮我梳理一个问题的不同思考方向。";
                            })
                          }
                        >
                          {active.source
                            ? "进一步解释，给个例子"
                            : "帮我打开思路"}
                          <ArrowUpRight size={13} />
                        </button>
                      </div>
                    )}
                    {active.messages.filter((m)=>!active.conclusion?.messageIds?.includes(m.id)).map((m) => (
                      <div key={m.id} data-message-id={m.id} className={`message ${m.role}`}>
                        <div className="message-label">
                          {m.role === "assistant" ? (
                            <>
                              <span className="ai-mark">
                                <Sprout size={13} />
                              </span>
                              AI 回答
                            </>
                          ) : m.material ? (
                            <span className="material-message-label"><FilePlus2 size={12}/>{m.material.name}{m.material.page?` · 第 ${m.material.page} 页`:''}</span>
                          ) : mergeRecord(m.id) ? (
                            <><span className="user-mark"><GitMerge size={12}/></span>合并资料 · {mergeRecord(m.id).title}</>
                          ) : (
                            <>
                              <span className="user-mark">你</span>我的问题
                            </>
                          )}
                          <div className="message-tools">
                            {m.role === "assistant" &&
                              m.id === active.messages.at(-1)?.id && (
                                <IconButton
                                  title={m.agentRun?'重新运行 Agent（保留原记录）':'重新生成回答（成功后替换）'}
                                  disabled={!!busyNode || readOnly}
                                  onClick={() => m.agentRun?rerunAgent():send(false, m.id,{mode:'chat'})}
                                >
                                  <RotateCcw size={13} />
                                </IconButton>
                              )}
                            <IconButton
                              title="复制消息"
                              onClick={() =>
                                (window.branchDesktop?.copyText
                                  ? window.branchDesktop.copyText(m.content)
                                  : navigator.clipboard.writeText(m.content)
                                )
                                  .then(() => notify("已复制消息"))
                                  .catch(() =>
                                    notify("复制失败，请手动选择文字"),
                                  )
                              }
                            >
                              <Copy size={13} />
                            </IconButton>
                            <IconButton
                              title="编辑消息"
                              disabled={!!busyNode || readOnly}
                              onClick={() =>
                                setEditMessage({ id: m.id, content: m.content })
                              }
                            >
                              <Pencil size={13} />
                            </IconButton>
                          </div>
                        </div>
                        {editMessage?.id === m.id ? (
                          <div className="message-editor">
                            <textarea
                              aria-label="修改消息内容"
                              maxLength={100000}
                              value={editMessage.content}
                              onChange={(e) =>
                                setEditMessage({
                                  ...editMessage,
                                  content: e.target.value,
                                })
                              }
                            />
                            <div>
                              <button
                                className="button secondary"
                                onClick={() => setEditMessage(null)}
                              >
                                取消
                              </button>
                              <button
                                className="button primary"
                                onClick={() => {
                                  updateBoard((b) => {
                                    b.nodes
                                      .find((n) => n.id === active.id)
                                      .messages.find(
                                        (msg) => msg.id === m.id,
                                      ).content = editMessage.content;
                                  });
                                  setEditMessage(null);
                                  notify("消息已修改，已有分支快照保持原样");
                                }}
                              >
                                保存
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div
                            className="message-body"
                            onMouseUp={(e) => selectQuote(e, m)}
                            data-message-id={m.id}
                          >
                            {m.content ? (
                              <MessageContent text={m.content} codeWrap={settings?.codeWrap} fontSize={settings?.fontSize || 16}
                                onBranchBlock={readOnly ? undefined : ({quote:text,...anchor})=>addBranch(active,m.id,text,anchor,
                                  anchor.kind==='table' ? `请聚焦继承上下文最后一条消息中的第 ${(anchor.blockIndex??0)+1} 个表格。首行摘录：${text.split('\n')[0].slice(0,160)}` : undefined)}
                                branchLinks={messageBranches(m.id).map(({node,origin})=>({id:node.id,title:node.summary?.title || node.title,quote:node.source.quote,anchor:origin.anchor}))}
                                onOpenBranch={(id)=>revealNode(board.nodes.find((node)=>node.id===id))}/>
                            ) : m.agentRun ? <p className="agent-empty-answer">{m.agentRun.status==='running'?'Agent 正在处理请求；工具进度显示在下方。':'本次运行没有生成文字回答，执行记录已保留。'}</p> : (
                              <span className="thinking">
                                <span />
                                <span />
                                <span /> 正在等待模型…
                              </span>
                            )}
                          </div>
                        )}
                        {m.agentRun&&<AgentTrace run={m.agentRun} pending={agentPending?.runId===m.agentRun.id?agentPending:null} busy={approvalBusy} onDecision={decideAgent} onOpenDirectory={m.agentRun.events.some((entry)=>entry.tool==='workspace'&&entry.detail===settings?.agentWorkspace)&&window.branchDesktop?.openAgentDirectory?()=>window.branchDesktop.openAgentDirectory().catch((error)=>notify(error.message)):undefined}/>}
                        {m.content && (
                          <button
                            className="branch-action"
                            disabled={readOnly}
                            onClick={() => addBranch(active, m.id)}
                          >
                            <GitBranch size={13} /> 从这里分支
                            {hint('branch')}
                            <ArrowUpRight size={12} />
                          </button>
                        )}
                        <div className="message-branch-links">{messageBranches(m.id).map(({node:child}) => (
                          <div className="branch-link-row" key={child.id}>
                            <button className="existing-branch" onClick={()=>revealNode(child)}>
                              <GitBranch size={12}/><span><small>{originLabel(child.source)}{child.source.quote ? ` · ${short(child.source.quote,65)}` : ''}</small><strong>{child.summary?.title || child.title}</strong></span><ArrowUpRight size={12}/>
                            </button>
                            <button className="branch-origin-link" title={`定位分支来源：${child.title}`} onClick={()=>jumpToBranchOrigin(child)}><Focus size={13}/><span>定位原文</span></button>
                          </div>
                        ))}</div>
                      </div>
                    ))}
                    {requestError?.nodeId === active.id && (
                      <div className="request-error" role="alert">
                        <strong>未能完成回答</strong>
                        <p>{requestError.text}</p>
                        <div>
                          <button onClick={() => setShowSettings(true)}>
                            检查模型连接
                          </button>
                          <button
                            disabled={!!busyNode}
                            onClick={() => requestError.agent?rerunAgent():send(true,null,{mode:'chat'})}
                          >
                            <RotateCcw size={12} /> {requestError.agent?'检查现状并继续':'重试'}
                          </button>
                        </div>
                      </div>
                    )}
                    <div ref={chatEnd} />
                  </div>
                  {showLatest&&!(agentPending&&activeAgent?.nodeId===active.id)&&<button className="latest-message" aria-label="回到最新消息" onClick={()=>{const scroll=panelRef.current?.querySelector('.chat-scroll');if(scroll){pinnedToBottom.current=true;scroll.scrollTo({top:scroll.scrollHeight,behavior:settings?.reduceMotion?'instant':'smooth'});}}}><ChevronDown size={14}/>回到最新</button>}
                  <div className="chat-composer">
                    {activeAgent&&activeAgent.nodeId!==active.id&&<button className="agent-running-link" onClick={()=>{const b=workspace.boards.find((item)=>item.id===activeAgent.boardId);revealNode(b?.nodes.find((node)=>node.id===activeAgent.nodeId),activeAgent.boardId);}}><LoaderCircle size={13} className="spin"/>{activeAgent.status==='awaiting-approval'?'Agent 等待确认':'Agent 正在执行'} · 返回运行会话<ArrowUpRight size={13}/></button>}
                    {readOnly && <div className="read-only-note"><Archive size={15}/><span>此对话已{board.status==='trashed'||active.status==='trashed'?'移入回收站':'归档'}，恢复后可以继续。</span><button onClick={()=>restoreEntry(board.id,active.id)}>恢复对话</button></div>}
                    <div className="composer-box">
                      <textarea
                        ref={composerRef}
                        maxLength={100000}
                        disabled={readOnly}
                        aria-label="输入消息"
                        placeholder={
                          active.source
                            ? "沿着这条分支，继续问…"
                            : "你想从哪里开始？"
                        }
                        value={active.draft}
                        onChange={(e) =>
                          updateBoard((b) => {
                            b.nodes.find((n) => n.id === active.id).draft =
                              e.target.value;
                          })
                        }
                        onKeyDown={(e) => {
                          if (
                            e.key === "Enter" &&
                            !e.shiftKey &&
                            !e.altKey && !e.metaKey && !e.repeat && e.keyCode !== 229 && !e.getModifierState?.('AltGraph') &&
                            (settings?.sendOnEnter !== false || e.ctrlKey || e.metaKey) &&
                            !e.nativeEvent.isComposing
                          ) {
                            e.preventDefault();
                            send();
                          }
                        }}
                        rows={2}
                      />
                      <div className="composer-tools">
                        {(settings?.agentEnabled||active.executionMode==='agent')&&<select className="composer-execution" aria-label="执行方式" value={active.executionMode||'chat'} disabled={readOnly||!!busyNode} onChange={(event)=>{const mode=event.target.value;updateBoard((b)=>{b.nodes.find((node)=>node.id===active.id).executionMode=mode;});}}><option value="chat">直接聊天</option><option value="agent">Agent</option></select>}
                        <button className={`composer-context-button ${active.contextPolicy?.mode!=='full'?'custom':''}`} onClick={()=>setContextPicker(true)} disabled={readOnly||!!busyNode}><ListFilter size={12}/>{active.contextPolicy?.mode==='selected'?'指定消息':active.contextPolicy?.mode==='conclusions'?'关键结论':'完整上下文'}</button>
                        <button className="composer-material-button" aria-label="添加本地资料" disabled={readOnly||!!busyNode||materialBusy} onClick={importMaterials}>{materialBusy?<LoaderCircle size={12} className="spin"/>:<FilePlus2 size={12}/>}添加资料</button>
                        <button
                          className="composer-model"
                          onClick={() => setShowSettings(true)}
                        >
                          <span className="status-dot" />
                          {short(settings?.model || "设置模型", 24)}
                          <ChevronDown size={11} />
                        </button>
                        {busyNode ? (
                          <IconButton
                            className="send-button stop"
                            title="停止生成"
                            onClick={() => abort.current?.abort()}
                          >
                            <Square size={14} fill="currentColor" />
                          </IconButton>
                        ) : (
                          <IconButton
                            className="send-button"
                            title={settings?.sendOnEnter === false ? '发送消息 (Ctrl+Enter)' : '发送消息 (Enter)'}
                            disabled={readOnly || !active.draft.trim()}
                            onClick={() => send()}
                          >
                            <ArrowUp size={18} />
                          </IconButton>
                        )}
                      </div>
                    </div>
                    {active.executionMode==='agent'&&<div className="agent-composer-note"><span>{agentPending&&activeAgent?.nodeId===active.id?'Agent 等待确认此次操作':settings?.agentEnabled?'按次确认修改与命令 · 分支共享工作目录':'需要在设置中启用 Agent 并选择工作目录'}</span>{agentPending&&activeAgent?.nodeId===active.id?<button onClick={focusAgentApproval}>查看操作</button>:<button onClick={()=>{setSettingsSection('agent');setShowSettings(true);}}>设置 Agent</button>}</div>}
                    <p className="composer-hint">
                      {settings?.sendOnEnter === false ? 'Ctrl + Enter 发送 · Enter 换行' : 'Enter 发送 · Shift + Enter 换行'}{" "}
                      <span>·</span> 选中文字创建分支
                    </p>
                    {(active.messages.some((message)=>message.material)||active.source?.context.some((message)=>message.content.includes('【本地资料：')))&&<p className="material-notice">资料保存在本地；主动回答、摘要和比较会发送所需内容。{settings?.autoSummaryMaterials?'你已允许资料参与自动摘要。':'资料默认不参与自动摘要，可在设置中开启。'}</p>}
                  </div>
                </section>
              )}
            </AnimatedPresence>
          </div>
        </main>
        <input
          type="file"
          ref={fileInput}
          accept=".json,application/json"
          hidden
          onChange={importWorkspace}
        />
        {quote && active && (
          <button
            className="quote-popover"
            style={{ left: quote.x, top: quote.y }}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => addBranch(active, quote.messageId, quote.text, quote.anchor)}
          >
            <GitBranch size={14} /> 从选中文字分支
            <ArrowUpRight size={13} />
          </button>
        )}
        {toast && (
          <div className="toast" role="status">
            <Check size={16} />
            {toast}
          </div>
        )}
        {showSettings && settings && (
          <Preferences
            Modal={Modal}
            initial={settings}
            initialSection={settingsSection}
            onSaved={setSettings}
            close={() => {setShowSettings(false);setSettingsSection('model');}}
            changeStorage={changeStorage}
          />
        )}
        {globalSearch && (
          <Modal title="搜索所有画布" close={() => setGlobalSearch(false)} wide>
            <label className="global-search-field">
              <Search size={18} />
              <input
                aria-label="搜索所有画布的标题和消息"
                role="combobox"
                aria-autocomplete="list"
                aria-expanded="true"
                aria-controls="conversation-search-results"
                aria-activedescendant={globalResults.length?`search-result-${Math.min(searchIndex,globalResults.length-1)}`:undefined}
                placeholder="搜索标题、问题或回答…"
                autoFocus
                value={globalQuery}
                onChange={(event) => setGlobalQuery(event.target.value)}
                onKeyDown={(event)=>{
                  if(event.nativeEvent.isComposing||event.isComposing||event.nativeEvent.keyCode===229||event.key==='Process'||event.key==='Dead')return;
                  if(event.key==='ArrowDown'||event.key==='ArrowUp'){
                    event.preventDefault();
                    const next=Math.max(0,Math.min(globalResults.length-1,searchIndex+(event.key==='ArrowDown'?1:-1)));
                    setSearchIndex(next);document.getElementById(`search-result-${next}`)?.scrollIntoView({block:'nearest'});
                  }else if(event.key==='Enter'){event.preventDefault();openSearchResult(globalResults[Math.min(searchIndex,globalResults.length-1)]);}
                }}
              />
              <kbd>Esc</kbd>
            </label>
            <label className="search-options"><input type="checkbox" checked={searchTrash} onChange={(e)=>setSearchTrash(e.target.checked)}/>包含回收站（归档内容始终参与搜索）</label>
            <div className="global-results" role="listbox" id="conversation-search-results" aria-label="匹配的会话">
              {globalResults.map(({ node, board: item, excerpt, archived, trashed },index) => (
                <button
                  key={node.id}
                  id={`search-result-${index}`}
                  role="option"
                  aria-selected={index===Math.min(searchIndex,globalResults.length-1)}
                  onMouseMove={()=>setSearchIndex(index)}
                  onClick={() => openSearchResult({node,board:item})}
                >
                  <MessageSquare size={17} />
                  <span>
                    <strong>{node.summary?.title || node.title}{trashed?' · 回收站':archived?' · 已归档':''}</strong>
                    <small>
                      {item.title} · {node.messages.length} 条消息
                      {node.source?.quote
                        ? ` · ${short(node.source.quote, 42)}`
                        : ""}
                    </small>
                    <span className="result-excerpt">{excerpt}</span>
                  </span>
                  <ArrowUpRight size={15} />
                </button>
              ))}
              {!globalResults.length && (
                <p>没有找到相关对话。试试其他关键词。</p>
              )}
            </div>
            <p className="search-footnote">
              {globalQuery.trim()
                ? `找到 ${globalResults.length} 条匹配`
                : "最近的会话 · 输入关键词搜索全部内容"}
              <span>↑ ↓ 选择 · Enter 打开</span>
            </p>
            {!globalQuery.trim()&&<div className="search-quick-actions"><button onClick={()=>{setGlobalSearch(false);newConversation();}}><Plus size={14}/>新建会话</button><button onClick={()=>{setGlobalSearch(false);setShowSettings(true);}}><Settings2 size={14}/>设置</button></div>}
          </Modal>
        )}
        <AnimatedPresence>
          {menu && (
            <div
              className="context-menu"
              role="menu"
              aria-label={menu.type==='board'?'画布操作':'会话操作'}
              onKeyDown={(event)=>{
                const items=[...event.currentTarget.querySelectorAll('button:not(:disabled)')];
                const currentIndex=items.indexOf(document.activeElement);
                let next;
                if(event.key==='ArrowDown')next=items[(currentIndex+1)%items.length];
                else if(event.key==='ArrowUp')next=items[(currentIndex-1+items.length)%items.length];
                else if(event.key==='Home')next=items[0];
                else if(event.key==='End')next=items.at(-1);
                else if(event.key==='Escape'){event.preventDefault();event.stopPropagation();setMenu(null);menuTrigger.current?.focus();return;}
                else if(event.key==='Tab'){setMenu(null);return;}
                if(next){event.preventDefault();event.stopPropagation();next.focus();}
              }}
              style={{ left: Math.max(8, menu.x), top: Math.max(40, menu.y) }}
            >
              {menu.type === 'board' ? <>
                <button role="menuitem" data-action="rename" onClick={()=>actionRunner.current('rename')}><Pencil size={15}/>重命名画布 {hint('rename')}</button>
                <button role="menuitem" data-action="duplicate" onClick={()=>actionRunner.current('duplicate')}><Copy size={15}/>复制整张画布 {hint('duplicate')}</button>
                <button role="menuitem" data-action="archive" onClick={()=>actionRunner.current('archive')}><Archive size={15}/>归档画布 {hint('archive')}</button>
                <span className="menu-separator"/>
                <button role="menuitem" data-action="trash" className="danger" onClick={()=>actionRunner.current('trash')}><Trash2 size={15}/>画布移入回收站 {hint('trash')}</button>
              </> : <>
                <button role="menuitem" data-action="rename" disabled={menuReadOnly} onClick={()=>actionRunner.current('rename')}><Pencil size={15}/>重命名对话 {hint('rename')}</button>
                <button role="menuitem" data-action="branch" disabled={menuReadOnly} onClick={()=>actionRunner.current('branch')}><GitBranch size={15}/>从这里建立分支 {hint('branch')}</button>
                <button role="menuitem" data-action="duplicate" disabled={menuReadOnly} onClick={()=>actionRunner.current('duplicate')}><Copy size={15}/>复制对话与子树 {hint('duplicate')}</button>
                <button role="menuitem" data-action="merge" disabled={menuReadOnly||Boolean(busyNode)} onClick={()=>actionRunner.current('merge')}><GitMerge size={15}/>合并分支… {hint('merge')}</button>
                <button role="menuitem" data-action="summary" disabled={menuReadOnly} onClick={()=>actionRunner.current('summary')}><Sparkles size={15}/>重新生成总结 {hint('summary')}</button>
                <button role="menuitem" data-action="toggle-children" disabled={!board.nodes.some((n)=>n.status==='active' && n.parentId===menu.id)} onClick={()=>actionRunner.current('toggle-children')}><ChevronDown size={15}/>{collapsed.includes(menu.id)?'展开子分支':'折叠子分支'} {hint('toggle-children')}</button>
                <button role="menuitem" data-action="export-conversation" onClick={()=>actionRunner.current('export-conversation')}><Download size={15}/>导出当前会话 {hint('export-conversation')}</button>
                <button role="menuitem" data-action="focus-node" onClick={()=>actionRunner.current('focus-node')}><Focus size={15}/>在画布中居中 {hint('focus-node')}</button>
                <span className="menu-separator"/>
                <button role="menuitem" data-action="archive" disabled={menuReadOnly||Boolean(busyNode)} onClick={()=>actionRunner.current('archive')}><Archive size={15}/>归档此分支 {hint('archive')}</button>
                <button role="menuitem" data-action="trash" className="danger" disabled={menuReadOnly||busyNode===menu.id} onClick={()=>actionRunner.current('trash')}><Trash2 size={15}/>分支移入回收站 {hint('trash')}</button>
              </>}
            </div>
          )}
        </AnimatedPresence>
        {compareOpen&&compareSession&&compareSession.boardId===board.id&&<Modal title="比较分支与整理结论" close={()=>setCompareOpen(false)} wide><ComparisonWorkbench board={board} workspace={workspace} session={compareSession} onChange={setCompareSession} onSave={saveComparison} onJump={jumpToCitation} onCancel={()=>setCompareOpen(false)} onRequest={(controller)=>{comparisonAbort.current=controller;}}/></Modal>}
        {contextPicker&&active&&<Modal title="下一次回答的上下文" close={()=>setContextPicker(false)} wide><ContextPicker board={board} node={active} systemPrompt={settings?.systemPrompt} onCancel={()=>setContextPicker(false)} onSave={(policy)=>{updateBoard((b)=>{b.nodes.find((node)=>node.id===active.id).contextPolicy=policy;});setContextPicker(false);notify('已更新下一次回答的上下文；本地历史保持完整。');}}/></Modal>}
        {resumeOpen&&<Modal title="继续这次研究" close={()=>setResumeOpen(false)} wide><ResearchResume board={board} lastVisit={lastVisits?.[board.id]} onNavigate={(node)=>{setResumeOpen(false);revealNode(node);}} onCompare={openComparison} onDemo={startOfflineDemo}/></Modal>}
        {mergeTarget && <Modal title="合并分支" close={()=>setMergeTarget(null)} wide>
          <div className="merge-mode" role="group" aria-label="合并方式">
            <label><input type="radio" name="mergeMode" value="new" checked={mergeMode==='new'} onChange={()=>setMergeMode('new')}/><span><strong>开新会话</strong><small>以所选主干为前缀，保留原会话</small></span></label>
            <label><input type="radio" name="mergeMode" value="append" checked={mergeMode==='append'} onChange={()=>setMergeMode('append')}/><span><strong>追加到现有主干</strong><small>保留主干消息，在末尾加入差异资料</small></span></label>
          </div>
          <p className="dialog-description">选择至少两段对话，并指定主干。共同的连续历史只保留一次；其余分支差异作为资料追加。重复追加跳过已合入的内容；想先梳理共同点、分歧和依据，可使用“比较分支”。</p><button className="button secondary" onClick={()=>{setMergeTarget(null);openComparison();}}><GitCompareArrows size={14}/>先比较，再整理结论</button>
          <label className="merge-main-select">{mergeMode==='append'?'接收内容的主干':'新会话沿用的主干前缀'}<select name="mergeMainId" aria-label="主干会话" value={mergeSelection.includes(mergeMainId)?mergeMainId:mergeSelection[0] || ''} onChange={(e)=>setMergeMainId(e.target.value)} disabled={!mergeSelection.length}>
            {!mergeSelection.length && <option value="">请先选择会话</option>}
            {workspace.boards.find((b)=>b.id===mergeTarget.boardId)?.nodes.filter((n)=>mergeSelection.includes(n.id)).map((n)=><option key={n.id} value={n.id}>{n.summary?.title || n.title}</option>)}
          </select></label>
          <div className="merge-choices">{workspace.boards.find((b)=>b.id===mergeTarget.boardId)?.nodes.filter((n)=>n.status==='active').map((n)=><label key={n.id}><input type="checkbox" aria-label={`选择会话：${n.title}`} checked={mergeSelection.includes(n.id)} disabled={busyNode===n.id} onChange={(e)=>setMergeSelection((ids)=>e.target.checked?[...ids,n.id]:ids.filter((id)=>id!==n.id))}/><span><strong>{n.summary?.title || n.title}</strong><small>{n.summary?.text || `${n.messages.length} 条消息 · ${n.parentId?'分支':'起点'}`}</small></span></label>)}</div>
          <div className="dialog-actions"><button className="button secondary" onClick={()=>setMergeTarget(null)}>取消</button><button className="button primary" disabled={mergeSelection.length<2 || !!busyNode} onClick={commitMerge}><GitMerge size={15}/>{mergeMode==='append'?'追加到主干':'新建合并会话'}</button></div>
        </Modal>}
        {sourceSnapshot && <Modal title="分支创建时的来源快照" close={()=>setSourceSnapshot(null)} wide>
          <p className="dialog-description">{sourceSnapshot.reason==='citation'?'此处显示结论保留的引文；若原消息已删除或改写，不会猜测位置。可用的继承原文如下。':sourceSnapshot.reason==='edited'?'来源消息后来被编辑，下面保留创建分支时的原文。':sourceSnapshot.reason==='inherited'?'锚点位于父分支继承的历史中，下面展示创建时保存的上下文。':'当前消息中无法验证原始位置，下面展示分支创建时的上下文。'}来源：「{sourceSnapshot.title}」。</p>
          {sourceSnapshot.quote && <blockquote className="snapshot-quote">{sourceSnapshot.quote}</blockquote>}
          <div className="source-snapshot">
            {sourceSnapshot.context.length > sourceSnapshot.shown && <button className="button secondary" onClick={()=>setSourceSnapshot((value)=>({...value,shown:value.shown+20}))}>再显示此前 20 条消息</button>}
            {sourceSnapshot.context.slice(-sourceSnapshot.shown).map((message,index)=>{
              const absoluteIndex = Math.max(0,sourceSnapshot.context.length-sourceSnapshot.shown)+index;
              return <article className={`snapshot-message ${absoluteIndex===(sourceSnapshot.index ?? sourceSnapshot.context.length-1)?'snapshot-origin':''}`} key={absoluteIndex}><b>{message.role==='assistant'?'AI 回答':message.role==='user'?'用户消息':'系统消息'} · {absoluteIndex+1}</b><MessageContent text={message.content} codeWrap={settings?.codeWrap} fontSize={settings?.fontSize || 16}/></article>;
            })}
            {!sourceSnapshot.context.length && <p className="muted">{sourceSnapshot.reason==='citation'?'未保留整条来源消息；上方为当时核对过的原文引句。':'该分支创建时尚无历史消息。'}</p>}
          </div>
        </Modal>}
        {management && <Modal title={management==='archived'?'归档':'回收站'} close={()=>setManagement(null)} wide>
          <p className="dialog-description">{management==='archived'?'归档内容保留在本地，也可以通过全文搜索找到。恢复后可继续对话。':'删除的内容先保存在回收站。永久删除后无法在应用中恢复。'}</p>
          <label className="global-search-field"><Search size={17}/><input aria-label="筛选管理列表" placeholder="按画布或会话标题筛选…" value={managementQuery} onChange={(event)=>setManagementQuery(event.target.value)}/>{managementQuery&&<IconButton title="清空筛选" onClick={()=>setManagementQuery('')}><X size={14}/></IconButton>}</label>
          <div className="management-list">{workspace.boards.flatMap((b)=>{
            const entries=[];
            const matches=(title)=>title.toLocaleLowerCase().includes(managementQuery.trim().toLocaleLowerCase());
            if(b.status===management&&matches(b.title)) entries.push(<div className="management-entry" key={b.id}><LayoutGrid size={18}/><span><strong>{b.title}</strong><small>整张画布 · {b.nodes.length} 段对话</small></span><button onClick={()=>restoreEntry(b.id)}><ArchiveRestore size={14}/>恢复</button>{management==='trashed'&&<button className="danger" onClick={()=>purgeEntry(b.id)}><Trash2 size={14}/>永久删除</button>}</div>);
            if(b.status==='active') for(const n of b.nodes.filter((n)=>n.status===management&&matches(`${b.title} ${n.title} ${n.summary?.title||''}`))) entries.push(<div className="management-entry" key={n.id}><MessageSquare size={18}/><span><strong>{n.summary?.title || n.title}</strong><small>{b.title} · {n.messages.length} 条消息</small></span><button onClick={()=>{revealNode(n,b.id);setManagement(null);}}>查看</button><button onClick={()=>restoreEntry(b.id,n.id)}><ArchiveRestore size={14}/>恢复</button>{management==='trashed'&&<button className="danger" onClick={()=>purgeEntry(b.id,n.id)}><Trash2 size={14}/>永久删除</button>}</div>);
            return entries;
          })}</div>
          {!workspace.boards.some((b)=>b.status===management&&b.title.toLocaleLowerCase().includes(managementQuery.trim().toLocaleLowerCase()) || b.status==='active'&&b.nodes.some((n)=>n.status===management&&`${b.title} ${n.title} ${n.summary?.title||''}`.toLocaleLowerCase().includes(managementQuery.trim().toLocaleLowerCase())))&&<p className="management-empty">{managementQuery?'没有匹配的内容。':'这里暂时没有内容。'}</p>}
        </Modal>}
        {help && (
          <Modal title="让对话向不同方向生长" close={() => setHelp(false)}>
            <div className="help-illustration">
              <div>
                <MessageSquare size={22} />
              </div>
              <span />
              <GitBranch size={24} />
              <span />
              <div>
                <Sprout size={22} />
              </div>
            </div>
            <ol className="help-steps">
              <li>
                <b>从一张卡片开始</b>
                <p>点击卡片打开对话，连接模型后即可发送消息。</p>
              </li>
              <li>
                <b>选一句话，开一条分支</b>
                <p>
                  在消息中选中文字，点击浮出的分支按钮。新对话继承截至这条消息的上下文快照。
                </p>
              </li>
              <li>
                <b>随时回到全貌</b>
                <p>
                  关闭对话或点击画布空白处。拖动卡片标题移动节点，拖动空白平移，滚轮缩放。
                </p>
              </li>
            </ol>
            <ol className="help-steps help-next-step"><li><b>比较思路，留下结论</b><p>在“比较分支”中核对共同点、分歧和证据，保存可追溯的结论卡。“已验证”和“已采用”由你确认。</p></li></ol>
            <details className="shortcut-guide"><summary>快捷键与键盘操作</summary><p>右键菜单指向的对象优先，其次是聚焦的卡片或树节点，再其次是当前会话。输入框内保留文字编辑按键，删除和归档仍需确认。可在“设置 → 快捷键”修改；树目录和菜单支持方向键。</p><dl>{SHORTCUT_ACTIONS.map((action)=><div key={action.id}><dt>{action.label}</dt><dd>{hint(action.id) || '未设置'}</dd></div>)}</dl></details>
            <div className="help-note">
              <HardDrive size={17} />
              <p>
                {window.branchDesktop ? (
                  "数据自动写入本机应用数据目录，可在设置中打开。"
                ) : (
                  <>
                    数据写入项目的 <code>data/</code> 目录。
                  </>
                )}
                使用本机 Ollama 时可完全离线；远程 API
                会收到当前对话上下文。欢迎画布中的回答是静态演示。
              </p>
            </div>
            <button className="button secondary full-width help-demo" onClick={()=>{setHelp(false);startOfflineDemo();}}><GitCompareArrows size={16}/>用离线示例体验分支与结论</button>
            <button
              className="button primary full-width"
              onClick={() => setHelp(false)}
            >
              开始探索
              <ArrowUpRight size={15} />
            </button>
          </Modal>
        )}
        {dialog && <TextDialog key={`${dialog.title}:${dialog.value || ''}`} dialog={dialog} close={() => setDialog(null)} />}
      </div>
    </div>
  );
}
function TextDialog({ dialog, close }) {
  const [value, setValue] = useState(dialog.value || "");
  const submit = (event) => {
    event.preventDefault();
    dialog.confirm(value);
    close();
  };
  return (
    <Modal title={dialog.title} close={close}>
      <form onSubmit={submit}>
        {dialog.description ? (
          <p className="dialog-description">{dialog.description}</p>
        ) : (
          <label className="field">
            名称
            <input
              aria-label="名称"
              autoFocus
              maxLength={160}
              value={value}
              placeholder={dialog.placeholder || ""}
              onChange={(e) => setValue(e.target.value)}
            />
          </label>
        )}
        <div className="modal-actions">
          <button type="button" className="button secondary" onClick={close}>
            取消
          </button>
          <button
            className={`button ${dialog.danger ? "destructive" : "primary"}`}
            type="submit"
          >
            {dialog.button || "确定"}
          </button>
        </div>
      </form>
    </Modal>
  );
}

createRoot(document.getElementById("root")).render(<App />);
