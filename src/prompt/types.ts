export type AtFileIssueKind =
  | "missing"
  | "not_a_file"
  | "binary"
  | "too_large"
  | "glob_no_matches"
  | "duplicate";

export interface AtFileToken {
  token: string;
  rawPath: string;
  start: number;
  end: number;
  isGlob: boolean;
}

export interface AtFileAttachment {
  sourceToken: string;
  rawPath: string;
  resolvedPath: string;
  displayPath: string;
  byteLength: number;
  content: string;
}

export interface AtFileIssue {
  sourceToken: string;
  rawPath: string;
  kind: AtFileIssueKind;
  message: string;
  resolvedPath?: string;
}

export interface AtFileExpansionOptions {
  cwd?: string;
  maxBytesPerFile?: number;
}

export interface AtFileExpansionResult {
  text: string;
  attachments: AtFileAttachment[];
  issues: AtFileIssue[];
  tokens: AtFileToken[];
}

export interface PreparedPrompt {
  rawText: string;
  messageText: string;
  displayText: string;
  attachments: AtFileAttachment[];
  issues: AtFileIssue[];
  tokens: AtFileToken[];
}
