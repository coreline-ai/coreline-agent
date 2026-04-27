import type { ChatMessage, ContentBlock } from "../agent/types.js";

export interface OpenAIStyleToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface OpenAIStyleMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: OpenAIStyleToolCall[];
  tool_call_id?: string;
}

function contentBlocksToText(blocks: ContentBlock[]): string {
  return blocks
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function pushUserContent(result: OpenAIStyleMessage[], content: string | ContentBlock[]): void {
  if (typeof content === "string") {
    result.push({ role: "user", content });
    return;
  }

  const textBuffer: string[] = [];
  const flushText = () => {
    if (textBuffer.length > 0) {
      result.push({ role: "user", content: textBuffer.join("") });
      textBuffer.length = 0;
    }
  };

  for (const block of content) {
    if (block.type === "text") {
      textBuffer.push(block.text);
      continue;
    }

    if (block.type === "tool_result") {
      flushText();
      result.push({
        role: "tool",
        tool_call_id: block.toolUseId,
        content: block.content,
      });
    }
  }

  flushText();
}

export function convertMessagesToOpenAIStyle(messages: ChatMessage[]): OpenAIStyleMessage[] {
  const result: OpenAIStyleMessage[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      result.push({ role: "system", content: msg.content });
      continue;
    }

    if (msg.role === "user") {
      pushUserContent(result, msg.content);
      continue;
    }

    const text = contentBlocksToText(msg.content);
    const toolUseParts = msg.content.filter((block) => block.type === "tool_use");
    const assistantMsg: OpenAIStyleMessage = {
      role: "assistant",
      content: text || null,
    };

    if (toolUseParts.length > 0) {
      assistantMsg.tool_calls = toolUseParts.map((block) => ({
        id: block.id,
        type: "function" as const,
        function: { name: block.name, arguments: JSON.stringify(block.input) },
      }));
    }

    result.push(assistantMsg);

    for (const block of msg.content) {
      if (block.type === "tool_result") {
        result.push({
          role: "tool",
          tool_call_id: block.toolUseId,
          content: block.content,
        });
      }
    }
  }

  return result;
}
