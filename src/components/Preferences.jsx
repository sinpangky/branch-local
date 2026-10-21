import React, { useEffect, useId, useRef, useState } from "react";
import { Check, FolderOpen, HardDrive, LoaderCircle, RefreshCw, Waypoints } from "lucide-react";
import ShortcutSettings from "./ShortcutSettings.jsx";
import { DEFAULT_SHORTCUTS, validateShortcuts } from "../../shared/shortcuts.mjs";
import { AGENT_CAPABILITIES, AGENT_WORKFLOWS, AGENT_EXECUTION_RULES } from "../../shared/agent-guide.mjs";
import "./preferences.css";

const defaults = {
  baseUrl: "http://127.0.0.1:11434/v1", model: "qwen3:8b", systemPrompt: "",
  temperature: 0.7, rememberKey: false, theme: "system", fontSize: 16,
  lineHeight: 1.65, codeWrap: false, reduceMotion: false, panelWidth: 560,
  sendOnEnter: true, showMinimap: true, autoSummary: true, autoSummaryMaterials:false, autoLayout:true, summaryMaxLength: 160,
  maxOutputTokens: 0, requestTimeoutSeconds: 120, shortcuts: DEFAULT_SHORTCUTS,
  agentEnabled: false, agentEngine: "compatible", agentWorkspace: "",
  agentAllowCommands: false, agentAllowNetwork: false, agentSearchEndpoint: "", agentMaxSteps: 12,
};
const tabs = [
  ["model", "模型连接"], ["reading", "阅读"], ["interaction", "交互"],
  ["generation", "生成与总结"], ["agent", "Agent"], ["data", "本地数据"], ["shortcuts", "快捷键"],
];
const numericFields = [
  ["temperature", 0, 2, "model", "Temperature"],
  ["fontSize", 12, 24, "reading", "正文字号"],
  ["lineHeight", 1.4, 2.4, "reading", "正文行高"],
  ["panelWidth", 360, 1600, "interaction", "默认会话面板宽度"],
  ["summaryMaxLength", 80, 400, "generation", "总结目标字数"],
  ["maxOutputTokens", 0, 32768, "generation", "单次回答输出上限"],
  ["requestTimeoutSeconds", 30, 600, "generation", "请求超时"],
  ["agentMaxSteps", 1, 30, "agent", "单次任务最大步骤"],
];

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...options.headers },
  });
  let result;
  try { result = await response.json(); }
  catch { throw new Error(`服务返回了无法读取的结果 (${response.status})。`); }
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
}

function Toggle({ label, hint, checked, onChange, disabled = false }) {
  return <label className="preference-toggle">
    <span><strong>{label}</strong>{hint && <small>{hint}</small>}</span>
    <input type="checkbox" checked={Boolean(checked)} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
  </label>;
}

function NumberField({ field, label, hint, value, change, min, max, step = 1, unit }) {
  return <label className="preference-field">
    <span>{label}{unit && <small>{unit}</small>}</span>
    <input type="number" name={field} min={min} max={max} step={step} value={value}
      onChange={(event) => change(field, event.target.value === "" ? "" : Number(event.target.value))} />
    {hint && <small className="preference-hint">{hint}</small>}
  </label>;
}

