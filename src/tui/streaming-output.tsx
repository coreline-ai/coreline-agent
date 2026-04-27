/**
 * StreamingOutput — renders streamed text content progressively.
 */

import React from "react";
import { Box, Text } from "ink";

export interface StreamingOutputProps {
  text: string;
  isStreaming: boolean;
}

export type MarkdownInlineSegment =
  | { type: "text"; text: string }
  | { type: "strong"; text: string }
  | { type: "code"; text: string };

export type MarkdownBlock =
  | { type: "text"; segments: MarkdownInlineSegment[] }
  | { type: "blank" }
  | { type: "fence-start"; marker: string; language: string }
  | { type: "fence-end"; marker: string }
  | { type: "code"; text: string };

function isFenceLine(line: string): { marker: string; language: string } | null {
  const match = line.trim().match(/^(```|~~~)\s*([A-Za-z0-9_-]+)?\s*$/);
  if (!match) return null;
  return {
    marker: match[1],
    language: match[2] ?? "",
  };
}

export function parseInlineMarkdown(line: string): MarkdownInlineSegment[] {
  const segments: MarkdownInlineSegment[] = [];
  let buffer = "";
  let i = 0;

  const flushText = () => {
    if (buffer) {
      segments.push({ type: "text", text: buffer });
      buffer = "";
    }
  };

  while (i < line.length) {
    const char = line[i];

    if (char === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i + 1) {
        flushText();
        segments.push({ type: "code", text: line.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (char === "*" && line[i + 1] === "*") {
      const end = line.indexOf("**", i + 2);
      if (end > i + 2) {
        flushText();
        segments.push({ type: "strong", text: line.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    buffer += char;
    i += 1;
  }

  flushText();
  return segments;
}

export function parseMinimalMarkdown(text: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let inFence = false;
  let fenceMarker = "";

  for (const line of lines) {
    const fence = isFenceLine(line);

    if (!inFence && fence) {
      inFence = true;
      fenceMarker = fence.marker;
      blocks.push({ type: "fence-start", marker: fence.marker, language: fence.language });
      continue;
    }

    if (inFence && fence && fence.marker === fenceMarker) {
      inFence = false;
      fenceMarker = "";
      blocks.push({ type: "fence-end", marker: fence.marker });
      continue;
    }

    if (inFence) {
      blocks.push({ type: "code", text: line });
      continue;
    }

    if (line.trim().length === 0) {
      blocks.push({ type: "blank" });
      continue;
    }

    blocks.push({ type: "text", segments: parseInlineMarkdown(line) });
  }

  return blocks;
}

export function formatStreamingLines(text: string, maxLines = 12): {
  lines: string[];
  truncated: boolean;
} {
  const lines = text.length > 0 ? text.split("\n") : [];
  if (lines.length <= maxLines) {
    return { lines, truncated: false };
  }

  return {
    lines: lines.slice(-maxLines),
    truncated: true,
  };
}

function renderInlineSegment(segment: MarkdownInlineSegment, key: string): React.ReactNode {
  if (segment.type === "strong") {
    return (
      <Text key={key} bold>
        {segment.text}
      </Text>
    );
  }

  if (segment.type === "code") {
    return (
      <Text key={key} color="cyan">
        {segment.text}
      </Text>
    );
  }

  return segment.text;
}

export function renderMinimalMarkdown(text: string, isStreaming = false): React.ReactNode[] {
  const blocks = parseMinimalMarkdown(text);
  const nodes = blocks.map((block, index) => {
    if (block.type === "text") {
      return (
        <Text key={index}>
          {block.segments.map((segment, i) => renderInlineSegment(segment, `${index}-${i}`))}
          {isStreaming && index === blocks.length - 1 ? <Text color="gray">▊</Text> : null}
        </Text>
      );
    }

    if (block.type === "code") {
      return (
        <Text key={index} color="cyan">
          {block.text}
          {isStreaming && index === blocks.length - 1 ? <Text color="gray">▊</Text> : null}
        </Text>
      );
    }

    if (block.type === "fence-start") {
      const label = block.language ? `${block.marker} ${block.language}` : block.marker;
      return <Text key={index} dimColor>{label}</Text>;
    }

    if (block.type === "fence-end") {
      return <Text key={index} dimColor>{block.marker}</Text>;
    }

    return <Text key={index}>{" "}</Text>;
  });

  if (isStreaming && nodes.length === 0) {
    return [<Text key="cursor" color="gray">▊</Text>];
  }

  return nodes;
}

export function StreamingOutput({ text, isStreaming }: StreamingOutputProps) {
  if (!text && !isStreaming) return null;

  const rendered = renderMinimalMarkdown(text, isStreaming);

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      borderStyle="single"
      borderColor="gray"
      marginY={0}
      >
      <Box gap={1}>
        <Text color="green" bold>Streaming</Text>
        {isStreaming && <Text color="yellow">●</Text>}
      </Box>
      <Box flexDirection="column">
        {rendered.length > 0 ? rendered : (
          <Text dimColor>
            {isStreaming ? "Generating…" : ""}
            {isStreaming ? <Text color="gray">▊</Text> : null}
          </Text>
        )}
      </Box>
    </Box>
  );
}
