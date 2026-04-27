/**
 * Wave 7 Phase 4 — IngestDocument tool tests.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { IngestDocumentTool } from "../src/tools/ingest-document/ingest-document-tool.js";
import { ProjectMemory } from "../src/memory/project-memory.js";
import type { ToolUseContext } from "../src/tools/types.js";

function mkRoot(): string {
  return mkdtempSync(join(tmpdir(), "ingest-doc-"));
}

function makeContext(overrides?: Partial<ToolUseContext>): ToolUseContext {
  return {
    cwd: process.cwd(),
    abortSignal: new AbortController().signal,
    nonInteractive: true,
    ...overrides,
  };
}

describe("Wave 7 Phase 4 — IngestDocumentTool", () => {
  test("TC-4.11: contentText path — creates parent + chunk entries", async () => {
    const root = mkRoot();
    const cwd = mkdtempSync(join(tmpdir(), "ingest-cwd-"));
    try {
      const mem = new ProjectMemory(cwd, { rootDir: root });
      const ctx = makeContext({ cwd, projectMemory: mem });
      const text = Array.from({ length: 20 }, (_, i) => `t${i}`).join(" ");

      const result = await IngestDocumentTool.call(
        {
          docId: "txt-doc",
          contentText: text,
          chunkSize: 5,
          chunkOverlap: 1,
        },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.data.docId).toBe("txt-doc");
      expect(result.data.parentTracked).toBe(true);
      // step=4 → ceil((20-5)/4)+1 = ceil(15/4)+1 = 4+1 = 5 chunks
      expect(result.data.chunksCreated).toBeGreaterThanOrEqual(4);
      expect(result.data.failures).toEqual([]);
      expect(mem.readEntry("txt-doc")).not.toBeNull();
      expect(mem.readEntry("txt-doc__c0")).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TC-4.12: contentPath path — reads file under cwd and ingests", async () => {
    const root = mkRoot();
    const cwd = mkdtempSync(join(tmpdir(), "ingest-cwd-"));
    try {
      const mem = new ProjectMemory(cwd, { rootDir: root });
      const ctx = makeContext({ cwd, projectMemory: mem });

      const filePath = join(cwd, "input.txt");
      writeFileSync(
        filePath,
        Array.from({ length: 10 }, (_, i) => `w${i}`).join(" "),
        "utf-8",
      );

      const result = await IngestDocumentTool.call(
        {
          docId: "file-doc",
          contentPath: "input.txt",
          chunkSize: 4,
          chunkOverlap: 0,
        },
        ctx,
      );

      expect(result.isError).toBeFalsy();
      expect(result.data.parentTracked).toBe(true);
      // 10 words / 4 → 3 chunks (4+4+2)
      expect(result.data.chunksCreated).toBe(3);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TC-4.13: contentPath outside cwd → permission denied", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ingest-cwd-"));
    try {
      const ctx = makeContext({ cwd });
      const perm = IngestDocumentTool.checkPermissions(
        { docId: "x", contentPath: "/etc/passwd" },
        ctx,
      );
      expect(perm.behavior).toBe("deny");
      expect(perm.reason).toBeDefined();
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TC-4.13b: contentPath inside cwd → allowed", () => {
    const cwd = mkdtempSync(join(tmpdir(), "ingest-cwd-"));
    try {
      const ctx = makeContext({ cwd });
      const perm = IngestDocumentTool.checkPermissions(
        { docId: "x", contentPath: "subdir/file.txt" },
        ctx,
      );
      expect(perm.behavior).toBe("allow");
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TC-4.14: formatResult emits INGEST_DOCUMENT_RESULT block", () => {
    const formatted = IngestDocumentTool.formatResult(
      {
        docId: "abc",
        chunksCreated: 4,
        parentTracked: true,
        failures: [],
      },
      "tu-1",
    );
    expect(formatted).toContain("INGEST_DOCUMENT_RESULT");
    expect(formatted).toContain("doc_id: abc");
    expect(formatted).toContain("chunks_created: 4");
    expect(formatted).toContain("parent_tracked: true");
    expect(formatted).toContain("failures: 0");
  });

  test("TC-4.14b: formatResult includes failure lines (capped at 5)", () => {
    const formatted = IngestDocumentTool.formatResult(
      {
        docId: "fail",
        chunksCreated: 1,
        parentTracked: true,
        failures: Array.from({ length: 7 }, (_, i) => ({
          chunkIdx: i,
          error: `boom${i}`,
        })),
      },
      "tu-2",
    );
    expect(formatted).toContain("FAILURES");
    expect(formatted).toContain("chunk 0: boom0");
    expect(formatted).toContain("chunk 4: boom4");
    expect(formatted).not.toContain("chunk 5: boom5");
  });

  test("TC-4.15: missing both contentText and contentPath → error", async () => {
    const root = mkRoot();
    const cwd = mkdtempSync(join(tmpdir(), "ingest-cwd-"));
    try {
      const mem = new ProjectMemory(cwd, { rootDir: root });
      const ctx = makeContext({ cwd, projectMemory: mem });
      const result = await IngestDocumentTool.call(
        { docId: "empty" },
        ctx,
      );
      expect(result.isError).toBe(true);
      expect(result.data.failures.length).toBeGreaterThan(0);
      expect(result.data.failures[0]!.error).toMatch(/contentPath or contentText/);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("TC-4.15b: missing projectMemory in context → error", async () => {
    const ctx = makeContext({ projectMemory: undefined });
    const result = await IngestDocumentTool.call(
      { docId: "no-mem", contentText: "hello" },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.data.failures[0]!.error).toMatch(/Project memory/);
  });
});
