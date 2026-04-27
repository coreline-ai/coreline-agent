/**
 * Filesystem permission hardening for write-capable tool paths.
 *
 * This module intentionally validates raw path strings before following the
 * filesystem. Normalization can hide dangerous syntax such as trailing dots,
 * Windows namespace prefixes, or 8.3 short-name components.
 */

import { existsSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const PROTECTED_DANGEROUS_FILES = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
  ".claude.json",
] as const;

export const DANGEROUS_DIRECTORIES = [".git", ".vscode", ".idea", ".claude"] as const;

export type FilesystemHardeningViolationKind = "protected-path" | "suspicious-path";

export interface FilesystemHardeningViolation {
  kind: FilesystemHardeningViolationKind;
  reason: string;
  path: string;
  segment?: string;
  realPath?: string;
}

export interface FilesystemHardeningResult {
  allowed: boolean;
  violation?: FilesystemHardeningViolation;
}

const PROTECTED_FILE_SET = new Set(PROTECTED_DANGEROUS_FILES.map((item) => item.toLowerCase()));
const DANGEROUS_DIRECTORY_SET = new Set(DANGEROUS_DIRECTORIES.map((item) => item.toLowerCase()));
const DOS_DEVICE_NAMES = new Set([
  "CON",
  "PRN",
  "AUX",
  "NUL",
  "CONIN$",
  "CONOUT$",
  "CLOCK$",
  ...Array.from({ length: 9 }, (_, index) => `COM${index + 1}`),
  ...Array.from({ length: 9 }, (_, index) => `LPT${index + 1}`),
  "COM¹",
  "COM²",
  "COM³",
  "LPT¹",
  "LPT²",
  "LPT³",
]);

const SHORT_NAME_RE = /~\d+/;
const WINDOWS_LONG_PATH_PREFIXES = ["\\\\?\\", "//?/"];
const WINDOWS_DEVICE_PATH_PREFIXES = ["\\\\.\\", "//./"];

function violation(
  kind: FilesystemHardeningViolationKind,
  path: string,
  reason: string,
  segment?: string,
  realPath?: string,
): FilesystemHardeningResult {
  return {
    allowed: false,
    violation: { kind, path, reason, segment, realPath },
  };
}

function splitPathSegments(rawPath: string): string[] {
  return rawPath.split(/[\\/]+/).filter((segment) => segment.length > 0);
}

function stripDosSuffix(segment: string): string {
  const colonIndex = segment.indexOf(":");
  const withoutStream = colonIndex >= 0 ? segment.slice(0, colonIndex) : segment;
  const dotIndex = withoutStream.indexOf(".");
  return dotIndex >= 0 ? withoutStream.slice(0, dotIndex) : withoutStream;
}

function isDosDeviceSegment(segment: string): boolean {
  const candidate = stripDosSuffix(segment).toUpperCase();
  return DOS_DEVICE_NAMES.has(candidate);
}

function hasWindowsLongPathPrefix(rawPath: string): boolean {
  return WINDOWS_LONG_PATH_PREFIXES.some((prefix) => rawPath.startsWith(prefix));
}

function hasWindowsDevicePathPrefix(rawPath: string): boolean {
  return WINDOWS_DEVICE_PATH_PREFIXES.some((prefix) => rawPath.startsWith(prefix));
}

function isUncPath(rawPath: string): boolean {
  return rawPath.startsWith("\\\\") || rawPath.startsWith("//");
}

/**
 * Check whether a raw filesystem path should be blocked before write-capable
 * tools are allowed to proceed.
 */
export function checkFilesystemPathHardening(path: string): FilesystemHardeningResult {
  if (hasWindowsLongPathPrefix(path)) {
    return violation("suspicious-path", path, "Windows long path prefix is not allowed");
  }

  if (hasWindowsDevicePathPrefix(path)) {
    return violation("suspicious-path", path, "Windows device path prefix is not allowed");
  }

  if (isUncPath(path)) {
    return violation("suspicious-path", path, "UNC paths are not allowed");
  }

  // Preserve the longstanding POSIX safe sink exception. The basename `null`
  // would otherwise look like the Windows DOS device `NUL`.
  if (path.replace(/\/+$/u, "") === "/dev/null") {
    return { allowed: true };
  }

  for (const segment of splitPathSegments(path)) {
    const lowerSegment = segment.toLowerCase();

    if (DANGEROUS_DIRECTORY_SET.has(lowerSegment)) {
      return violation("protected-path", path, `Protected directory segment: ${segment}`, segment);
    }

    if (PROTECTED_FILE_SET.has(lowerSegment)) {
      return violation("protected-path", path, `Protected file segment: ${segment}`, segment);
    }

    if (segment === "...") {
      return violation("suspicious-path", path, "Suspicious path component: ...", segment);
    }

    if (segment !== "." && segment !== ".." && /[. ]$/.test(segment)) {
      return violation("suspicious-path", path, `Path component has trailing dot or space: ${segment}`, segment);
    }

    if (SHORT_NAME_RE.test(segment)) {
      return violation("suspicious-path", path, `8.3 short-name path component is not allowed: ${segment}`, segment);
    }

    if (isDosDeviceSegment(segment)) {
      return violation("suspicious-path", path, `DOS device path component is not allowed: ${segment}`, segment);
    }
  }

  return { allowed: true };
}

/**
 * Return canonical realpaths for the deepest existing target and its existing
 * parent directories. This catches both final symlinks and parent-directory
 * symlink traversal for paths that do not exist yet.
 */
export function collectExistingPathRealpaths(path: string, cwd = process.cwd()): string[] {
  const absolutePath = resolve(cwd, path);
  const realPaths: string[] = [];
  const seen = new Set<string>();
  let current = absolutePath;

  while (true) {
    if (existsSync(current)) {
      try {
        const realPath = realpathSync(current);
        if (!seen.has(realPath)) {
          seen.add(realPath);
          realPaths.push(realPath);
        }
      } catch {
        // Race-safe: permissions should not fail closed just because a path was
        // removed between existsSync() and realpathSync().
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return realPaths;
}

/**
 * Full write-path hardening: raw syntax/segment checks plus symlink/realpath
 * ancestry checks. Realpath checks are intentionally limited to existing path
 * components, so creating new ordinary files remains possible while protected
 * symlink targets and protected parent symlink traversals are denied.
 */
export function checkFilesystemWritePathHardening(path: string, cwd = process.cwd()): FilesystemHardeningResult {
  const rawCheck = checkFilesystemPathHardening(path);
  if (!rawCheck.allowed) return rawCheck;

  for (const realPath of collectExistingPathRealpaths(path, cwd)) {
    const realPathCheck = checkFilesystemPathHardening(realPath);
    if (!realPathCheck.allowed && realPathCheck.violation) {
      return violation(
        realPathCheck.violation.kind,
        path,
        `Resolved realpath targets protected or suspicious path: ${realPath} (${realPathCheck.violation.reason})`,
        realPathCheck.violation.segment,
        realPath,
      );
    }
  }

  return { allowed: true };
}
