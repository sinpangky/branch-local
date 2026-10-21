// Portable Agent history. Execution state and tool credentials never belong here.
export const AGENT_ENGINE_ID = "compatible";
export const AGENT_RUN_STATUSES = Object.freeze(["running", "completed", "cancelled", "failed", "interrupted"]);
export const AGENT_TOOL_STATUSES = Object.freeze(["running", "completed", "denied", "failed", "cancelled", "awaiting-approval"]);
export const AGENT_EVENT_TYPES = Object.freeze([
  "run.started", "text.delta", "tool.started", "tool.completed", "approval.required", "run.finished",
]);
export const AGENT_LIMITS = Object.freeze({
  events: 60,
  artifacts: 60,
  detailLength: 12000,
  summaryLength: 500,
  pathLength: 1024,
  totalTextLength: 512 * 1024,
  steps: 10000,
});

function record(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}必须是普通对象。`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new Error(`${label}必须是普通 JSON 对象。`);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 32) throw new Error(`${label}属性过多。`);
  for (const key of keys) {
    if (typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key)) throw new Error(`${label}包含非法属性。`);
    if (!Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value")) throw new Error(`${label}不能包含访问器。`);
  }
  return value;
}

function list(value, label, maximum) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum)
    throw new Error(`${label}格式错误或数量超过 ${maximum}。`);
  if (Reflect.ownKeys(value).length !== value.length + 1) throw new Error(`${label}包含非法属性或空槽。`);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new Error(`${label}不能包含空槽或访问器。`);
    result.push(descriptor.value);
  }
  return result;
}

function timestamp(value, label) {
  if (typeof value !== "string" || value.length > 40
      || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(`${label}必须是有效 ISO 时间。`);
  // Date.parse normalizes impossible calendar dates such as February 31.
  const [year, month, day, hour, minute, second] = value.slice(0, 19).split(/[-T:]/).map(Number);
  const calendar = new Date(0);
  calendar.setUTCFullYear(year, month - 1, day);
  calendar.setUTCHours(hour, minute, second, 0);
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day
      || calendar.getUTCHours() !== hour || calendar.getUTCMinutes() !== minute || calendar.getUTCSeconds() !== second)
    throw new Error(`${label}必须是有效 ISO 时间。`);
  const normalized = new Date(value).toISOString();
  if (!/^\d{4}-/.test(normalized)) throw new Error(`${label}超出支持的年份范围。`);
  return normalized;
}

/** Validate only portable history; unknown fields are discarded, never retained as arbitrary payloads. */
export function validateAgentRun(value) {
  record(value, "Agent 运行记录");
  let textLength = 0;
  const text = (raw, label, maximum, { empty = false } = {}) => {
    if (typeof raw !== "string" || raw.length > maximum || (!empty && !raw.trim()) || raw.includes("\0"))
      throw new Error(`${label}为空、过长或格式错误。`);
    textLength += raw.length;
    if (textLength > AGENT_LIMITS.totalTextLength) throw new Error("Agent 运行记录文本总量过大。");
    return raw;
  };
  const id = (raw, label) => {
    const result = text(raw, label, 128);
    if (!/^[a-zA-Z0-9_-]+$/.test(result)) throw new Error(`${label}格式错误。`);
    return result;
  };
  const engine = text(value.engine, "Agent 引擎 ID", 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(engine)) throw new Error("Agent 引擎 ID 格式错误。");
  if (!AGENT_RUN_STATUSES.includes(value.status)) throw new Error("Agent 运行状态无效。");
  if (!Number.isSafeInteger(value.steps) || value.steps < 0 || value.steps > AGENT_LIMITS.steps)
    throw new Error(`Agent 步数必须是 0–${AGENT_LIMITS.steps} 的整数。`);
  const run = {
    id: id(value.id, "Agent 运行 ID"),
    engine,
    status: value.status,
    startedAt: timestamp(value.startedAt, "Agent 开始时间"),
    ...(value.finishedAt !== undefined ? { finishedAt: timestamp(value.finishedAt, "Agent 结束时间") } : {}),
    steps: value.steps,
    events: list(value.events, "Agent 工具记录", AGENT_LIMITS.events).map((entry) => {
      record(entry, "Agent 工具记录项");
      if (!AGENT_TOOL_STATUSES.includes(entry.status)) throw new Error("Agent 工具状态无效。");
      return {
        id: id(entry.id, "Agent 工具记录 ID"),
        tool: text(entry.tool, "Agent 工具名称", 128),
        status: entry.status,
        summary: text(entry.summary, "Agent 工具摘要", AGENT_LIMITS.summaryLength, { empty: true }),
        ...(entry.detail !== undefined ? { detail: text(entry.detail, "Agent 工具详情", AGENT_LIMITS.detailLength, { empty: true }) } : {}),
        at: timestamp(entry.at, "Agent 工具时间"),
      };
    }),
    artifacts: list(value.artifacts, "Agent 产物", AGENT_LIMITS.artifacts).map((entry) => {
      record(entry, "Agent 产物项");
      if (!["file", "download"].includes(entry.kind)) throw new Error("Agent 产物类型无效。");
      return {
        path: text(entry.path, "Agent 产物路径", AGENT_LIMITS.pathLength),
        kind: entry.kind,
        ...(entry.summary !== undefined ? { summary: text(entry.summary, "Agent 产物摘要", AGENT_LIMITS.summaryLength, { empty: true }) } : {}),
      };
    }),
  };
  if (run.finishedAt && run.finishedAt < run.startedAt) throw new Error("Agent 结束时间不能早于开始时间。");
  return run;
}

/** Call once on application load, never on ordinary saves or live updates. */
export function normalizeAgentRunForLoad(value, interruptedAt = new Date().toISOString()) {
  const run = validateAgentRun(value);
  if (run.status !== "running") return run;
  const finishedAt = timestamp(interruptedAt, "Agent 中断时间");
  return validateAgentRun({
    ...run,
    status: "interrupted",
    finishedAt: finishedAt < run.startedAt ? run.startedAt : finishedAt,
    events: run.events.map((event) => ["running", "awaiting-approval"].includes(event.status)
      ? { ...event, status: "cancelled" } : event),
  });
}