function AgentGuide({ form, available }) {
  const availability = (requirement) => {
    if (!available) return { ready: false, label: "需桌面应用" };
    if (!form.agentEnabled) return { ready: false, label: "需启用 Agent" };
    if (!form.agentWorkspace.trim()) return { ready: false, label: "需选择工作目录" };
    if (requirement === "commands" && !form.agentAllowCommands) return { ready: false, label: "需开启命令权限" };
    if (["network", "search"].includes(requirement) && !form.agentAllowNetwork) return { ready: false, label: "需开启网络权限" };
    if (requirement === "search" && !form.agentSearchEndpoint.trim()) return { ready: false, label: "需配置搜索服务" };
    return { ready: true, label: "可提供工具" };
  };
  const status = (entry) => {
    const value = availability(entry.requirement);
    return <span className="preference-agent-status" data-state={value.ready ? "ready" : "blocked"}>{value.label}</span>;
  };
  return <details className="preference-agent-guide" aria-label="Agent 能力指南">
    <summary><span>Agent 能做什么<small>任务示例、工具与所需权限</small></span></summary>
    <div className="preference-agent-guide-body">
      <p className="preference-hint">状态按当前设置预览，保存后生效；仅表示可向模型提供相应工具，不代表模型能力、本地程序或连接已经验证。</p>
      <ul className="preference-agent-workflows">
        {AGENT_WORKFLOWS.map((entry) => <li key={entry.id} data-agent-workflow={entry.id} data-requirement={entry.requirement}>
          <div className="preference-agent-guide-heading"><h4>{entry.title}</h4>{status(entry)}</div>
          <p>{entry.description}</p>
          <code className="preference-agent-tool-path">{entry.tools.join(" → ")}</code>
          <blockquote>{entry.example}</blockquote>
        </li>)}
      </ul>
      <details className="preference-agent-tool-guide">
        <summary>查看每个工具的用途</summary>
        <dl>{AGENT_CAPABILITIES.map((entry) => <div key={entry.id} data-agent-capability={entry.id} data-requirement={entry.requirement}>
          <dt><strong>{entry.title}</strong>{status(entry)}</dt>
          <dd>{entry.description}<code>{entry.tools.join(" · ")}</code></dd>
        </div>)}</dl>
      </details>
      <p className="preference-hint">PDF、Office、图像转换和数据分析通常需要命令权限及本机对应程序或依赖；Agent 应先检查，缺少时明确说明。网页工具读取静态文本，不能登录、点击网页或执行页面脚本。</p>
      <details className="preference-agent-rules">
        <summary>查看内置执行规则</summary>
        <p className="preference-hint">Agent 在每次任务中收到以下内置规则，以及当前目录、工具权限和你填写的系统提示词。</p>
        <pre aria-label="内置 Agent 执行规则">{AGENT_EXECUTION_RULES}</pre>
      </details>
    </div>
  </details>;
}

