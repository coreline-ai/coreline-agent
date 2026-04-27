/**
 * Phase 4 — filesystem permission hardening.
 */

import { afterEach, describe, test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionEngine } from "../src/permissions/engine.js";
import {
  DANGEROUS_DIRECTORIES,
  PROTECTED_DANGEROUS_FILES,
  checkFilesystemPathHardening,
  checkFilesystemWritePathHardening,
} from "../src/permissions/filesystem-hardening.js";
import type { PermissionCheckContext } from "../src/permissions/types.js";

const tempDirs: string[] = [];

function tempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "coreline-fs-hardening-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeCtx(rules: PermissionCheckContext["rules"] = []): PermissionCheckContext {
  return { cwd: "/tmp", mode: "default", rules };
}

describe("Filesystem hardening: path classifier", () => {
  test("denies protected dangerous files with case-insensitive segment matching", () => {
    for (const fileName of PROTECTED_DANGEROUS_FILES) {
      const upperCasePath = `/tmp/project/${fileName.toUpperCase()}`;
      const result = checkFilesystemPathHardening(upperCasePath);

      expect(result.allowed, upperCasePath).toBe(false);
      expect(result.violation?.kind).toBe("protected-path");
    }
  });

  test("denies dangerous directories with case-insensitive segment matching", () => {
    for (const dirName of DANGEROUS_DIRECTORIES) {
      const upperCasePath = `/tmp/project/${dirName.toUpperCase()}/settings.json`;
      const result = checkFilesystemPathHardening(upperCasePath);

      expect(result.allowed, upperCasePath).toBe(false);
      expect(result.violation?.kind).toBe("protected-path");
    }
  });

  test("uses segment matching instead of substring matching", () => {
    expect(checkFilesystemPathHardening("/tmp/project/.gitignore").allowed).toBe(true);
    expect(checkFilesystemPathHardening("/tmp/project/safe.git/config").allowed).toBe(true);
    expect(checkFilesystemPathHardening("/tmp/project/.claude-notes/settings.json").allowed).toBe(true);
  });

  test("denies suspicious path syntax", () => {
    const suspiciousPaths = [
      "\\\\server\\share\\file.txt",
      "//server/share/file.txt",
      "\\\\?\\C:\\repo\\file.txt",
      "//?/C:/repo/file.txt",
      "\\\\.\\C:\\repo\\file.txt",
      "//./C:/repo/file.txt",
      "/tmp/PROGRA~1/file.txt",
      "/tmp/file.",
      "/tmp/file ",
      "/tmp/CON",
      "/tmp/prn.txt",
      "/tmp/com1.log",
      "/tmp/lpt9",
      "/tmp/.../file.txt",
    ];

    for (const path of suspiciousPaths) {
      const result = checkFilesystemPathHardening(path);

      expect(result.allowed, path).toBe(false);
      expect(result.violation?.kind).toBe("suspicious-path");
    }
  });

  test("denies symlink targets whose realpath resolves to a protected path", () => {
    const cwd = tempProject();
    const gitDir = join(cwd, ".git");
    const protectedConfig = join(gitDir, "config");
    const safeLink = join(cwd, "safe-config-link");
    mkdirSync(gitDir);
    writeFileSync(protectedConfig, "[core]\n", "utf8");
    symlinkSync(protectedConfig, safeLink);

    const result = checkFilesystemWritePathHardening(safeLink, cwd);

    expect(result.allowed).toBe(false);
    expect(result.violation?.kind).toBe("protected-path");
    expect(result.violation?.reason).toContain("realpath");
    expect(result.violation?.realPath).toBe(realpathSync(protectedConfig));
  });

  test("denies parent directory symlink traversal into protected paths", () => {
    const cwd = tempProject();
    const gitDir = join(cwd, ".git");
    const linkDir = join(cwd, "safe-dir-link");
    mkdirSync(gitDir);
    symlinkSync(gitDir, linkDir, "dir");

    const result = checkFilesystemWritePathHardening(join(linkDir, "config"), cwd);

    expect(result.allowed).toBe(false);
    expect(result.violation?.kind).toBe("protected-path");
    expect(result.violation?.realPath).toBe(realpathSync(gitDir));
  });
});

describe("PermissionEngine: filesystem hardening", () => {
  const engine = new PermissionEngine();

  test("denies FileWrite to protected dangerous files in default mode", () => {
    const result = engine.check("FileWrite", { file_path: "/tmp/project/.gitconfig" }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("Filesystem hardening");
  });

  test("denies FileEdit under dangerous directories in default mode", () => {
    const result = engine.check("FileEdit", { file_path: "/tmp/project/.Git/config" }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("Protected directory segment");
  });

  test("denies FileEdit through symlinks that target protected paths", () => {
    const cwd = tempProject();
    const gitDir = join(cwd, ".git");
    const protectedConfig = join(gitDir, "config");
    const safeLink = join(cwd, "safe-edit-link");
    mkdirSync(gitDir);
    writeFileSync(protectedConfig, "[core]\n", "utf8");
    symlinkSync(protectedConfig, safeLink);

    const result = engine.check("FileEdit", { file_path: safeLink }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("realpath");
  });

  test("denies FileWrite through parent symlink traversal into protected paths", () => {
    const cwd = tempProject();
    const gitDir = join(cwd, ".git");
    const linkDir = join(cwd, "safe-parent");
    mkdirSync(gitDir);
    symlinkSync(gitDir, linkDir, "dir");

    const result = engine.check("FileWrite", { file_path: join(linkDir, "config") }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("realpath");
  });

  test("hardening overrides user allow rules for write-capable paths", () => {
    const ctx = makeCtx([{ behavior: "allow", toolName: "FileWrite", pattern: "*" }]);
    const result = engine.check("FileWrite", { file_path: "/tmp/project/.claude.json" }, ctx);

    expect(result.behavior).toBe("deny");
  });

  test("denies MemoryWrite names that map to suspicious filesystem entries", () => {
    const result = engine.check("MemoryWrite", { name: "con" }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("DOS device");
  });

  test("does not overblock normal MemoryWrite names", () => {
    const result = engine.check("MemoryWrite", { name: "user_profile" }, makeCtx());

    expect(result.behavior).toBe("ask");
    expect(result.reason).toContain("confirmation");
  });

  test("denies path-like MemoryWrite names that target protected entries", () => {
    const result = engine.check("MemoryWrite", { name: "notes/.git/config" }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("Protected directory segment");
  });

  test("preserves existing system path deny behavior", () => {
    const result = engine.check("FileRead", { file_path: "/proc/self/environ" }, makeCtx());

    expect(result.behavior).toBe("deny");
    expect(result.reason).toContain("System path protected");
  });
});
