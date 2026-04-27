/**
 * Wave 10 P3 / O1 — Evidence JSONL rolling retention.
 *
 * Rotates JSONL evidence files per domain to `.archive/{YYYY-MM}/{domain}/{id}.jsonl`
 * based on age (default 90 days) + total size (default 100MB) caps, whichever
 * triggers first. Best-effort — every error path returns a structured result
 * instead of throwing.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getProjectDir } from "../../config/paths.js";
import {
  getPromptEvidenceDir,
  getSkillEvidenceDir,
  getSubagentEvidenceDir,
} from "../../config/paths.js";
import type { EvidenceDomain, EvidenceRecord } from "./types.js";

const DEFAULT_MAX_AGE_DAYS = 90;
const DEFAULT_MAX_SIZE_BYTES = 100 * 1024 * 1024; // 100 MB

export interface RetentionPolicy {
  /** Max age in days. Default 90 (or env `EVIDENCE_RETENTION_DAYS`). */
  maxAgeDays?: number;
  /** Max total size per domain in bytes. Default 100MB (or env `EVIDENCE_RETENTION_MAX_MB`). */
  maxSizeBytes?: number;
}

export interface RotationResult {
  domain: EvidenceDomain;
  filesRotated: number;
  recordsArchived: number;
  bytesFreed: number;
  archivePath?: string;
  error?: string;
}

/** Resolve an evidence directory for a given domain (mirrors evidence.ts). */
function resolveDomainDir(
  projectId: string,
  domain: EvidenceDomain,
  rootDir?: string,
): string {
  switch (domain) {
    case "skill":
      return getSkillEvidenceDir(projectId, rootDir);
    case "subagent":
      return getSubagentEvidenceDir(projectId, rootDir);
    case "prompt":
      return getPromptEvidenceDir(projectId, rootDir);
    case "plan-iteration":
      return join(getSkillEvidenceDir(projectId, rootDir), "_plan");
  }
}

function readPolicyDefaults(): Required<RetentionPolicy> {
  const envDays = Number(process.env.EVIDENCE_RETENTION_DAYS);
  const envMb = Number(process.env.EVIDENCE_RETENTION_MAX_MB);
  return {
    maxAgeDays: Number.isFinite(envDays) && envDays > 0 ? envDays : DEFAULT_MAX_AGE_DAYS,
    maxSizeBytes:
      Number.isFinite(envMb) && envMb > 0 ? envMb * 1024 * 1024 : DEFAULT_MAX_SIZE_BYTES,
  };
}

function effectivePolicy(policy?: RetentionPolicy): Required<RetentionPolicy> {
  const defaults = readPolicyDefaults();
  return {
    maxAgeDays:
      typeof policy?.maxAgeDays === "number" && policy.maxAgeDays > 0
        ? policy.maxAgeDays
        : defaults.maxAgeDays,
    maxSizeBytes:
      typeof policy?.maxSizeBytes === "number" && policy.maxSizeBytes > 0
        ? policy.maxSizeBytes
        : defaults.maxSizeBytes,
  };
}

interface ParsedRecord {
  /** Original JSONL line (without trailing newline). */
  line: string;
  /** Parsed record, or null when the line was unparseable. */
  record: EvidenceRecord | null;
  /** ms epoch from `invokedAt`, NaN when missing/invalid. */
  ts: number;
  /** Byte length of `line + "\n"` as written on disk. */
  bytes: number;
}

function parseJsonlFile(path: string): ParsedRecord[] {
  const raw = readFileSync(path, "utf8");
  const out: ParsedRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let record: EvidenceRecord | null = null;
    let ts = Number.NaN;
    try {
      const parsed = JSON.parse(line) as EvidenceRecord;
      record = parsed;
      ts = Date.parse(parsed.invokedAt);
    } catch {
      // Corrupted line — keep as opaque, treat as ageless (Number.NaN).
      record = null;
    }
    out.push({
      line,
      record,
      ts,
      bytes: Buffer.byteLength(`${line}\n`, "utf8"),
    });
  }
  return out;
}

