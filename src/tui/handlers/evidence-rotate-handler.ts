/**
 * Evidence rotation handler — renders /memory evidence-rotate output.
 */

import type { HandlerContext } from "./types.js";
import { rotateAllEvidence, type RotationResult } from "../../agent/self-improve/evidence-rotation.js";

export interface EvidenceRotateData {
  dryRun?: boolean;
}

export async function handleEvidenceRotateCommand(
  data: EvidenceRotateData,
  context: HandlerContext,
): Promise<string> {
  try {
    const results: RotationResult[] = rotateAllEvidence(
      context.projectId,
      undefined,
      context.rootDir,
    );

    const dryRun = data?.dryRun === true;
    const lines: string[] = [
      `# Evidence Rotation${dryRun ? " (dry-run)" : ""}`,
      "",
      "| domain | files | records archived | bytes freed | archive |",
      "|--------|-------|-------------------|-------------|---------|",
    ];

    let totalFiles = 0;
    let totalRecords = 0;
    let totalBytes = 0;
    for (const r of results) {
      const path = r.archivePath ? `\`${r.archivePath}\`` : "—";
      lines.push(
        `| ${r.domain} | ${r.filesRotated} | ${r.recordsArchived} | ${r.bytesFreed} | ${path} |`,
      );
      totalFiles += r.filesRotated;
      totalRecords += r.recordsArchived;
      totalBytes += r.bytesFreed;
    }

    lines.push("");
    lines.push(
      `**Total:** ${totalFiles} files, ${totalRecords} records archived, ${totalBytes.toLocaleString()} bytes freed.`,
    );
    if (dryRun) lines.push("\n*Dry-run only — no files moved.*");

    return lines.join("\n");
  } catch (err) {
    return `Error rotating evidence: ${(err as Error).message}`;
  }
}
