/** FileRead path safety checks for unsafe device and fd aliases. */

const BLOCKED_DEVICE_PATHS = new Set([
  "/dev/mem",
  "/dev/kmem",
  "/dev/port",
  "/dev/kmsg",
  "/dev/zero",
  "/dev/random",
  "/dev/urandom",
  "/dev/full",
  "/dev/stdin",
  "/dev/tty",
  "/dev/console",
  "/dev/stdout",
  "/dev/stderr",
]);

const BLOCKED_DEV_FD_RE = /^\/dev\/fd\/[0-2](?:\/|$)/;
const BLOCKED_PROC_FD_RE = /^\/proc\/[^/]+\/fd\/[0-2](?:\/|$)/;
const BLOCKED_DEVICE_PATTERNS = [
  {
    pattern: /^\/dev\/(?:sd[a-z]+\d*|hd[a-z]+\d*|vd[a-z]+\d*|xvd[a-z]+\d*|nvme\d+n\d+(?:p\d+)?|mmcblk\d+(?:p\d+)?|loop\d+|dm-\d+|md\d+|sr\d+)(?:\/|$)/,
    reason: "blocked Linux block device path",
  },
  {
    pattern: /^\/dev\/mapper\/[^/]+(?:\/|$)/,
    reason: "blocked Linux device mapper path",
  },
  {
    pattern: /^\/dev\/input\/[^/]+(?:\/|$)/,
    reason: "blocked Linux input device path",
  },
  {
    pattern: /^\/dev\/r?disk\d+(?:s\d+)?(?:\/|$)/,
    reason: "blocked macOS disk device path",
  },
  {
    pattern: /^\/dev\/(?:tty(?:[A-Z0-9.][^/]*)|cu\.[^/]+|pts\/\d+)(?:\/|$)/,
    reason: "blocked terminal or serial device path",
  },
] as const;

export interface BlockedFileReadPath {
  blocked: true;
  reason: string;
}

export interface AllowedFileReadPath {
  blocked: false;
}

export type FileReadPathSafety = BlockedFileReadPath | AllowedFileReadPath;

function normalizePathForSafety(filePath: string): string {
  return filePath.replace(/\/+$/u, "") || "/";
}

export function checkFileReadPathSafety(filePath: string): FileReadPathSafety {
  const normalized = normalizePathForSafety(filePath);

  if (BLOCKED_DEVICE_PATHS.has(normalized)) {
    return {
      blocked: true,
      reason: `blocked unsafe device path: ${normalized}`,
    };
  }

  if (BLOCKED_DEV_FD_RE.test(normalized)) {
    return {
      blocked: true,
      reason: `blocked standard file descriptor path: ${normalized}`,
    };
  }

  if (BLOCKED_PROC_FD_RE.test(normalized)) {
    return {
      blocked: true,
      reason: `blocked process file descriptor path: ${normalized}`,
    };
  }

  for (const { pattern, reason } of BLOCKED_DEVICE_PATTERNS) {
    if (pattern.test(normalized)) {
      return {
        blocked: true,
        reason: `${reason}: ${normalized}`,
      };
    }
  }

  return { blocked: false };
}
