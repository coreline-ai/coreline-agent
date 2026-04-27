/** FileEdit text matching, encoding preservation, and replacement safety helpers. */

// V8/Bun strings can approach ~1 GiB before hitting runtime limits. Keep the
// guard high enough for real source files while still preventing accidental
// multi-GB reads/OOMs.
export const MAX_EDIT_FILE_SIZE = 1024 * 1024 * 1024; // 1 GiB

export type EditableFileEncoding = "utf8" | "utf8-bom" | "utf16le-bom";

export interface DecodedEditableFile {
  content: string;
  encoding: EditableFileEncoding;
}

export type ApplyEditErrorReason = "empty_old_string" | "no_op" | "not_found" | "not_unique";

interface MatchCandidate {
  value: string;
  usedLineEndingNormalization: boolean;
}

export interface ActualStringMatch {
  start: number;
  end: number;
  actualString: string;
  candidate: string;
  usedQuoteNormalization: boolean;
  usedLineEndingNormalization: boolean;
}

export interface FindActualStringResult {
  count: number;
  matches: ActualStringMatch[];
  actualString?: string;
  usedQuoteNormalization: boolean;
  usedLineEndingNormalization: boolean;
}

export type ApplyEditResult =
  | {
      ok: true;
      content: string;
      replacements: number;
      match: FindActualStringResult;
    }
  | {
      ok: false;
      content: string;
      replacements: 0;
      reason: ApplyEditErrorReason;
      match?: FindActualStringResult;
    };

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);

const QUOTE_NORMALIZATION = new Map<string, string>([
  ["‘", "'"],
  ["’", "'"],
  ["‚", "'"],
  ["‛", "'"],
  ["“", "\""],
  ["”", "\""],
  ["„", "\""],
  ["‟", "\""],
]);

export function decodeEditableFileBuffer(buffer: Buffer): DecodedEditableFile {
  if (buffer.subarray(0, UTF16LE_BOM.length).equals(UTF16LE_BOM)) {
    return {
      content: buffer.subarray(UTF16LE_BOM.length).toString("utf16le"),
      encoding: "utf16le-bom",
    };
  }

  if (buffer.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
    return {
      content: buffer.subarray(UTF8_BOM.length).toString("utf8"),
      encoding: "utf8-bom",
    };
  }

  return {
    content: buffer.toString("utf8"),
    encoding: "utf8",
  };
}

export function encodeEditableFileContent(content: string, encoding: EditableFileEncoding): Buffer {
  if (encoding === "utf16le-bom") {
    return Buffer.concat([UTF16LE_BOM, Buffer.from(content, "utf16le")]);
  }

  if (encoding === "utf8-bom") {
    return Buffer.concat([UTF8_BOM, Buffer.from(content, "utf8")]);
  }

  return Buffer.from(content, "utf8");
}

export function containsNullByte(content: string): boolean {
  return content.includes("\0");
}

export function normalizeQuotes(value: string): string {
  return value.replace(/[‘’‚‛“”„‟]/gu, (char) => QUOTE_NORMALIZATION.get(char) ?? char);
}

export function preserveQuoteStyle(newString: string, oldString: string, actualString: string): string {
  const quoteSequences = collectActualQuoteSequences(oldString, actualString);
  const sequenceIndexes = { single: 0, double: 0 };

  return Array.from(newString, (char) => {
    if (char === "'" && quoteSequences.single.length > 0) {
      const replacement = quoteSequences.single[sequenceIndexes.single % quoteSequences.single.length] ?? char;
      sequenceIndexes.single += 1;
      return replacement;
    }

    if (char === "\"" && quoteSequences.double.length > 0) {
      const replacement = quoteSequences.double[sequenceIndexes.double % quoteSequences.double.length] ?? char;
      sequenceIndexes.double += 1;
      return replacement;
    }

    return char;
  }).join("");
}

export function findActualString(content: string, oldString: string): FindActualStringResult {
  if (oldString.length === 0) return emptyFindResult();

  const candidates = buildMatchCandidates(oldString, detectPreferredLineEnding(content));

  for (const candidate of candidates) {
    const matches = collectExactMatches(content, candidate);
    if (matches.length > 0) return toFindResult(matches);
  }

  const normalizedContent = normalizeQuotes(content);
  for (const candidate of candidates) {
    const matches = collectQuoteNormalizedMatches(content, normalizedContent, candidate);
    if (matches.length > 0) return toFindResult(matches);
  }

  return emptyFindResult();
}

