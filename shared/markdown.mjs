import { Marked, Tokenizer } from "marked";
import DOMPurify from "dompurify";
import katex from "katex";
import hljs from "highlight.js/lib/common";

export const MESSAGE_SANITIZE_OPTIONS = Object.freeze({
  ALLOWED_TAGS: [
    "p", "br", "strong", "em", "del", "h1", "h2", "h3", "h4", "h5", "h6",
    "ul", "ol", "li", "blockquote", "pre", "code", "table", "thead", "tbody",
    "tr", "th", "td", "a", "hr", "div", "span", "button", "input",
  ],
  ALLOWED_ATTR: [
    "class", "href", "title", "target", "rel", "align", "type", "disabled", "checked",
    "start", "aria-label", "data-copy-code", "data-message-formula",
    "data-image-ref", "data-image-alt", "data-load-image",
  ],
  ALLOW_DATA_ATTR: false,
  FORBID_TAGS: ["script", "style", "iframe", "object", "embed", "form", "img", "svg", "math"],
  FORBID_ATTR: ["style", "id", "name"],
});

const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));

/** Recover explicit transport wrappers, never globally unescape model prose/code. */
export function normalizeMessageText(value) {
  let text = typeof value === "string" ? value : String(value ?? "");
  for (let depth = 0; depth < 2; depth += 1) {
    const trimmed = text.trim();
    if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) break;
    try {
      const decoded = JSON.parse(trimmed);
      if (typeof decoded !== "string") break;
      text = decoded;
    } catch {
      break;
    }
  }
  const wrapper = text.trim().match(/^(`{3,}|~{3,})(?:markdown|md)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*$/i);
  if (wrapper) text = wrapper[2];
  return text.replace(/\r\n?/g, "\n");
}

function isEscaped(text, index) {
  let slashes = 0;
  while (index > 0 && text[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

function readMath(source) {
  let open;
  let close;
  let display = false;
  if (source.startsWith("$$")) {
    open = close = "$$";
    display = true;
  } else if (source.startsWith("\\[")) {
    open = "\\[";
    close = "\\]";
    display = true;
  } else if (source.startsWith("\\(")) {
    open = "\\(";
    close = "\\)";
  } else if (source[0] === "$" && source[1] !== "$" && source[1] && !/\s/.test(source[1])) {
    open = close = "$";
  } else return null;

  const limit = Math.min(source.length, 20_000);
  for (let index = open.length; index < limit; index += 1) {
    if (open === "$" && source[index] === "\n") return null;
    if (!source.startsWith(close, index) || isEscaped(source, index)) continue;
    if (open === "$" && (/\s/.test(source[index - 1]) || /[\d$]/.test(source[index + 1] || ""))) continue;
    const text = source.slice(open.length, index);
    if (!text.trim()) return null;
    return { raw: source.slice(0, index + close.length), text, display };
  }
  return null;
}

// Marked 15 resolves emphasis before visiting nested inline tokens. Mask only
// math ranges in its lookahead so underscores in a formula cannot close prose
// emphasis. Normal code tokenization still owns code fences and inline code.
function maskMathForEmphasis(source, maskedSource) {
  const characters = maskedSource.split("");
  const offset = maskedSource.length - source.length;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "`") {
      const run = source.slice(index).match(/^`+/)[0];
      const end = source.indexOf(run, index + run.length);
      if (end >= 0) {
        index = end + run.length - 1;
        continue;
      }
    }
    if (isEscaped(source, index)) continue;
    const math = readMath(source.slice(index));
    if (!math) continue;
    for (let position = index; position < index + math.raw.length; position += 1) {
      characters[offset + position] = "a";
    }
    index += math.raw.length - 1;
  }
  return characters.join("");
}

function safeHref(href) {
  return /^(?:https?:\/\/|mailto:|#)/i.test(href || "") ? href : null;
}

function safeImageHref(href) {
  if (!/^https?:\/\//i.test(href || "")) return null;
  try {
    const url = new URL(href);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function mathHtml({ text, display }) {
  try {
    return katex.renderToString(text, {
      displayMode: display,
      output: "htmlAndMathml",
      throwOnError: false,
      strict: "ignore",
      trust: false,
      maxExpand: 500,
      maxSize: 20,
      errorColor: "#a94343",
    });
  } catch {
    return `<code class="message-math-error">${escapeHtml(text)}</code>`;
  }
}

/**
 * Render Markdown and math locally. In Node, pass a DOMPurify-backed
 * `sanitize(html, MESSAGE_SANITIZE_OPTIONS)` callback (e.g. from JSDOM).
 * With no DOM sanitizer available the safe fallback is escaped plain text.
 */
export function renderMessageHtml(value, options = {}) {
  const source = normalizeMessageText(value);
  const sanitize = options.sanitize || (typeof DOMPurify.sanitize === "function"
    ? (html, config) => DOMPurify.sanitize(html, config)
    : null);
  if (!sanitize) return `<p>${escapeHtml(source).replace(/\n/g, "<br>")}</p>`;

  // Raw model HTML is escaped by the renderer below. Therefore only our math
  // tokenizer can create an actual placeholder element, including when input
  // text spells a marker using HTML entities.
  const formulas = [];
  const mathRenderer = (token) => {
    const placeholder = `<span data-message-formula="${formulas.length}"></span>`;
    formulas.push(mathHtml(token));
    const tag = token.display ? "div" : "span";
    return `<${tag} class="message-math${token.display ? " message-math-display" : ""}">${placeholder}</${tag}>`;
  };

  const parser = new Marked({
    gfm: true,
    breaks: true,
    async: false,
    tokenizer: {
      emStrong(src, maskedSrc, prevChar) {
        if (!/^[*_]/.test(src)) return false;
        return Tokenizer.prototype.emStrong.call(this, src, maskMathForEmphasis(src, maskedSrc), prevChar);
      },
    },
    extensions: [
      {
        name: "messageMathBlock",
        level: "block",
        start(src) { return src.search(/(?:^|\n) {0,3}(?:\$\$|\\\[)/); },
        tokenizer(src) {
          const indentation = src.match(/^ {0,3}/)[0];
          const math = readMath(src.slice(indentation.length));
          if (!math?.display) return undefined;
          return { type: "messageMathBlock", ...math, raw: indentation + math.raw };
        },
        renderer: mathRenderer,
      },
      {
        name: "messageMathInline",
        level: "inline",
        start(src) { return src.search(/\$|\\[([]/); },
        tokenizer(src) {
          const math = readMath(src);
          return math ? { type: "messageMathInline", ...math } : undefined;
        },
        renderer: mathRenderer,
      },
    ],
    renderer: {
      html({ text }) { return escapeHtml(text); },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const url = safeHref(href);
        if (!url) return label;
        const anchor = (text) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer"${title ? ` title="${escapeHtml(title)}"` : ""}>${text}</a>`;
        // An image reference contains its own explicit controls. Keep a linked
        // image's outer destination separate instead of nesting interactive links.
        return tokens.some((token) => token.type === "image") ? `${label}${anchor("查看关联链接")}` : anchor(label);
      },
      image({ text, href }) {
        const label = escapeHtml(text || "未命名图片");
        const url = safeImageHref(href);
        if (!url) return `<span class="message-image-invalid">[图片：${label}，地址不受支持]</span>`;
        const load = url.startsWith("https:")
          ? '<button type="button" class="message-image-load" data-load-image="true">加载图片</button>'
          : '<span class="message-image-notice">HTTP 图片仅支持查看原图</span>';
        return `<span class="message-image-ref" data-image-ref="${escapeHtml(url)}" data-image-alt="${escapeHtml(text || "")}"><span class="message-image-label">图片引用</span><strong>${label}</strong><span class="message-image-url">${escapeHtml(url)}</span><span class="message-image-actions">${load}<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">查看原图</a></span><span class="message-image-status"></span><span class="message-image-preview"></span></span>`;
      },
      code({ text, lang }) {
        const requested = (lang || "").trim().split(/\s+/)[0];
        const language = /^[\w#+.-]{1,40}$/.test(requested) ? requested : "text";
        let code = escapeHtml(text);
        if (text.length < 100_000 && hljs.getLanguage(language)) {
          try {
            code = hljs.highlight(text, { language, ignoreIllegals: true }).value;
          } catch { /* Keep escaped code if a highlighter cannot parse it. */ }
        }
        return `<div class="message-code"><div class="message-code-header"><span>${escapeHtml(language)}</span><button type="button" class="message-code-copy" data-copy-code="true" aria-label="复制代码">复制代码</button></div><pre><code class="hljs language-${escapeHtml(language)}">${code}</code></pre></div>\n`;
      },
    },
  });

  try {
    const safeHtml = sanitize(parser.parse(source), MESSAGE_SANITIZE_OPTIONS);
    return String(safeHtml).replace(/<span data-message-formula="(\d+)"><\/span>/g, (_, index) => formulas[Number(index)] || "");
  } catch {
    return `<p>${escapeHtml(source).replace(/\n/g, "<br>")}</p>`;
  }
}