function monthFolder(ms: number): string {
  const d = Number.isFinite(ms) ? new Date(ms) : new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

/** Append archived records to the archive jsonl, creating dirs as needed. */
function appendArchive(
  archiveDir: string,
  filename: string,
  records: ParsedRecord[],
): string {
  if (!existsSync(archiveDir)) {
    mkdirSync(archiveDir, { recursive: true });
  }
  const archivePath = join(archiveDir, filename);
  const payload = `${records.map((r) => r.line).join("\n")}\n`;
  appendFileSync(archivePath, payload, "utf8");
  return archivePath;
}

/**
 * Rotate a single domain. Splits each `<id>.jsonl` into "old" (older than
 * cutoff) → archive, "recent" → kept in place. After per-file age culling, if
 * the total in-place size still exceeds `maxSizeBytes`, the oldest remaining
 * records (across all files in the domain) are archived until the threshold is
 * met.
 */
export function rotateEvidence(
  projectId: string,
  domain: EvidenceDomain,
  policy?: RetentionPolicy,
  rootDir?: string,
): RotationResult {
  return performRotation(projectId, domain, policy, rootDir, false);
}

/** Rotate every supported domain. */
export function rotateAllEvidence(
  projectId: string,
  policy?: RetentionPolicy,
  rootDir?: string,
): RotationResult[] {
  const domains: EvidenceDomain[] = ["skill", "subagent", "prompt", "plan-iteration"];
  return domains.map((d) => rotateEvidence(projectId, d, policy, rootDir));
}

/** Dry-run preview — no files are mutated. */
export function previewRotation(
  projectId: string,
  domain: EvidenceDomain,
  policy?: RetentionPolicy,
  rootDir?: string,
): RotationResult {
  return performRotation(projectId, domain, policy, rootDir, true);
}

interface FileBucket {
  filename: string;
  path: string;
  records: ParsedRecord[];
}

function performRotation(
  projectId: string,
  domain: EvidenceDomain,
  policy: RetentionPolicy | undefined,
  rootDir: string | undefined,
  dryRun: boolean,
): RotationResult {
  const result: RotationResult = {
    domain,
    filesRotated: 0,
    recordsArchived: 0,
    bytesFreed: 0,
  };
  if (!projectId) {
    result.error = "projectId is required";
    return result;
  }

  try {
    const dir = resolveDomainDir(projectId, domain, rootDir);
    if (!existsSync(dir)) return result;

    const { maxAgeDays, maxSizeBytes } = effectivePolicy(policy);
    const cutoffMs = Date.now() - maxAgeDays * 86_400_000;

    // Per-file age cull.
    const buckets: FileBucket[] = [];
    const archiveQueue: { bucket: FileBucket; archived: ParsedRecord[] }[] = [];

    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const filePath = join(dir, name);
      let stat;
      try {
        stat = statSync(filePath);
        if (!stat.isFile()) continue;
      } catch {
        continue;
      }
      let parsed: ParsedRecord[] = [];
      try {
        parsed = parseJsonlFile(filePath);
      } catch {
        // Unreadable file — skip silently (best-effort).
        continue;
      }

      const archived: ParsedRecord[] = [];
      const kept: ParsedRecord[] = [];
      for (const rec of parsed) {
        if (Number.isFinite(rec.ts) && rec.ts < cutoffMs) {
          archived.push(rec);
        } else {
          kept.push(rec);
        }
      }

      const bucket: FileBucket = { filename: name, path: filePath, records: kept };
      buckets.push(bucket);
      if (archived.length > 0) {
        archiveQueue.push({ bucket, archived });
      }
    }

    // Compute in-place size after age cull.
    let totalBytes = buckets.reduce(
      (sum, b) => sum + b.records.reduce((s, r) => s + r.bytes, 0),
      0,
    );

    // Size cap: pull oldest records across all files until under threshold.
    const sizeArchiveQueue: { bucket: FileBucket; archived: ParsedRecord[] }[] = [];
    if (totalBytes > maxSizeBytes) {
      // Build a unified oldest-first list of in-place records (skip undated).
      type Item = { bucket: FileBucket; rec: ParsedRecord; idx: number };
      const items: Item[] = [];
      for (const b of buckets) {
        b.records.forEach((rec, idx) => {
          if (Number.isFinite(rec.ts)) items.push({ bucket: b, rec, idx });
        });
      }
      items.sort((a, b) => a.rec.ts - b.rec.ts);
      const dropIdsByBucket = new Map<FileBucket, Set<number>>();
      for (const item of items) {
        if (totalBytes <= maxSizeBytes) break;
        let set = dropIdsByBucket.get(item.bucket);
        if (!set) {
          set = new Set();
          dropIdsByBucket.set(item.bucket, set);
        }
        set.add(item.idx);
        totalBytes -= item.rec.bytes;
      }
      for (const [bucket, idxSet] of dropIdsByBucket) {
        const archived: ParsedRecord[] = [];
        const kept: ParsedRecord[] = [];
        bucket.records.forEach((rec, idx) => {
          if (idxSet.has(idx)) archived.push(rec);
          else kept.push(rec);
        });
        bucket.records = kept;
        sizeArchiveQueue.push({ bucket, archived });
      }
    }

    // Tally counts/bytes for both queues.
    const archiveTouched = new Set<FileBucket>();
    const archivePathsSet = new Set<string>();
    let recordsArchived = 0;
    let bytesFreed = 0;
    for (const queue of [archiveQueue, sizeArchiveQueue]) {
      for (const { bucket, archived } of queue) {
        if (archived.length === 0) continue;
        archiveTouched.add(bucket);
        recordsArchived += archived.length;
        bytesFreed += archived.reduce((s, r) => s + r.bytes, 0);
      }
    }

    if (dryRun) {
      result.recordsArchived = recordsArchived;
      result.bytesFreed = bytesFreed;
      result.filesRotated = archiveTouched.size;
      // Preview the archive path that *would* be written for the first bucket.
      if (archiveTouched.size > 0) {
        const sample = archiveTouched.values().next().value as FileBucket;
        result.archivePath = join(
          getProjectDir(projectId, rootDir),
          ".archive",
          monthFolder(Date.now()),
          domain,
          sample.filename,
        );
      }
      return result;
    }

    // Apply: write archive then rewrite live file (or delete when empty).
    if (recordsArchived > 0) {
      const monthDir = monthFolder(Date.now());
      const archiveDir = join(
        getProjectDir(projectId, rootDir),
        ".archive",
        monthDir,
        domain,
      );

      // Group archived records per bucket.
      const groupedArchive = new Map<FileBucket, ParsedRecord[]>();
      for (const queue of [archiveQueue, sizeArchiveQueue]) {
        for (const { bucket, archived } of queue) {
          if (archived.length === 0) continue;
          const existing = groupedArchive.get(bucket) ?? [];
          existing.push(...archived);
          groupedArchive.set(bucket, existing);
        }
      }

      for (const [bucket, archived] of groupedArchive) {
        try {
          const written = appendArchive(archiveDir, bucket.filename, archived);
          archivePathsSet.add(written);
        } catch (err) {
          // Best-effort: skip archive write but keep live data intact.
          result.error = err instanceof Error ? err.message : String(err);
          return result;
        }
      }

      for (const bucket of archiveTouched) {
        try {
          if (bucket.records.length === 0) {
            rmSync(bucket.path, { force: true });
          } else {
            const payload = `${bucket.records.map((r) => r.line).join("\n")}\n`;
            writeFileSync(bucket.path, payload, "utf8");
          }
        } catch (err) {
          result.error = err instanceof Error ? err.message : String(err);
          return result;
        }
      }
    }

    result.recordsArchived = recordsArchived;
    result.bytesFreed = bytesFreed;
    result.filesRotated = archiveTouched.size;
    if (archivePathsSet.size > 0) {
      result.archivePath = archivePathsSet.values().next().value;
    }
    return result;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
    return result;
  }
}
