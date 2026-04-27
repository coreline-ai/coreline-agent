export interface DiffPreviewOptions {
  maxLines?: number;
}

export interface DiffSummary {
  filePath?: string;
  added: number;
  removed: number;
  changed: boolean;
  truncated: boolean;
  omittedLines: number;
  text: string;
}

export interface DiffPreview {
  filePath: string;
  diff: string;
  added: number;
  removed: number;
  changed: boolean;
  truncated: boolean;
  omittedLines: number;
}

const DEFAULT_MAX_DIFF_LINES = 50;

type DiffLine =
  | { type: "context"; value: string }
  | { type: "add"; value: string }
  | { type: "delete"; value: string };

export function generateUnifiedDiff(
  oldContent: string,
  newContent: string,
  filePath: string,
  options: DiffPreviewOptions = {},
): DiffPreview {
  if (oldContent === newContent) {
    return {
      filePath,
      diff: "",
      added: 0,
      removed: 0,
      changed: false,
      truncated: false,
      omittedLines: 0,
    };
  }

  const oldLines = splitLines(oldContent);
  const newLines = splitLines(newContent);
  const diffLines = buildLineDiff(oldLines, newLines);
  const added = diffLines.filter((line) => line.type === "add").length;
  const removed = diffLines.filter((line) => line.type === "delete").length;

  const renderedLines = [
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...diffLines.map(formatDiffLine),
  ];

  const maxLines = Math.max(0, options.maxLines ?? DEFAULT_MAX_DIFF_LINES);
  const omittedLines = Math.max(0, renderedLines.length - maxLines);
  const truncated = omittedLines > 0;
  const visibleLines = truncated
    ? [...renderedLines.slice(0, maxLines), `... (${omittedLines} more lines)`]
    : renderedLines;

  return {
    filePath,
    diff: visibleLines.join("\n"),
    added,
    removed,
    changed: true,
    truncated,
    omittedLines,
  };
}

export function formatDiffSummary(
  input:
    | string
    | DiffPreview
    | {
        oldContent: string;
        newContent: string;
        filePath?: string;
        options?: DiffPreviewOptions;
      },
): DiffSummary {
  const preview =
    typeof input === "string"
      ? parseDiffString(input)
      : "oldContent" in input
        ? generateUnifiedDiff(input.oldContent, input.newContent, input.filePath ?? "file", input.options)
        : input;

  const text = preview.changed
    ? `${preview.filePath ? `${preview.filePath}: ` : ""}+${preview.added} -${preview.removed}${
        preview.truncated ? ` (truncated, ${preview.omittedLines} lines omitted)` : ""
      }`
    : `${preview.filePath ? `${preview.filePath}: ` : ""}No changes`;

  return {
    filePath: preview.filePath,
    added: preview.added,
    removed: preview.removed,
    changed: preview.changed,
    truncated: preview.truncated,
    omittedLines: preview.omittedLines,
    text,
  };
}

function splitLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

function buildLineDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  const table = buildLcsTable(oldLines, newLines);
  const result: DiffLine[] = [];
  let oldIndex = 0;
  let newIndex = 0;

  while (oldIndex < oldLines.length && newIndex < newLines.length) {
    if (oldLines[oldIndex] === newLines[newIndex]) {
      result.push({ type: "context", value: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
      newIndex += 1;
      continue;
    }

    if (table[oldIndex + 1]?.[newIndex] >= table[oldIndex]?.[newIndex + 1]) {
      result.push({ type: "delete", value: oldLines[oldIndex] ?? "" });
      oldIndex += 1;
    } else {
      result.push({ type: "add", value: newLines[newIndex] ?? "" });
      newIndex += 1;
    }
  }

  while (oldIndex < oldLines.length) {
    result.push({ type: "delete", value: oldLines[oldIndex] ?? "" });
    oldIndex += 1;
  }

  while (newIndex < newLines.length) {
    result.push({ type: "add", value: newLines[newIndex] ?? "" });
    newIndex += 1;
  }

  return result;
}

function buildLcsTable(oldLines: string[], newLines: string[]): number[][] {
  const table = Array.from({ length: oldLines.length + 1 }, () =>
    Array.from({ length: newLines.length + 1 }, () => 0),
  );

  for (let oldIndex = oldLines.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newLines.length - 1; newIndex >= 0; newIndex -= 1) {
      table[oldIndex][newIndex] =
        oldLines[oldIndex] === newLines[newIndex]
          ? 1 + (table[oldIndex + 1]?.[newIndex + 1] ?? 0)
          : Math.max(table[oldIndex + 1]?.[newIndex] ?? 0, table[oldIndex]?.[newIndex + 1] ?? 0);
    }
  }

  return table;
}

function formatDiffLine(line: DiffLine): string {
  if (line.type === "add") {
    return `+${line.value}`;
  }
  if (line.type === "delete") {
    return `-${line.value}`;
  }
  return ` ${line.value}`;
}

function parseDiffString(diff: string): DiffPreview {
  if (diff.trim().length === 0) {
    return {
      filePath: undefinedFilePath(),
      diff,
      added: 0,
      removed: 0,
      changed: false,
      truncated: false,
      omittedLines: 0,
    };
  }

  const lines = diff.split(/\r?\n/);
  const filePath = lines.find((line) => line.startsWith("+++ b/"))?.slice("+++ b/".length);
  const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
  const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
  const omittedLine = lines.find((line) => /^\.\.\. \(\d+ more lines\)$/.test(line));
  const omittedLines = omittedLine ? Number(omittedLine.match(/\d+/)?.[0] ?? 0) : 0;

  return {
    filePath: filePath ?? undefinedFilePath(),
    diff,
    added,
    removed,
    changed: added > 0 || removed > 0,
    truncated: omittedLines > 0,
    omittedLines,
  };
}

function undefinedFilePath(): string {
  return "";
}
