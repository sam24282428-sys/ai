function mapGeminiMessageToRuntimeEvent(message) {
  const type = message?.type;
  switch (type) {
    case "context.updated":
      return {
        type: "runtime.context.updated",
        payload: normalizeGeminiContextPayload(message),
      };
    case "turn.started":
      return {
        type: "runtime.turn.started",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
        },
      };
    case "reply.completed":
      return {
        type: "runtime.reply.completed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          itemId: `item-${message.turnId}`,
          text: message.text,
        },
      };
    case "turn.completed":
      return {
        type: "runtime.turn.completed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          text: typeof message.text === "string" ? message.text : "",
        },
      };
    case "turn.failed":
      return {
        type: "runtime.turn.failed",
        payload: {
          threadId: message.sessionId,
          turnId: message.turnId,
          text: message.error || "❌ Gemini client execution failed",
        },
      };
    default:
      return null;
  }
}

function normalizeGeminiContextPayload(message) {
  const usage = message?.usage && typeof message.usage === "object" ? message.usage : {};
  const inputTokens = numberOrZero(usage.input_tokens);
  const cacheReadInputTokens = numberOrZero(usage.cache_read_tokens);
  const outputTokens = numberOrZero(usage.output_tokens);
  const thinkingTokens = numberOrZero(usage.thinking_tokens);
  const totalTokens = numberOrZero(usage.total_tokens) || (inputTokens + cacheReadInputTokens + outputTokens + thinkingTokens);
  return {
    runtimeId: "gemini",
    threadId: normalizeString(message?.sessionId),
    inputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens,
    outputTokens,
    currentTokens: totalTokens,
  };
}

function normalizeString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function numberOrZero(value) {
  return Number.isFinite(Number(value)) ? Number(value) : 0;
}

module.exports = {
  mapGeminiMessageToRuntimeEvent,
};
