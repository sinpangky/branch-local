// Provider-reported usage only. Never estimate tokens or infer cache hits from prompt length.
function own(object, key) {
  if (!object || typeof object !== "object" || Array.isArray(object)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, "value") ? descriptor.value : undefined;
}

function has(object, key) {
  return Boolean(object && typeof object === "object" && !Array.isArray(object) && Object.hasOwn(object, key));
}

const tokenCount = (value) => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/**
 * Accept a full completion payload, its usage object, or our normalised usage.
 * Unknown/malformed totals are omitted; an unreported cache count remains null,
 * which is distinct from an explicit upstream report of zero cached tokens.
 */
export function normalizeUsage(source) {
  try {
    const usage = has(source, "usage") ? own(source, "usage") : source;
    let inputTokens;
    let outputTokens;
    let cached;
    if (has(usage, "inputTokens") || has(usage, "outputTokens")) {
      inputTokens = own(usage, "inputTokens");
      outputTokens = own(usage, "outputTokens");
      cached = own(usage, "cachedInputTokens");
    } else if (has(usage, "prompt_tokens") || has(usage, "completion_tokens")) {
      inputTokens = own(usage, "prompt_tokens");
      outputTokens = own(usage, "completion_tokens");
      cached = own(own(usage, "prompt_tokens_details"), "cached_tokens");
    } else {
      inputTokens = own(usage, "input_tokens");
      outputTokens = own(usage, "output_tokens");
      cached = own(own(usage, "input_tokens_details"), "cached_tokens");
    }
    if (!tokenCount(inputTokens) || !tokenCount(outputTokens)) return null;
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens: tokenCount(cached) && cached <= inputTokens ? cached : null,
    };
  } catch {
    // Optional accounting must not make a valid model answer fail to render.
    return null;
  }
}