export function applyEditToFile(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ApplyEditResult {
  if (oldString.length === 0) {
    return { ok: false, content, replacements: 0, reason: "empty_old_string" };
  }

  if (oldString === newString) {
    return { ok: false, content, replacements: 0, reason: "no_op" };
  }

  const match = findActualString(content, oldString);
  if (match.count === 0) {
    return { ok: false, content, replacements: 0, reason: "not_found", match };
  }

  if (match.count > 1 && !replaceAll) {
    return { ok: false, content, replacements: 0, reason: "not_unique", match };
  }

  const lineEnding = detectPreferredLineEnding(content);
  const replacementTemplate = normalizeLineEndings(newString, lineEnding);
  const replacements = replaceAll ? match.matches : match.matches.slice(0, 1);
  let nextContent = content;

  for (const replacementMatch of [...replacements].sort((a, b) => b.start - a.start)) {
    const replacement = replacementMatch.usedQuoteNormalization
      ? preserveQuoteStyle(replacementTemplate, replacementMatch.candidate, replacementMatch.actualString)
      : replacementTemplate;
    nextContent =
      nextContent.slice(0, replacementMatch.start) +
      replacement +
      nextContent.slice(replacementMatch.end);
  }

  if (nextContent === content) {
    return { ok: false, content, replacements: 0, reason: "no_op", match };
  }

  return {
    ok: true,
    content: nextContent,
    replacements: replacements.length,
    match,
  };
}

function buildMatchCandidates(oldString: string, targetLineEnding: "\n" | "\r\n"): MatchCandidate[] {
  const candidates: MatchCandidate[] = [
    { value: oldString, usedLineEndingNormalization: false },
  ];
  const lineEndingNormalized = normalizeLineEndings(oldString, targetLineEnding);
  if (lineEndingNormalized !== oldString) {
    candidates.push({ value: lineEndingNormalized, usedLineEndingNormalization: true });
  }
  return candidates;
}

function detectPreferredLineEnding(content: string): "\n" | "\r\n" {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(value: string, lineEnding: "\n" | "\r\n"): string {
  return value.replace(/\r\n|\r|\n/gu, lineEnding);
}

function collectExactMatches(content: string, candidate: MatchCandidate): ActualStringMatch[] {
  return collectMatchPositions(content, candidate.value).map((start) => ({
    start,
    end: start + candidate.value.length,
    actualString: content.slice(start, start + candidate.value.length),
    candidate: candidate.value,
    usedQuoteNormalization: false,
    usedLineEndingNormalization: candidate.usedLineEndingNormalization,
  }));
}

function collectQuoteNormalizedMatches(
  content: string,
  normalizedContent: string,
  candidate: MatchCandidate,
): ActualStringMatch[] {
  const normalizedNeedle = normalizeQuotes(candidate.value);
  return collectMatchPositions(normalizedContent, normalizedNeedle)
    .map((start) => {
      const actualString = content.slice(start, start + candidate.value.length);
      return {
        start,
        end: start + candidate.value.length,
        actualString,
        candidate: candidate.value,
        usedQuoteNormalization: true,
        usedLineEndingNormalization: candidate.usedLineEndingNormalization,
      };
    })
    .filter((match) => normalizeQuotes(match.actualString) === normalizedNeedle);
}

function collectMatchPositions(content: string, needle: string): number[] {
  if (needle.length === 0) return [];

  const positions: number[] = [];
  let index = 0;
  while ((index = content.indexOf(needle, index)) !== -1) {
    positions.push(index);
    index += needle.length;
  }
  return positions;
}

function toFindResult(matches: ActualStringMatch[]): FindActualStringResult {
  return {
    count: matches.length,
    matches,
    actualString: matches[0]?.actualString,
    usedQuoteNormalization: matches.some((match) => match.usedQuoteNormalization),
    usedLineEndingNormalization: matches.some((match) => match.usedLineEndingNormalization),
  };
}

function emptyFindResult(): FindActualStringResult {
  return {
    count: 0,
    matches: [],
    usedQuoteNormalization: false,
    usedLineEndingNormalization: false,
  };
}

function collectActualQuoteSequences(
  oldString: string,
  actualString: string,
): { single: string[]; double: string[] } {
  const normalizedOld = normalizeQuotes(oldString);
  const normalizedActual = normalizeQuotes(actualString);
  const single: string[] = [];
  const double: string[] = [];
  const length = Math.min(actualString.length, normalizedOld.length, normalizedActual.length);

  for (let index = 0; index < length; index += 1) {
    if (normalizedOld[index] !== normalizedActual[index]) continue;

    const actualChar = actualString[index];
    const normalizedChar = normalizedActual[index];
    if (!actualChar) continue;

    if (normalizedChar === "'") {
      single.push(actualChar);
    } else if (normalizedChar === "\"") {
      double.push(actualChar);
    }
  }

  return { single, double };
}
