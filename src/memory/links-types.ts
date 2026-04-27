/**
 * Wiki Link Graph types (Wave 7 Phase 3) — forward-only MVP.
 *
 * Storage layout: `<memoryDir>/links/forward.json`.
 * Backlinks are deferred to Wave 10+ per dev-plan D3.
 */

/** Forward index: file path (relative to memoryDir) → entities it references via `[[Entity]]`. */
export interface ForwardIndex {
  [filePath: string]: string[];
}

export interface LinkScanResult {
  filesScanned: number;
  entitiesLinked: number;
  written: boolean;
  error?: string;
}

export interface LinkGraphNode {
  root: string;
  hops: number;
  nodes: string[];
  edges: [string, string][];
}
