import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";

export interface ImportReference {
  specifier: string;
  kind: "import" | "export" | "require" | "dynamic-import";
}

export interface ImportGraphNode {
  path: string;
  imports: string[];
  importedBy: string[];
}

export interface ImportGraph {
  nodes: Map<string, ImportGraphNode>;
}

const DEFAULT_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"];

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function toProjectPath(filePath: string, cwd: string): string {
  return normalize(relative(cwd, filePath)).replace(/\\/g, "/");
}

export function parseImportSpecifiers(source: string): ImportReference[] {
  const text = stripComments(source);
  const refs: ImportReference[] = [];
  const patterns: Array<{ regex: RegExp; kind: ImportReference["kind"] }> = [
    { regex: /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/g, kind: "import" },
    { regex: /\bexport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)["']([^"']+)["']/g, kind: "export" },
    { regex: /\brequire\(\s*["']([^"']+)["']\s*\)/g, kind: "require" },
    { regex: /\bimport\(\s*["']([^"']+)["']\s*\)/g, kind: "dynamic-import" },
  ];

  for (const { regex, kind } of patterns) {
    for (const match of text.matchAll(regex)) {
      const specifier = match[1]?.trim();
      if (specifier) {
        refs.push({ specifier, kind });
      }
    }
  }

  return refs;
}

function candidatePaths(base: string, extensions: string[]): string[] {
  if (extname(base)) {
    return [base];
  }

  const paths = extensions.map((ext) => `${base}${ext}`);
  for (const ext of extensions) {
    paths.push(join(base, `index${ext}`));
  }
  return paths;
}

export function resolveImportSpecifier(
  specifier: string,
  fromFile: string,
  cwd: string,
  extensions: string[] = DEFAULT_EXTENSIONS,
): string | undefined {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return undefined;
  }

  const base = specifier.startsWith("/")
    ? resolve(cwd, `.${specifier}`)
    : resolve(dirname(fromFile), specifier);

  for (const candidate of candidatePaths(base, extensions)) {
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return toProjectPath(candidate, cwd);
    }
  }

  return undefined;
}

export function buildImportGraph(
  files: string[],
  options: { cwd: string; extensions?: string[] } | string,
): ImportGraph {
  const cwd = typeof options === "string" ? options : options.cwd;
  const extensions = typeof options === "string" ? DEFAULT_EXTENSIONS : (options.extensions ?? DEFAULT_EXTENSIONS);
  const nodes = new Map<string, ImportGraphNode>();

  for (const input of files) {
    const absolute = isAbsolute(input) ? input : join(cwd, input);
    const projectPath = toProjectPath(absolute, cwd);
    nodes.set(projectPath, { path: projectPath, imports: [], importedBy: [] });
  }

  for (const input of files) {
    const absolute = isAbsolute(input) ? input : join(cwd, input);
    if (!existsSync(absolute) || !statSync(absolute).isFile()) {
      continue;
    }

    const projectPath = toProjectPath(absolute, cwd);
    const node = nodes.get(projectPath) ?? { path: projectPath, imports: [], importedBy: [] };
    const refs = parseImportSpecifiers(readFileSync(absolute, "utf-8"));

    for (const ref of refs) {
      const resolvedImport = resolveImportSpecifier(ref.specifier, absolute, cwd, extensions);
      if (!resolvedImport) {
        continue;
      }
      node.imports.push(resolvedImport);
      const target = nodes.get(resolvedImport) ?? { path: resolvedImport, imports: [], importedBy: [] };
      if (!target.importedBy.includes(projectPath)) {
        target.importedBy.push(projectPath);
      }
      nodes.set(resolvedImport, target);
    }

    node.imports = [...new Set(node.imports)].sort();
    nodes.set(projectPath, node);
  }

  for (const node of nodes.values()) {
    node.importedBy = [...new Set(node.importedBy)].sort();
  }

  return { nodes };
}

export const DEFAULT_IMPORT_GRAPH_EXTENSIONS = DEFAULT_EXTENSIONS;
