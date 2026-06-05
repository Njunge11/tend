import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export type GeneratedSourceOwner = {
  generatedFile: string;
  sourceOwner?: string;
  sourceMap?: string;
};

type PackageJson = {
  main?: string;
  module?: string;
  types?: string;
  typings?: string;
  bin?: string | Record<string, string>;
  exports?: unknown;
  scripts?: Record<string, string>;
};

type SourceMapJson = {
  sourceRoot?: string;
  sources?: unknown;
};

const GENERATED_OUTPUT_SEGMENTS = new Set(["dist", "build", "out"]);
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"];
const GENERATED_EXTENSIONS = [
  ".d.ts.map",
  ".d.ts",
  ".js.map",
  ".mjs.map",
  ".cjs.map",
  ".js",
  ".mjs",
  ".cjs",
];

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function toRepoRelative(cwd: string, file: string): string {
  const rel = isAbsolute(file) ? relative(cwd, file) : file;
  return normalizePath(rel);
}

function absolutePath(cwd: string, file: string): string {
  return isAbsolute(file) ? file : join(cwd, file);
}

function pathSegments(file: string): string[] {
  return normalizePath(file).split("/").filter(Boolean);
}

function isGeneratedOutputPath(file: string): boolean {
  return pathSegments(file).some((segment) => GENERATED_OUTPUT_SEGMENTS.has(segment));
}

function isDeclarationArtifact(file: string): boolean {
  return /\.d\.ts(?:\.map)?$/.test(normalizePath(file));
}

function stripGeneratedExtension(file: string): string {
  const normalized = normalizePath(file);
  const extension = GENERATED_EXTENSIONS.find((ext) => normalized.endsWith(ext));
  return extension ? normalized.slice(0, -extension.length) : normalized.replace(/\.[^/.]+$/, "");
}

function sourceMappingUrl(contents: string): string | undefined {
  const match = contents.match(/[#@]\s*sourceMappingURL=([^\s]+)/);
  if (!match?.[1] || match[1].startsWith("data:")) return undefined;
  return decodeURIComponent(match[1]);
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function existingRelative(cwd: string, abs: string): string | undefined {
  if (!existsSync(abs)) return undefined;
  const rel = toRepoRelative(cwd, abs);
  if (rel.startsWith("../")) return undefined;
  return rel;
}

function sourceMapPathFor(cwd: string, file: string): string | undefined {
  const abs = absolutePath(cwd, file);
  if (normalizePath(file).endsWith(".map") && existsSync(abs)) return abs;

  if (existsSync(abs)) {
    const url = sourceMappingUrl(readFileSync(abs, "utf8"));
    if (url) {
      const resolved = resolve(dirname(abs), url);
      if (existsSync(resolved)) return resolved;
    }
  }

  const sibling = `${abs}.map`;
  if (existsSync(sibling)) return sibling;

  return undefined;
}

function sourceOwnerFromMap(cwd: string, mapPath: string): GeneratedSourceOwner | undefined {
  const map = readJson<SourceMapJson>(mapPath);
  if (!map || !Array.isArray(map.sources)) return undefined;

  for (const source of map.sources) {
    if (typeof source !== "string" || source.startsWith("webpack://")) continue;
    const candidates = [
      resolve(dirname(mapPath), map.sourceRoot ?? "", source),
      resolve(cwd, map.sourceRoot ?? "", source),
    ];
    const rel = candidates.map((candidate) => existingRelative(cwd, candidate)).find(Boolean);
    if (rel && !isGeneratedOutputPath(rel)) {
      return { generatedFile: "", sourceOwner: rel, sourceMap: toRepoRelative(cwd, mapPath) };
    }
  }

  return { generatedFile: "", sourceMap: toRepoRelative(cwd, mapPath) };
}

function packageJson(cwd: string): PackageJson | undefined {
  return readJson<PackageJson>(join(cwd, "package.json"));
}

function tsdownEntries(cwd: string): string[] {
  const configPath = join(cwd, "tsdown.config.ts");
  if (!existsSync(configPath)) return [];
  const contents = readFileSync(configPath, "utf8");
  const entries = new Set<string>();
  const arrayMatch = contents.match(/entry\s*:\s*\[([^\]]+)\]/s);
  if (arrayMatch?.[1]) {
    for (const match of arrayMatch[1].matchAll(/["']([^"']+)["']/g)) {
      if (match[1]) entries.add(normalizePath(match[1]));
    }
  }
  const stringMatch = contents.match(/entry\s*:\s*["']([^"']+)["']/);
  if (stringMatch?.[1]) entries.add(normalizePath(stringMatch[1]));
  return [...entries];
}

function collectExportTargets(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectExportTargets(item, out);
    return;
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) collectExportTargets(item, out);
  }
}

