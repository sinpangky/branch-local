const compact = (value) => String(value || '').replace(/\s/g, '');
const excluded = 'button,.katex-mathml,script,style,.message-block-tools';
const activeFocus = new WeakMap();

function textMap(root) {
  const walker = root.ownerDocument.createTreeWalker(root, 4);
  const positions = [];
  let value = '', node;
  while ((node = walker.nextNode())) {
    if (node.parentElement?.closest(excluded)) continue;
    for (let offset = 0; offset < node.nodeValue.length; offset++) {
      const character = node.nodeValue[offset];
      if (/\s/.test(character)) continue;
      value += character;
      positions.push({ node, offset });
    }
  }
  return { value, positions };
}

function occurrences(text, quote) {
  const indexes = [];
  if (!quote) return indexes;
  for (let at = text.indexOf(quote); at !== -1; at = text.indexOf(quote, at + 1)) indexes.push(at);
  return indexes;
}

/** Record which repeated visible phrase was selected, across inline formatting. */
export function captureTextAnchor(container, range, quote) {
  const prefix = container.ownerDocument.createRange();
  prefix.selectNodeContents(container);
  prefix.setEnd(range.startContainer, range.startOffset);
  const fragment = prefix.cloneContents();
  fragment.querySelectorAll(excluded).forEach((el) => el.remove());
  const start = compact(fragment.textContent).length;
  const indexes = occurrences(textMap(container).value, compact(quote));
  const occurrence = Math.max(0, indexes.findIndex((index) => index >= start));
  return { kind:'text', occurrence };
}

export function findAnchorRange(container, quote, occurrence = 0) {
  const text = textMap(container), needle = compact(quote);
  const at = occurrences(text.value, needle)[occurrence];
  if (at === undefined || !needle || !text.positions[at + needle.length - 1]) return null;
  const first = text.positions[at], last = text.positions[at + needle.length - 1];
  const range = container.ownerDocument.createRange();
  range.setStart(first.node, first.offset);
  range.setEnd(last.node, last.offset + 1);
  return range;
}

/** Highlight only verified, currently rendered content; never guess a different message. */
export function focusRenderedAnchor(message, { quote = '', anchor = {} } = {}, { reduceMotion = false } = {}) {
  activeFocus.get(message.ownerDocument)?.();
  const content = message.querySelector('.message-content') || message;
  let target = message, range = null, precise = false;
  const kind = anchor.kind || (quote ? 'text' : 'after');
  if (kind === 'table') {
    target = content.querySelectorAll('table')[anchor.blockIndex ?? 0];
    precise = Boolean(target);
  } else if (kind === 'image') {
    const images = [...content.querySelectorAll('[data-image-ref]')];
    target = images[anchor.blockIndex ?? 0];
    if (target && anchor.imageUrl && target.getAttribute('data-image-ref') !== anchor.imageUrl) target = null;
    precise = Boolean(target);
  } else if (kind === 'text') {
    range = findAnchorRange(content, quote, anchor.occurrence ?? 0);
    precise = Boolean(range);
    target = range?.startContainer.parentElement || message;
  } else {
    target = message.querySelector('.message-branch-links') || message.querySelector('.branch-action') || message;
    precise = true;
  }
  const scope = message.ownerDocument.defaultView;
  if (range && scope.CSS?.highlights && scope.Highlight) scope.CSS.highlights.set('branch-origin', new scope.Highlight(range));
  (target || message).scrollIntoView?.({ block:'center', behavior:reduceMotion ? 'instant' : 'smooth' });
  (target || message).classList.add('branch-anchor-focus');
  const clear = () => {
    scope.clearTimeout(timer);
    if (activeFocus.get(message.ownerDocument) !== clear) return;
    scope.CSS?.highlights?.delete('branch-origin');
    (target || message).classList.remove('branch-anchor-focus');
    activeFocus.delete(message.ownerDocument);
  };
  const timer = scope.setTimeout(clear, 3500);
  activeFocus.set(message.ownerDocument, clear);
  return { precise, clear };
}
