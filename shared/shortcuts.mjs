// Shared shortcut definitions and parsing. This module is safe in both Node and the renderer.
export const SHORTCUT_ACTIONS = Object.freeze([
  { id: "new-conversation", label: "新建独立会话", group: "创建与分支", defaultBinding: "Ctrl+N", scope: "global" },
  { id: "new-board", label: "新建画布", group: "创建与分支", defaultBinding: "Ctrl+Shift+N", scope: "global" },
  { id: "branch", label: "从当前会话创建分支", group: "创建与分支", defaultBinding: "Ctrl+Shift+B", scope: "node" },
  { id: "merge", label: "合并会话", group: "创建与分支", defaultBinding: "Ctrl+Shift+M", scope: "node" },
  { id: "rename", label: "重命名当前会话", group: "会话管理", defaultBinding: "F2", scope: "node" },
  { id: "duplicate", label: "复制当前会话与子分支", group: "会话管理", defaultBinding: "Ctrl+Shift+D", scope: "node" },
  { id: "summary", label: "更新当前会话总结", group: "会话管理", defaultBinding: "Ctrl+Shift+R", scope: "node" },
  { id: "archive", label: "归档当前分支", group: "会话管理", defaultBinding: "Ctrl+Shift+A", scope: "node" },
  { id: "trash", label: "移除当前分支至回收站", group: "会话管理", defaultBinding: "Delete", scope: "node" },
  { id: "toggle-children", label: "折叠或展开子分支", group: "会话管理", defaultBinding: "Ctrl+Shift+E", scope: "node" },
  { id: "undo-remove", label: "撤销最近一次移除", group: "会话管理", defaultBinding: "Ctrl+Z", scope: "canvas" },
  { id: "arrange", label: "自动排列节点", group: "画布与导航", defaultBinding: "Ctrl+Shift+L", scope: "canvas" },
  { id: "fit", label: "适应画布", group: "画布与导航", defaultBinding: "Ctrl+0", scope: "canvas" },
  { id: "focus-node", label: "居中当前会话", group: "画布与导航", defaultBinding: "Ctrl+Shift+F", scope: "node" },
  { id: "focus-composer", label: "聚焦当前会话输入框", group: "画布与导航", defaultBinding: "Ctrl+J", scope: "global" },
  { id: "search", label: "搜索全部会话", group: "画布与导航", defaultBinding: "Ctrl+K", scope: "global" },
  { id: "show-archive", label: "打开归档", group: "会话管理", defaultBinding: "Ctrl+Shift+H", scope: "global" },
  { id: "show-trash", label: "打开回收站", group: "会话管理", defaultBinding: "Ctrl+Shift+Delete", scope: "global" },
  { id: "settings", label: "打开应用设置", group: "应用与数据", defaultBinding: "Ctrl+Comma", scope: "global" },
  { id: "import", label: "导入工作区", group: "应用与数据", defaultBinding: "Ctrl+O", scope: "global" },
  { id: "export", label: "导出工作区", group: "应用与数据", defaultBinding: "Ctrl+Shift+S", scope: "global" },
  { id: "export-conversation", label: "导出当前会话为 Markdown", group: "应用与数据", defaultBinding: "Ctrl+Shift+X", scope: "node" },
  { id: "help", label: "打开使用帮助", group: "应用与数据", defaultBinding: "F1", scope: "global" },
].map((action) => Object.freeze(action)));

export const DEFAULT_SHORTCUTS = Object.freeze(Object.fromEntries(
  SHORTCUT_ACTIONS.map((action) => [action.id, action.defaultBinding]),
));
const byId = new Map(SHORTCUT_ACTIONS.map((action) => [action.id, action]));
const punctuation = Object.freeze({
  ",": "Comma", ".": "Period", "/": "Slash", "\\": "Backslash", ";": "Semicolon", "'": "Quote",
  "[": "BracketLeft", "]": "BracketRight", "-": "Minus", "=": "Equal", "`": "Backquote",
});
const displayKeys = Object.freeze({
  Comma: ",", Period: ".", Slash: "/", Backslash: "\\", Semicolon: ";", Quote: "'",
  BracketLeft: "[", BracketRight: "]", Minus: "-", Equal: "=", Backquote: "`", Space: "Space",
});
const namedKeys = new Map([
  ...Object.values(punctuation), "Delete", "Backspace", "Enter", "Space",
  ...Array.from({ length: 12 }, (_item, index) => `F${index + 1}`),
].map((key) => [key.toLowerCase(), key]));
namedKeys.set("del", "Delete");
namedKeys.set("return", "Enter");
namedKeys.set("spacebar", "Space");

function keyName(value) {
  if (typeof value !== "string") return null;
  if (/^[a-z]$/i.test(value)) return value.toUpperCase();
  if (/^[0-9]$/.test(value)) return value;
  if (/^Key[A-Z]$/i.test(value)) return value.slice(3).toUpperCase();
  if (/^Digit[0-9]$/i.test(value)) return value.slice(5);
  return (Object.hasOwn(punctuation, value) ? punctuation[value] : namedKeys.get(value.toLowerCase())) ?? null;
}