function packageTargets(pkg: PackageJson | undefined): string[] {
  if (!pkg) return [];
  const targets: string[] = [];
  if (pkg.main) targets.push(pkg.main);
  if (pkg.module) targets.push(pkg.module);
  if (pkg.types) targets.push(pkg.types);
  if (pkg.typings) targets.push(pkg.typings);
  if (typeof pkg.bin === "string") targets.push(pkg.bin);
  else if (pkg.bin) targets.push(...Object.values(pkg.bin));
  collectExportTargets(pkg.exports, targets);
  return targets.map(normalizePath);
}

function sourceBasename(file: string): string {
  const base = stripGeneratedExtension(file).split("/").pop() ?? "";
  return base === "index" ? "index" : base;
}

function sourceOwnerFromBuildConfig(cwd: string, file: string): string | undefined {
  const normalized = normalizePath(file);
  const targets = new Set(packageTargets(packageJson(cwd)));
  const entries = tsdownEntries(cwd);
  for (const entry of entries) {
    const entryBase = sourceBasename(entry);
    const matchesPackageTarget = targets.has(normalized);
    if ((matchesPackageTarget || sourceBasename(normalized) === entryBase) && existsSync(join(cwd, entry))) {
      return entry;
    }
  }

  return undefined;
}

function candidateSourcesForGenerated(file: string): string[] {
  const normalized = normalizePath(file);
  const parts = pathSegments(stripGeneratedExtension(normalized));
  const generatedIndex = parts.findIndex((part) => GENERATED_OUTPUT_SEGMENTS.has(part));
  if (generatedIndex < 0) return [];
  const suffix = parts.slice(generatedIndex + 1).join("/");
  if (!suffix) return [];
  return SOURCE_EXTENSIONS.map((ext) => `src/${suffix}${ext}`);
}

function sourceOwnerFromPathShape(cwd: string, file: string): string | undefined {
  return candidateSourcesForGenerated(file).find((candidate) => existsSync(join(cwd, candidate)));
}

export function isGeneratedArtifact(cwd: string, file: string): boolean {
  const normalized = toRepoRelative(cwd, file);
  if (isGeneratedOutputPath(normalized)) return true;
  if (isDeclarationArtifact(normalized) && isGeneratedOutputPath(normalized)) return true;
  return sourceMapPathFor(cwd, normalized) !== undefined;
}

export function resolveGeneratedSourceOwner(cwd: string, file: string): GeneratedSourceOwner | undefined {
  const generatedFile = toRepoRelative(cwd, file);
  if (!isGeneratedArtifact(cwd, generatedFile)) return undefined;

  const mapPath = sourceMapPathFor(cwd, generatedFile);
  let sourceMap: string | undefined;
  if (mapPath) {
    const fromMap = sourceOwnerFromMap(cwd, mapPath);
    if (fromMap?.sourceOwner) {
      return { generatedFile, sourceOwner: fromMap.sourceOwner, sourceMap: fromMap.sourceMap };
    }
    sourceMap = fromMap?.sourceMap ?? toRepoRelative(cwd, mapPath);
  }

  const sourceOwner = sourceOwnerFromBuildConfig(cwd, generatedFile) ?? sourceOwnerFromPathShape(cwd, generatedFile);
  return sourceOwner ? { generatedFile, sourceOwner, sourceMap } : { generatedFile, sourceMap };
}

export function detectBuildCommand(cwd: string): string[] | undefined {
  const pkg = packageJson(cwd);
  if (!pkg?.scripts?.build) return undefined;
  return ["run", "build"];
}
