/**
 * Config diagnostics — load status, issues, and provenance snapshots.
 */

export type ConfigLoadStatus = "loaded" | "missing" | "invalid";

export type ConfigLoadIssueKind = "missing-file" | "parse-error" | "schema-error";

export interface ConfigLoadIssue {
  kind: ConfigLoadIssueKind;
  message: string;
  detail?: string;
  path?: string;
}

export interface ConfigLoadSnapshot<T> {
  filePath: string;
  status: ConfigLoadStatus;
  config: T;
  issue?: ConfigLoadIssue;
  sourcePath?: string;
}

