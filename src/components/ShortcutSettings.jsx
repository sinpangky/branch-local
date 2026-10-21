import React, { useEffect, useId, useState } from "react";
import { Search } from "lucide-react";
import {
  SHORTCUT_ACTIONS, DEFAULT_SHORTCUTS, resolveShortcuts, validateShortcuts,
  shortcutFromEvent, formatShortcut,
} from "../../shared/shortcuts.mjs";

const modifierKeys = new Set(["Control", "Alt", "Shift", "Meta", "AltGraph"]);

export default function ShortcutSettings({ value, onChange, disabled = false }) {
  const bindings = resolveShortcuts(value);
  const [recording, setRecording] = useState(null);
  const [feedback, setFeedback] = useState(null);
  const [query, setQuery] = useState("");
  const id = useId();
  const modifiedCount = SHORTCUT_ACTIONS.filter((action) => bindings[action.id] !== action.defaultBinding).length;
  const searchable = (text) => text.toLocaleLowerCase().replace(/\s+/g, "");
  const search = searchable(query.trim());
  const filtered = SHORTCUT_ACTIONS.filter((action) => !search || searchable(`${action.label}\n${action.group}\n${action.id}\n${bindings[action.id]}\n${formatShortcut(bindings[action.id])}`).includes(search));

  const apply = (action, binding) => {
    const conflict = binding && SHORTCUT_ACTIONS.find((other) => other.id !== action.id && bindings[other.id] === binding);
    if (conflict) {
      setFeedback({ error: true, text: `「${formatShortcut(binding)}」已用于「${conflict.label}」，请更换组合。原快捷键保留。` });
      return false;
    }
    try {
      const next = validateShortcuts({ ...bindings, [action.id]: binding });
      onChange(next);
      setRecording(null);
      setFeedback({ text: binding ? `「${action.label}」已设为 ${formatShortcut(binding)}，保存设置后生效。` : `已清除「${action.label}」的快捷键，保存设置后生效。` });
      return true;
    } catch (error) {
      setFeedback({ error: true, text: `${error.message} 原快捷键保留。` });
      return false;
    }
  };

  useEffect(() => {
    if (!recording || disabled) return;
    const handle = (event) => {
      // Capture before the application's and Modal's bubble-phase listeners.
      // Recording must never execute the action being assigned or close settings.
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (modifierKeys.has(event.key)) return;
      if (event.repeat) return;
      if (event.isComposing || event.keyCode === 229 || event.key === "Process" || event.key === "Dead" || event.key === "Unidentified") {
        setFeedback({ error: true, text: "输入法组合或死键不能用作快捷键。请切换到直接输入后重试。" });
        return;
      }
      if (event.key === "Escape" && !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey) {
        setRecording(null);
        setFeedback({ text: "已取消录制，原快捷键保留。" });
        return;
      }
      try {
        const binding = shortcutFromEvent(event);
        if (!binding) {
          if (!event.metaKey && !event.altKey) {
            // Ask the shared validator for a precise explanation of reserved
            // editing/input-method keys and combinations lacking Ctrl.
            const key = event.code || (event.key === " " ? "Space" : event.key);
            const candidate = `${event.ctrlKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${key}`;
            try { validateShortcuts({ ...bindings, [recording]: candidate }); }
            catch (error) { setFeedback({ error: true, text: error.message }); return; }
          }
          const reason = event.metaKey ? "当前版本不支持 Meta / Command 组合。"
            : event.altKey ? "当前版本不支持 Alt 组合。"
            : `「${event.key}」不是可用的快捷键。`;
          setFeedback({ error: true, text: `${reason}字母和数字需要搭配 Ctrl，可再加 Shift；也可用 F2、Delete 等功能键。` });
          return;
        }
        apply(SHORTCUT_ACTIONS.find((action) => action.id === recording), binding);
      } catch (error) {
        setFeedback({ error: true, text: error.message });
      }
    };
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [recording, value, disabled]);

  useEffect(() => { if (disabled) setRecording(null); }, [disabled]);

  const groups = [...new Set(filtered.map((action) => action.group))];
  return <div className="shortcut-settings">
    <h3>快捷键</h3>
    <p className="preference-description">点击当前按键后，直接按下新的组合。修改在保存设置后生效。当前卡片优先于打开的会话；输入框中不会触发归档、删除等操作。</p>
    <p className="preference-hint">树目录中的方向键用于浏览层级，Enter 打开当前项；这些控件导航按键保持固定。</p>
    <div className="shortcut-settings-toolbar">
      <label className="shortcut-search"><Search size={16}/><input type="search" aria-label="搜索快捷键" name="shortcutSearch" value={query} placeholder="搜索操作或组合键" disabled={disabled || Boolean(recording)} onChange={(event) => setQuery(event.target.value)} /></label>
      <button type="button" className="button secondary" disabled={disabled || modifiedCount === 0} title="仅恢复当前设置草稿，保存后生效" onClick={() => {
        try {
          onChange(validateShortcuts({ ...DEFAULT_SHORTCUTS }));
          setRecording(null);
          setFeedback({ text: "已恢复全部默认快捷键，保存设置后生效。" });
        } catch (error) { setFeedback({ error: true, text: error.message }); }
      }}>恢复全部默认快捷键</button>
    </div>
    <div className="shortcut-summary"><span>{search ? `显示 ${filtered.length} / ${SHORTCUT_ACTIONS.length} 项` : `${SHORTCUT_ACTIONS.length} 项操作`}<strong aria-label="快捷键修改数量"> · {modifiedCount} 项已修改</strong></span><span id={`${id}-recording-help`}>Esc 取消录制</span></div>
    {feedback && <p className={`preference-feedback ${feedback.error ? "error" : ""}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p>}
    {!filtered.length && <div className="shortcut-empty" role="status"><strong>没有匹配的快捷键</strong><p>试试操作名称、分组，或 Ctrl + B 这样的组合键。</p><button type="button" className="button secondary" disabled={disabled} onClick={() => setQuery("")}>清空搜索</button></div>}
    {groups.map((group, index) => <section className="shortcut-group" key={group} aria-labelledby={`${id}-${index}`}>
      <h4 id={`${id}-${index}`}>{group}</h4>
      {filtered.filter((action) => action.group === group).map((action) => <div className={`shortcut-row ${recording === action.id ? "recording" : ""}`} key={action.id} data-shortcut-action={action.id}>
        <span className="shortcut-action-label">{action.label}{bindings[action.id] !== action.defaultBinding && <small className="shortcut-modified">已修改</small>}</span>
        <button type="button" className="shortcut-binding" aria-label={`录制快捷键：${action.label}`} aria-describedby={`${id}-recording-help`} title={`默认：${action.defaultBinding ? formatShortcut(action.defaultBinding) : "未设置"}`} aria-pressed={recording === action.id} disabled={disabled}
          onClick={() => { setRecording(action.id); setFeedback({ text: `正在录制「${action.label}」：请按下组合键，Esc 取消。` }); }}>
          {recording === action.id ? <span>请按下组合键…</span> : bindings[action.id] ? <kbd>{formatShortcut(bindings[action.id])}</kbd> : <span className="shortcut-unbound">未设置</span>}
        </button>
        <button type="button" className="shortcut-row-action" aria-label={`清除快捷键：${action.label}`} disabled={disabled || !bindings[action.id]}
          onClick={() => apply(action, "")}>清除</button>
        <button type="button" className="shortcut-row-action" aria-label={`恢复默认快捷键：${action.label}`} disabled={disabled || bindings[action.id] === action.defaultBinding}
          onClick={() => apply(action, action.defaultBinding)}>默认</button>
      </div>)}
    </section>)}
  </div>;
}
