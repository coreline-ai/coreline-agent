import { expandAtFilePrompt } from "./at-file.js";
import type { AtFileAttachment, AtFileExpansionOptions, AtFileIssue, PreparedPrompt } from "./types.js";

const ATTACHED_FILES_START = "<coreline-attached-files>";
const ATTACHED_FILES_END = "</coreline-attached-files>";
const FILE_HEADER_RE = /^--- FILE: (.+?) \((\d+) bytes\) ---$/gm;

function normalizeDisplayText(text: string): string {
  return text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

function renderAttachmentSection(attachments: AtFileAttachment[]): string {
  if (attachments.length === 0) {
    return "";
  }

  const blocks = attachments.map((attachment) =>
    [
      `--- FILE: ${attachment.displayPath} (${attachment.byteLength} bytes) ---`,
      `\`\`\`${attachment.displayPath}`,
      attachment.content,
      "```",
    ].join("\n"),
  );

  return [ATTACHED_FILES_START, ...blocks, ATTACHED_FILES_END].join("\n\n");
}

export function renderPromptWithAttachments(text: string, attachments: AtFileAttachment[]): string {
  const trimmedText = text.trim();
  const attachmentSection = renderAttachmentSection(attachments);

  if (!attachmentSection) {
    return trimmedText;
  }

  if (!trimmedText) {
    return attachmentSection;
  }

  return `${trimmedText}\n\n${attachmentSection}`;
}

export function summarizePromptForDisplay(messageText: string): string {
  const startIndex = messageText.indexOf(ATTACHED_FILES_START);
  const endIndex = messageText.indexOf(ATTACHED_FILES_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return normalizeDisplayText(messageText);
  }

  const visibleText = normalizeDisplayText(messageText.slice(0, startIndex));
  const attachmentBlock = messageText.slice(startIndex, endIndex + ATTACHED_FILES_END.length);
  const attachmentNames = Array.from(attachmentBlock.matchAll(FILE_HEADER_RE)).map((match) => match[1] ?? "").filter(Boolean);

  if (attachmentNames.length === 0) {
    return visibleText;
  }

  if (!visibleText) {
    return `[Attached: ${attachmentNames.join(", ")}]`;
  }

  return `${visibleText}\n[Attached: ${attachmentNames.join(", ")}]`;
}

export function formatAtFileIssues(issues: AtFileIssue[], maxIssues = 5): string {
  if (issues.length === 0) {
    return "";
  }

  const visibleIssues = issues.slice(0, maxIssues).map((issue) => `- ${issue.message}`);
  const remaining = issues.length - visibleIssues.length;
  if (remaining > 0) {
    visibleIssues.push(`- ${remaining} more attachment issue(s)`);
  }

  return ["Attachment issues:", ...visibleIssues].join("\n");
}

export function prepareUserPrompt(rawText: string, options: AtFileExpansionOptions = {}): PreparedPrompt {
  const expansion = expandAtFilePrompt(rawText, options);
  const messageText = renderPromptWithAttachments(expansion.text, expansion.attachments);
  const displayText = summarizePromptForDisplay(messageText);

  return {
    rawText,
    messageText,
    displayText,
    attachments: expansion.attachments,
    issues: expansion.issues,
    tokens: expansion.tokens,
  };
}

export const atFilePromptMarkers = {
  start: ATTACHED_FILES_START,
  end: ATTACHED_FILES_END,
};