function normalizeBinding(value) {
  if (typeof value !== "string" || value.length > 64) throw new Error("快捷键必须是长度不超过 64 的文本。");
  if (value === "") return "";
  const pieces = value.trim().split("+").map((part) => part.trim());
  if (pieces.some((part) => !part)) throw new Error("快捷键格式无效，请使用 Ctrl+N、Ctrl+Shift+N 或 F2 这样的组合。");
  let ctrl = false;
  let shift = false;
  let key = null;
  for (const part of pieces) {
    if (/^(alt|altgr|altgraph|meta|win|windows|super|command|cmd|commandorcontrol)$/i.test(part))
      throw new Error("应用快捷键不能使用 Alt、AltGr 或 Windows/Meta 组合。");
    if (/^(ctrl|control)$/i.test(part)) {
      if (ctrl) throw new Error("快捷键中 Ctrl 不能重复。");
      ctrl = true;
    } else if (/^shift$/i.test(part)) {
      if (shift) throw new Error("快捷键中 Shift 不能重复。");
      shift = true;
    } else {
      const candidate = keyName(part);
      if (!candidate || key) throw new Error("快捷键需要一个受支持的按键；Tab、Escape 和方向导航键保留给界面操作。");
      key = candidate;
    }
  }
  if (!key) throw new Error("请在 Ctrl 或 Shift 之外再按一个键。");
  if (key === "Enter") throw new Error("Enter 用于发送消息或换行，不能作为应用快捷键；Escape 和导航键也保留给界面操作。");
  if (!ctrl && !/^F(?:[1-9]|1[0-2])$/.test(key) && key !== "Delete")
    throw new Error("字母、数字及符号快捷键必须包含 Ctrl，避免影响正常输入。");
  if ((!ctrl && shift && key === "Delete") || (ctrl && !shift && ["A", "C", "V", "X"].includes(key)))
    throw new Error("该快捷键保留用于文字选择、复制、粘贴或剪切。");
  if (ctrl && key === "Space") throw new Error("Ctrl+Space 保留给输入法，请选择其他快捷键。");
  return `${ctrl ? "Ctrl+" : ""}${shift ? "Shift+" : ""}${key}`;
}

function checkedMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value)))
    throw new Error("快捷键设置必须是按操作名称保存的 JSON 对象。");
  const output = {};
  for (const id of Reflect.ownKeys(value)) {
    if (typeof id !== "string" || !byId.has(id)) throw new Error("快捷键设置包含未知的操作名称。");
    const descriptor = Object.getOwnPropertyDescriptor(value, id);
    if (!Object.hasOwn(descriptor, "value")) throw new Error("快捷键设置不能包含访问器。");
    try { output[id] = normalizeBinding(descriptor.value); }
    catch (error) { throw new Error(`“${byId.get(id).label}”：${error.message}`); }
  }
  return output;
}

/** Partial updates preserve existing bindings, and conflicts are checked after the complete merge. */
export function validateShortcuts(overrides, current = DEFAULT_SHORTCUTS) {
  const result = { ...DEFAULT_SHORTCUTS, ...checkedMap(current), ...checkedMap(overrides) };
  const occupied = new Map();
  for (const action of SHORTCUT_ACTIONS) {
    const binding = result[action.id];
    if (!binding) continue;
    if (occupied.has(binding)) throw new Error(
      `快捷键 ${formatShortcut(binding)} 已用于“${byId.get(occupied.get(binding)).label}”，不能再分配给“${action.label}”。`,
    );
    occupied.set(binding, action.id);
  }
  return result;
}

export function resolveShortcuts(overrides) {
  return validateShortcuts(overrides === undefined ? {} : overrides);
}

/** Return a canonical binding without mutating/cancelling an event. Unsupported input returns null. */
export function shortcutFromEvent(event) {
  if (!event || event.isComposing || event.keyCode === 229 || event.repeat || event.altKey || event.metaKey
      || ["Process", "Dead", "Unidentified"].includes(event.key)) return null;
  try { if (event.getModifierState?.("AltGraph")) return null; }
  catch { return null; }
  const key = keyName(event.code) ?? keyName(event.key);
  if (!key) return null;
  try { return normalizeBinding(`${event.ctrlKey ? "Ctrl+" : ""}${event.shiftKey ? "Shift+" : ""}${key}`); }
  catch { return null; }
}

export function formatShortcut(combo) {
  let normalized;
  try { normalized = normalizeBinding(combo); }
  catch { return "未设置"; }
  if (!normalized) return "未设置";
  return normalized.split("+").map((part) => displayKeys[part] ?? part).join(" + ");
}

export function matchShortcut(event, combo) {
  if (!combo) return false;
  try { return shortcutFromEvent(event) === normalizeBinding(combo); }
  catch { return false; }
}