export default function Preferences({ Modal, initial, onSaved, close, changeStorage, initialSection = "model" }) {
  const [form, setForm] = useState(() => ({ ...defaults, ...initial, apiKey: "", clearApiKey: false }));
  const [tab, setTab] = useState(() => tabs.some(([key]) => key === initialSection) ? initialSection : "model");
  const [busy, setBusy] = useState(false);
  const [storageBusy, setStorageBusy] = useState(false);
  const [feedback, setFeedback] = useState(null);
  const [models, setModels] = useState([]);
  const [discovery, setDiscovery] = useState({ status: "idle" });
  const [directory, setDirectory] = useState(null);
  const [storageMode, setStorageMode] = useState("copy");
  const dirty = useRef(false);
  const tabButtons = useRef([]);
  const id = useId();
  const desktop = typeof window !== "undefined" ? window.branchDesktop : null;
  const agentAvailable = typeof form.agentAvailable === "boolean" ? form.agentAvailable : Boolean(desktop?.chooseAgentDirectory);
  const locked = busy || storageBusy;

  useEffect(() => {
    const controller = new AbortController();
    api("/api/settings", { signal: controller.signal }).then((saved) => {
      if (!dirty.current) setForm({ ...defaults, ...saved, apiKey: "", clearApiKey: false });
    }).catch((error) => {
      if (error.name !== "AbortError")
        setFeedback({ error: true, text: `无法刷新设置：${error.message}；仍可编辑已读取的设置。` });
    });
    return () => controller.abort();
  }, []);

  const change = (key, value) => {
    dirty.current = true;
    if (key === "baseUrl") { setModels([]); setDiscovery({ status: "idle" }); setFeedback(null); }
    setForm((current) => ({ ...current, [key]: value }));
  };
  const changeProvider = (local) => {
    dirty.current = true;
    setModels([]);
    setDiscovery({ status: "idle" });
    setForm((current) => ({ ...current,
      baseUrl: local ? defaults.baseUrl : "", model: local ? defaults.model : "",
      apiKey: "", clearApiKey: true,
    }));
    setFeedback({ text: "已切换连接预设；保存时将清除旧连接的密钥。" });
  };

  const validate = (discover) => {
    try {
      const url = new URL(form.baseUrl);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch {
      setTab("model");
      throw new Error("请填写有效的 http(s) API Base URL，不要包含账号、查询参数或片段。");
    }
    if (!discover && !form.model.trim()) { setTab("model"); throw new Error("请填写模型名称。"); }
    for (const [field, min, max, section, label] of numericFields) {
      if (typeof form[field] !== "number" || !Number.isFinite(form[field]) || form[field] < min || form[field] > max ||
        (!["temperature", "lineHeight"].includes(field) && !Number.isInteger(form[field]))) {
        setTab(section);
        throw new Error(`${label}需要填写 ${min}–${max} 之间的${["temperature", "lineHeight"].includes(field) ? "数值" : "整数"}。`);
      }
    }
    if (form.agentEnabled && !form.agentWorkspace.trim()) {
      setTab("agent");
      throw new Error("请先为 Agent 选择工作目录。");
    }
    if (form.agentSearchEndpoint.trim()) {
      try {
        const url = new URL(form.agentSearchEndpoint.trim());
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
      } catch {
        setTab("agent");
        throw new Error("请填写有效的 HTTPS SearXNG 服务地址，不要包含账号、查询参数或片段。");
      }
    }
    try { validateShortcuts(form.shortcuts); }
    catch (error) { setTab("shortcuts"); throw error; }
  };

  const save = async (discover = false) => {
    dirty.current = true;
    setFeedback(null);
    try { validate(discover); }
    catch (error) { setFeedback({ error: true, text: error.message }); return; }
    setBusy(true);
    if (discover) { setModels([]); setDiscovery({ status: "loading" }); }
    let savedConnection = false;
    try {
      const payload = Object.fromEntries(Object.keys(defaults).map((key) => [key, form[key]]));
      payload.apiKey = form.apiKey;
      payload.clearApiKey = form.clearApiKey;
      payload.shortcuts = validateShortcuts(form.shortcuts);
      // Model discovery itself does not need a selected model. Retain the
      // service's existing model until the user chooses from the returned list.
      if (discover && !form.model.trim()) delete payload.model;
      const saved = await api("/api/settings", { method: "PUT", body: JSON.stringify(payload) });
      savedConnection = true;
      await onSaved(saved);
      setForm({ ...defaults, ...saved, model: discover ? form.model : saved.model, apiKey: "", clearApiKey: false });
      if (discover) {
        const result = await api("/api/models", { method: "POST", body: "{}" });
        if (!Array.isArray(result.models) || result.models.some((model) => typeof model !== "string"))
          throw new Error("服务返回的模型列表格式无效。");
        setModels(result.models);
        setDiscovery({ status: "success", count: result.models.length });
        setFeedback({ text: result.models.length ? `设置已保存，已读取 ${result.models.length} 个模型。可选择后再次保存。` : "设置已保存；服务没有返回可选模型，请手动填写模型名称。" });
      } else close();
    } catch (error) {
      if (discover) setDiscovery({ status: "error" });
      setFeedback({ error: true, text: `${discover && savedConnection ? "设置已保存，读取模型失败：" : ""}${error.message}` });
    } finally { setBusy(false); }
  };

  const chooseDirectory = async () => {
    setFeedback(null);
    setStorageBusy(true);
    try {
      const selected = await desktop.chooseDataDirectory();
      if (selected) {
        if (typeof selected.directory !== "string" || typeof selected.hasWorkspace !== "boolean")
          throw new Error("目录选择结果无效。");
        setDirectory(selected);
        setStorageMode(selected.hasWorkspace ? "existing" : "copy");
      }
    } catch (error) { setFeedback({ error: true, text: error.message }); }
    finally { setStorageBusy(false); }
  };

  const applyDirectory = async () => {
    if (!directory || typeof changeStorage !== "function") return;
    setFeedback(null);
    setStorageBusy(true);
    try {
      // The application owns flushing edits, safe migration and subsequent reload.
      await changeStorage({ directory: directory.directory, mode: storageMode });
      setDirectory(null);
      setFeedback({ text: "已切换数据目录。" });
    } catch (error) { setFeedback({ error: true, text: `切换数据目录失败：${error.message}` }); }
    finally { setStorageBusy(false); }
  };

  const chooseAgentDirectory = async () => {
    if (!agentAvailable || !desktop?.chooseAgentDirectory) return;
    setFeedback(null);
    setStorageBusy(true);
    try {
      const selected = await desktop.chooseAgentDirectory();
      if (!selected || selected.canceled) return;
      if (typeof selected.directory !== "string" || !selected.directory.trim()) throw new Error("Agent 目录选择结果无效。");
      change("agentWorkspace", selected.directory);
    } catch (error) { setFeedback({ error: true, text: `选择 Agent 工作目录失败：${error.message}` }); }
    finally { setStorageBusy(false); }
  };

  const openAgentDirectory = async () => {
    if (!desktop?.openAgentDirectory) return;
    setFeedback(null);
    setStorageBusy(true);
    try { await desktop.openAgentDirectory(); }
    catch (error) { setFeedback({ error: true, text: `打开 Agent 工作目录失败：${error.message}` }); }
    finally { setStorageBusy(false); }
  };

  const moveTab = (event, index) => {
    let next = index;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + tabs.length - 1) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    else return;
    event.preventDefault();
    setTab(tabs[next][0]);
    tabButtons.current[next]?.focus();
  };

  return <Modal title="应用设置" close={close} wide>
    <form className="preferences-form" data-settings-section={tab} onSubmit={(event) => { event.preventDefault(); if (!locked) save(); }}>
      <fieldset className="preferences-layout" disabled={locked} aria-busy={locked}>
        <nav className="preferences-tabs" role="tablist" aria-label="设置类别">
          {tabs.map(([key, label], index) => <button key={key} type="button" role="tab" id={`${id}-tab-${key}`}
            aria-controls={`${id}-panel`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1}
            className={tab === key ? "selected" : ""} ref={(element) => { tabButtons.current[index] = element; }}
            onClick={() => setTab(key)} onKeyDown={(event) => moveTab(event, index)}>{label}</button>)}
        </nav>
        <div className="preferences-panel" role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-tab-${tab}`} tabIndex={0}>
          {tab === "shortcuts" && <ShortcutSettings value={form.shortcuts} onChange={(value) => change("shortcuts", value)} disabled={locked} />}
          {tab === "model" && <>
            <h3>模型连接</h3>
            <p className="preference-description">发送对话、比较分支和生成总结时，内容会交给同一模型服务。画布与对话仍保存在本地。</p>
            <div className="preference-connection-status" data-state={discovery.status} aria-label="模型服务检查结果" aria-live="polite">
              <span className="preference-check-dot" />
              <div><strong>{discovery.status === "loading" ? "正在读取模型列表" : discovery.status === "success" ? `已读取 ${discovery.count} 个模型` : discovery.status === "error" ? "模型列表读取失败" : "尚未检查模型列表"}</strong>
                <p>{discovery.status === "success" ? "模型列表来自本次服务响应；回答能力需在会话中验证。" : discovery.status === "error" ? "检查服务地址和密钥后重试，具体原因见下方提示。" : "保存设置并读取模型后，可确认服务是否返回可用列表。"}</p></div>
            </div>
            <section className="preference-section" aria-label="模型服务">
            <div className="preference-providers">
              <button type="button" onClick={() => changeProvider(true)} disabled={locked} className={form.baseUrl.includes("11434") ? "selected" : ""}>
                <HardDrive size={17} /><span>本机 Ollama<small>使用本地运行的模型</small></span>
              </button>
              <button type="button" onClick={() => changeProvider(false)} disabled={locked} className={!form.baseUrl.includes("11434") ? "selected" : ""}>
                <Waypoints size={17} /><span>兼容 OpenAI 的 API<small>连接自己的模型服务</small></span>
              </button>
            </div>
            <label className="preference-field">API Base URL
              <input type="url" name="baseUrl" required value={form.baseUrl} autoComplete="off" maxLength={2048}
                placeholder="http://127.0.0.1:11434/v1" onChange={(event) => change("baseUrl", event.target.value)} />
              <small className="preference-hint">通常填写到 /v1，不要包含 /chat/completions。</small>
            </label>
            <label className="preference-field">模型名称
              <input name="model" required value={form.model} list={`${id}-models`} maxLength={256} autoComplete="off"
                placeholder="例如 qwen3:8b" onChange={(event) => change("model", event.target.value)} />
              <datalist id={`${id}-models`}>{models.map((model) => <option key={model} value={model} />)}</datalist>
            </label>
            <button type="button" className="button secondary preference-discover" disabled={locked || !form.baseUrl} onClick={() => save(true)}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} 保存设置并读取模型
            </button>
            </section>
            <section className="preference-section" aria-label="访问密钥">
            <h4>访问密钥</h4>
            <label className="preference-field">API Key <small>本地模型通常无需填写</small>
              <input type="password" name="apiKey" value={form.apiKey} autoComplete="new-password" maxLength={16000}
                placeholder={form.hasApiKey && !form.clearApiKey ? "已配置密钥，留空保留" : "填写服务提供的密钥"}
                onChange={(event) => {
                  dirty.current = true;
                  setModels([]);
                  setDiscovery({ status: "idle" });
                  setFeedback(null);
                  setForm((current) => ({ ...current, apiKey: event.target.value, clearApiKey: false }));
                }} />
            </label>
            <Toggle label="在此电脑记住密钥" checked={form.rememberKey} onChange={(value) => change("rememberKey", value)}
              hint={form.keyStorage === "encrypted" ? "启用后使用系统加密保存；关闭时仅在服务运行期间保留。" : "启用后会明文保存至当前数据目录的 settings.json；关闭时仅在服务运行期间保留。"} />
            {(form.hasApiKey || form.apiKey || form.clearApiKey) && <button type="button" className="text-button danger preference-clear-key" disabled={locked || form.clearApiKey}
              onClick={() => { dirty.current = true; setDiscovery({ status: "idle" }); setForm((current) => ({ ...current, apiKey: "", clearApiKey: true })); }}>
              {form.clearApiKey ? "已标记清除密钥，保存后生效" : "清除已配置的密钥"}
            </button>}
            </section>
            <section className="preference-section" aria-label="模型行为">
            <h4>模型行为</h4>
            <label className="preference-field">系统提示词
              <textarea name="systemPrompt" rows={3} maxLength={100000} value={form.systemPrompt}
                placeholder="例如：请使用中文，给出清晰解释，并用 LaTeX 编写公式。" onChange={(event) => change("systemPrompt", event.target.value)} />
              <small className="preference-hint">用于直接聊天和 Agent 的表达与任务偏好。Agent 还会收到内置的工具选择、执行和验证规则。</small>
            </label>
            <NumberField field="temperature" label="Temperature" hint="数值较低时回答通常更稳定，较高时表达更多样。" value={form.temperature} change={change} min={0} max={2} step={0.1} />
            </section>
          </>}
          {tab === "reading" && <>
            <h3>阅读</h3>
            <p className="preference-description">字体、行距与代码显示设置应用到会话回答。</p>
            <section className="preference-section" aria-label="主题与文字">
            <label className="preference-field">界面主题
              <select name="theme" value={form.theme} onChange={(event) => change("theme", event.target.value)}>
                <option value="system">跟随系统</option><option value="light">浅色</option><option value="dark">深色</option>
              </select>
            </label>
            <div className="preference-grid">
              <NumberField field="fontSize" label="正文字号" value={form.fontSize} change={change} min={12} max={24} unit="px" />
              <NumberField field="lineHeight" label="正文行高" value={form.lineHeight} change={change} min={1.4} max={2.4} step={0.05} unit="倍" />
            </div>
            </section>
            <section className="preference-section" aria-label="显示与动效">
            <Toggle label="代码自动折行" hint="长代码行在面板内换行；关闭后使用横向滚动。" checked={form.codeWrap} onChange={(value) => change("codeWrap", value)} />
            <Toggle label="减少动画" hint="减少画布移动、面板与卡片过渡带来的动态效果。" checked={form.reduceMotion} onChange={(value) => change("reduceMotion", value)} />
            </section>
            <div className={`preference-reading-preview ${form.codeWrap ? "code-wrap" : ""}`} aria-label="阅读实时预览" style={{ fontSize: `${form.fontSize || defaults.fontSize}px`, lineHeight: form.lineHeight || defaults.lineHeight }}>
              <span className="preference-preview-label">实时预览 · {form.fontSize || defaults.fontSize} px / {form.lineHeight || defaults.lineHeight}</span>
              <strong>让讨论沿不同方向展开</strong><p>同一个问题可以保留多条思路。回到共同起点，核对各分支的依据，再决定采用哪些结论。</p>
              <pre><code>{'const branch = { context: "保持原始上下文", focus: "展开当前问题", independent: true };'}</code></pre>
            </div>
          </>}
          {tab === "interaction" && <>
            <h3>交互</h3>
            <p className="preference-description">会话面板也可以直接拖动边缘调整宽度。</p>
            <section className="preference-section" aria-label="会话操作">
            <NumberField field="panelWidth" label="默认会话面板宽度" hint="可用范围 360–1600 px；实际宽度会适应窗口。" value={form.panelWidth} change={change} min={360} max={1600} unit="px" />
            <Toggle label="按 Enter 发送消息" hint={form.sendOnEnter ? "Enter 发送，Shift + Enter 换行；Ctrl/⌘ + Enter 也可发送。" : "Enter 换行，Ctrl/⌘ + Enter 发送。"}
              checked={form.sendOnEnter} onChange={(value) => change("sendOnEnter", value)} />
            </section>
            <section className="preference-section" aria-label="画布操作">
            <h4>画布</h4>
            <Toggle label="显示画布缩略地图" hint="在大画布中快速定位当前视图和其他分支。" checked={form.showMinimap} onChange={(value) => change("showMinimap", value)} />
            <Toggle label="新建分支后自动布局" hint="自动整理新增会话和结论卡的位置；想保留手动布局时可关闭。" checked={form.autoLayout} onChange={(value)=>change('autoLayout',value)} />
            </section>
          </>}
          {tab === "generation" && <>
            <h3>生成与总结</h3>
            <p className="preference-description">总结使用当前连接的模型，结合分支位置、相关分支总结与当前会话内容生成。</p>
            <section className="preference-section" aria-label="自动总结与资料边界">
            <Toggle label="自动生成有区分性的总结" hint="首轮回答完成后、创建新分支时更新相关会话的总结；也可手动重新生成。" checked={form.autoSummary} onChange={(value) => change("autoSummary", value)} />
            <Toggle label="允许本地资料参与自动摘要" hint="默认关闭：导入资料及继承资料的分支仅在主动生成摘要时发送。开启后，自动摘要也会将资料交给配置的模型服务。" checked={form.autoSummaryMaterials} onChange={(value)=>change('autoSummaryMaterials',value)} />
            <NumberField field="summaryMaxLength" label="总结目标字数" hint="模型会尽量遵守目标长度，用简短内容区分每条思路。" value={form.summaryMaxLength} change={change} min={80} max={400} unit="字" />
            </section>
            <section className="preference-section" aria-label="请求限制">
            <h4>请求限制</h4>
            <NumberField field="maxOutputTokens" label="单次回答输出上限" hint="填 0 使用模型服务默认值。服务需要支持 max_tokens 参数。" value={form.maxOutputTokens} change={change} min={0} max={32768} unit="tokens" />
            <NumberField field="requestTimeoutSeconds" label="请求超时" hint="应用于回答、总结和模型列表请求。大型本地模型可适当延长。" value={form.requestTimeoutSeconds} change={change} min={30} max={600} unit="秒" />
            </section>
          </>}
          {tab === "agent" && <>
            <h3>Agent</h3>
            <p className="preference-description">保留直接聊天，可在会话中按需切换到 Agent，让模型分步读取文件、提出编辑、运行验证，以及搜索和下载。</p>
            {!agentAvailable && <p className="preference-unavailable">Agent 后台需要桌面应用。当前模式仍可使用直接聊天。</p>}
            <section className="preference-section" aria-label="Agent 开关">
              <Toggle label="启用可选 Agent 后台" checked={form.agentEnabled} disabled={!agentAvailable}
                hint="启用后仍默认直接聊天；只有明确选择 Agent 的任务才会使用工具。关闭后保留工作目录与权限设置。"
                onChange={(value) => change("agentEnabled", value)} />
            </section>
            <fieldset className="preference-agent-options" disabled={!agentAvailable || !form.agentEnabled}>
              <section className="preference-section" aria-label="Agent 引擎与目录">
                <label className="preference-field">执行引擎
                  <select name="agentEngine" value={form.agentEngine} onChange={(event) => change("agentEngine", event.target.value)}>
                    <option value="compatible">当前模型 · 兼容工具调用</option>
                  </select>
                  <small className="preference-hint">复用“模型连接”中的本地模型或 API。模型服务必须支持工具调用；不会自动切换其他模型。</small>
                </label>
                <label className="preference-field">Agent 工作目录
                  <input name="agentWorkspace" value={form.agentWorkspace} readOnly placeholder="选择允许 Agent 处理文件的文件夹" />
                  <small className="preference-hint">会话与分支独立保存讨论，但共享此目录中的文件。新建分支不会复制或隔离文件。</small>
                </label>
                <div className="preference-directory-actions">
                  <button type="button" className="button secondary" disabled={!desktop?.chooseAgentDirectory} onClick={chooseAgentDirectory}>
                    <FolderOpen size={15} /> 选择 Agent 工作目录
                  </button>
                  {desktop?.openAgentDirectory && form.agentWorkspace && <button type="button" className="button secondary"
                    disabled={!form.agentWorkspace || form.agentWorkspace !== initial?.agentWorkspace} onClick={openAgentDirectory}>
                    <FolderOpen size={15} /> 打开 Agent 工作目录
                  </button>}
                </div>
                {form.agentWorkspace && form.agentWorkspace !== initial?.agentWorkspace && <small className="preference-hint">保存设置后可打开新选择的目录。</small>}
              </section>
              <section className="preference-section" aria-label="Agent 工具权限">
                <h4>工具权限</h4>
                <Toggle label="允许运行命令" checked={form.agentAllowCommands} onChange={(value) => change("agentAllowCommands", value)}
                  hint="命令以当前系统用户运行，不受工作目录沙箱限制。每条命令都需要你确认后才会执行。" />
                <Toggle label="允许网络搜索与下载" checked={form.agentAllowNetwork} onChange={(value) => change("agentAllowNetwork", value)}
                  hint="联网工具会访问外部服务；搜索词和目标网址会发送给对应服务。下载写入文件需要逐次确认。" />
                <label className="preference-field">SearXNG 搜索 API <small>可选</small>
                  <input type="url" name="agentSearchEndpoint" value={form.agentSearchEndpoint} disabled={!form.agentAllowNetwork}
                    maxLength={2048} autoComplete="off" placeholder="https://search.example/search"
                    onChange={(event) => change("agentSearchEndpoint", event.target.value)} />
                  <small className="preference-hint">填写支持 JSON 结果的完整 HTTPS SearXNG /search API 地址；应用仅追加 q 和 format=json 参数，不会自动补 /search。留空时不提供搜索工具，仍可按网址读取或下载。</small>
                </label>
                <NumberField field="agentMaxSteps" label="单次任务最大步骤" hint="限制一项任务连续调用模型的轮数，到达上限后停下，等待你继续。"
                  value={form.agentMaxSteps} change={change} min={1} max={30} unit="步" />
              </section>
            </fieldset>
            <AgentGuide form={form} available={agentAvailable} />
            <aside className="preference-data-boundary" aria-label="Agent 执行边界">
              <h4>每次操作都可检查</h4>
              <p>读取文件和工具结果会成为模型的任务上下文。编辑、创建或下载文件前会展示目标与内容，需你确认后执行；开启工具权限不代表自动批准写入。</p>
              <p>工作目录用于约束文件工具的位置。运行命令具有当前用户的系统权限，请在确认界面核对完整命令。</p>
            </aside>
          </>}
          {tab === "data" && <>
            <h3>本地数据</h3>
            <p className="preference-description">目录包含对话、画布、设置与自动备份。切换目录前应用会先保存当前对话。</p>
            <section className="preference-section" aria-label="数据存储位置">
            <label className="preference-field">当前数据目录
              <input name="dataDirectory" readOnly value={form.dataDirectory || initial?.dataDirectory || "服务尚未返回数据目录"} />
            </label>
            {desktop ? <>
              <div className="preference-directory-actions">
                {desktop.openDataDirectory && <button type="button" className="button secondary" disabled={locked} onClick={async () => {
                  try { await desktop.openDataDirectory(); }
                  catch (error) { setFeedback({ error: true, text: error.message }); }
                }}><FolderOpen size={15} /> 打开目录</button>}
                {desktop.chooseDataDirectory && <button type="button" className="button secondary" disabled={locked || typeof changeStorage !== "function"} onClick={chooseDirectory}>
                  <HardDrive size={15} /> 选择其他目录
                </button>}
              </div>
              {directory && <div className="preference-storage-choice">
                <strong>即将使用的目录</strong><code>{directory.directory}</code>
                <label><input type="radio" name="storageMode" value="copy" checked={storageMode === "copy"} disabled={directory.hasWorkspace || locked} onChange={() => setStorageMode("copy")} />
                  <span>复制当前对话与设置到新目录<small>{directory.hasWorkspace ? "目标已有对话数据，不能覆盖。" : "保留原目录中的文件。"}</small></span>
                </label>
                <label><input type="radio" name="storageMode" value="existing" checked={storageMode === "existing"} disabled={!directory.hasWorkspace || locked} onChange={() => setStorageMode("existing")} />
                  <span>使用目标目录中已有的对话<small>{directory.hasWorkspace ? "切换后加载已有内容，当前目录中的文件保留。" : "该目录尚未包含对话数据。"}</small></span>
                </label>
                <div className="preference-directory-actions">
                  <button type="button" className="button secondary" disabled={locked} onClick={() => setDirectory(null)}>取消选择</button>
                  <button type="button" className="button primary" disabled={locked} onClick={applyDirectory}>
                    {storageBusy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} 使用此目录并重新载入
                  </button>
                </div>
                <small className="preference-hint">切换目录会重新载入应用；其他设置页中的未保存修改不会自动应用。</small>
              </div>}
              {!desktop.chooseDataDirectory && <p className="preference-hint">当前桌面版本不支持更换数据目录，请使用新版应用程序。</p>}
            </> : <p className="preference-unavailable">更换数据目录需要桌面应用。当前浏览器模式只可查看本地服务使用的目录。</p>}
            </section>
            <aside className="preference-data-boundary" aria-label="本地存储与模型发送边界"><h4>存储与发送范围</h4>
              <p>导入资料仅在本机提取并保存文字，原文件不会复制到数据目录。回答、比较和手动总结时，所需内容会发送给你配置的模型服务。</p>
              <p>资料默认不参与自动摘要；可在“生成与总结”中单独允许。归档与回收站保留内容，只有永久删除会清理对应会话。</p>
            </aside>
          </>}
        </div>
      </fieldset>
      {feedback && <p className={`preference-feedback ${feedback.error ? "error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
      <div className="preferences-footer">
        <span>修改在保存后生效</span>
        <button type="button" className="button secondary" disabled={locked} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={locked}>
          {busy ? <LoaderCircle size={15} className="spin" /> : <Check size={15} />} 保存设置
        </button>
      </div>
    </form>
  </Modal>;
}
