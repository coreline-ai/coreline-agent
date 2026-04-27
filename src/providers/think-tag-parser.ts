/**
 * Streaming parser for <think>...</think> and <thinking>...</thinking> tags.
 *
 * Many local reasoning models (DeepSeek-R1, QwQ, etc.) emit their reasoning
 * process wrapped in <think> tags. This parser splits the stream into
 * "reasoning" and "text" channels in real time.
 */

const OPEN_TAGS = ["<think>", "<thinking>"];
const CLOSE_TAGS = ["</think>", "</thinking>"];
const MAX_TAG_LEN = Math.max(...OPEN_TAGS.map((t) => t.length), ...CLOSE_TAGS.map((t) => t.length));

export type ThinkEmit =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string };

/**
 * Streaming parser — feed chunks of text, get back segmented emits.
 *
 * Usage:
 *   const parser = new ThinkTagParser();
 *   for (const delta of stream) {
 *     for (const emit of parser.feed(delta)) {
 *       if (emit.type === "reasoning") yield { type: "reasoning_delta", ... };
 *       else yield { type: "text_delta", ... };
 *     }
 *   }
 *   for (const emit of parser.flush()) { ... }
 */
export class ThinkTagParser {
  private buffer = "";
  private inThinkBlock = false;

  feed(chunk: string): ThinkEmit[] {
    this.buffer += chunk;
    return this.drain(false);
  }

  flush(): ThinkEmit[] {
    return this.drain(true);
  }

  private drain(isFinal: boolean): ThinkEmit[] {
    const emits: ThinkEmit[] = [];

    while (this.buffer.length > 0) {
      if (this.inThinkBlock) {
        // Look for closing tag
        const closeIdx = this.findTag(this.buffer, CLOSE_TAGS);
        if (closeIdx === -1) {
          // No close tag found yet — emit what we can keep (save last N chars in case tag is split)
          const keep = isFinal ? 0 : MAX_TAG_LEN;
          if (this.buffer.length > keep) {
            const emit = this.buffer.slice(0, this.buffer.length - keep);
            if (emit) emits.push({ type: "reasoning", text: emit });
            this.buffer = this.buffer.slice(this.buffer.length - keep);
          }
          break;
        }
        // Emit reasoning content before the tag
        const before = this.buffer.slice(0, closeIdx.index);
        if (before) emits.push({ type: "reasoning", text: before });
        // Consume the tag
        this.buffer = this.buffer.slice(closeIdx.index + closeIdx.tagLen);
        this.inThinkBlock = false;
      } else {
        // Look for opening tag
        const openIdx = this.findTag(this.buffer, OPEN_TAGS);
        if (openIdx === -1) {
          const keep = isFinal ? 0 : MAX_TAG_LEN;
          if (this.buffer.length > keep) {
            const emit = this.buffer.slice(0, this.buffer.length - keep);
            if (emit) emits.push({ type: "text", text: emit });
            this.buffer = this.buffer.slice(this.buffer.length - keep);
          }
          break;
        }
        // Emit text before the tag
        const before = this.buffer.slice(0, openIdx.index);
        if (before) emits.push({ type: "text", text: before });
        // Consume the tag
        this.buffer = this.buffer.slice(openIdx.index + openIdx.tagLen);
        this.inThinkBlock = true;
      }
    }

    return emits;
  }

  private findTag(text: string, tags: string[]): { index: number; tagLen: number } | -1 {
    let best: { index: number; tagLen: number } | null = null;
    for (const tag of tags) {
      const idx = text.indexOf(tag);
      if (idx !== -1 && (best === null || idx < best.index)) {
        best = { index: idx, tagLen: tag.length };
      }
    }
    return best ?? -1;
  }
}
