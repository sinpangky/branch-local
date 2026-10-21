import { normalizeUsage } from '../shared/provider.mjs';

function providerError(payload, fallback) {
  const error = payload?.error ?? payload;
  const message = typeof error === "string" ? error : error?.message;
  return new Error(
    typeof message === "string" && message.trim() ? message : fallback,
  );
}

/** Read visible assistant content from an OpenAI-compatible response. */
export async function readChatStream(response, onText, onUsage = () => {}, onAgent) {
  if (!response.ok) {
    const body = await response.text();
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      /* A gateway may return plain text. */
    }
    throw providerError(
      payload,
      body.trim() || `Request failed (${response.status}).`,
    );
  }

  let result = "";
  let agentCompleted=false;
  const append = (content) => {
    if (typeof content !== "string" || !content) return;
    result += content;
    onText(content);
  };
  const complete = () => {
    if (!result.trim()&&!agentCompleted)
      throw new Error("The provider returned no assistant content.");
    return result;
  };

  if (
    (response.headers.get("content-type") || "")
      .toLowerCase()
      .includes("application/json")
  ) {
    const payload = await response.json();
    if (payload?.error)
      throw providerError(payload, "The provider returned an error.");
    const usage = normalizeUsage(payload);
    if (usage) onUsage(usage);
    append(payload?.choices?.[0]?.message?.content);
    return complete();
  }

  if (!response.body)
    throw new Error("The provider returned no response body.");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data = [];
  let event = "";
  let done = false;

  const dispatch = () => {
    const eventName = event;
    const text = data.join("\n");
    data = [];
    event = "";
    if (!text && eventName !== "error") return;
    if (text.trim() === "[DONE]") {
      done = true;
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(
        eventName === "error"
          ? text || "The provider returned an error."
          : "Invalid JSON in the provider event stream.",
      );
    }
    if(eventName==='agent'){
      if(typeof onAgent==='function'){
        onAgent(payload);
        if(payload?.type==='run.finished'&&payload.status==='completed')agentCompleted=true;
        if(payload?.type==='run.finished'&&payload.status==='cancelled')throw new DOMException('Agent 已停止。','AbortError');
      }
      return;
    }
    if (eventName === "error" || payload?.error) {
      throw providerError(payload, "The provider returned an error.");
    }
    const usage = normalizeUsage(payload);
    if (usage) onUsage(usage);
    // Deliberately ignore reasoning_content and all other non-content fields.
    append(payload?.choices?.[0]?.delta?.content);
  };
  const line = (value) => {
    if (!value) {
      dispatch();
      return;
    }
    if (value.startsWith(":")) return;
    const colon = value.indexOf(":");
    const name = colon === -1 ? value : value.slice(0, colon);
    let content = colon === -1 ? "" : value.slice(colon + 1);
    if (content.startsWith(" ")) content = content.slice(1);
    if (name === "data") data.push(content);
    if (name === "event") event = content;
  };
  const consume = () => {
    let newline;
    while (!done && (newline = buffer.indexOf("\n")) !== -1) {
      const value = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      line(value);
    }
  };

  try {
    while (!done) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        consume();
        if (!done && buffer) line(buffer.replace(/\r$/, ""));
        if (!done) dispatch();
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      consume();
    }
    return complete();
  } finally {
    try {
      await reader.cancel();
    } catch {
      // Cleanup must not replace a parse, callback, or upstream abort error.
    }
    reader.releaseLock();
  }
}
