import type { Finding, ScopeExclusionReason } from "../findings/finding.js";

export type FixScopeConfig = {
  include?: string[];
  exclude?: string[];
  includeGenerated?: boolean;
  includeFixtures?: boolean;
  includeTests?: boolean;
};

export type ScopePolicyOptions = FixScopeConfig & {
  /** Changed-file/path scope. `false` means the finding is report-visible but not fixable. */
  inChangedScope?: boolean;
};

export type ScopeDecision = {
  inReportScope: boolean;
  inFixScope: boolean;
  scopeExclusionReason?: ScopeExclusionReason;
};

const OUT_OF_SCOPE_SEGMENTS = new Set(["node_modules", ".git"]);
const GENERATED_SEGMENTS = new Set([
  ".tend",
  ".turbo",
  ".next",
  ".vercel",
  "coverage",
  "dist",
  "build",
  "out",
  "generated",
  "__generated__",
]);

const TEST_FILE_RE = /(^|[/\\])[^/\\]+\.(test|spec)\.[cm]?[jt]sx?$/;

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

function pathSegments(path: string): string[] {
  return normalizePath(path).split("/").filter(Boolean);
}

function hasGlob(pattern: string): boolean {
  return /[*?[\]{}]/.test(pattern);
}

function escapeRegex(char: string): string {
  return char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
}

function globToRegex(pattern: string): RegExp {
  const normalized = normalizePath(pattern);
  let source = "^";
  for (let i = 0; i < normalized.length; i++) {
    const char = normalized[i]!;
    const next = normalized[i + 1];
    if (char === "*") {
      if (next === "*") {
        const after = normalized[i + 2];
        if (after === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += escapeRegex(char);
    }
  }
  source += "$";
  return new RegExp(source);
}

function matchesPattern(path: string, pattern: string): boolean {
  const normalizedPath = normalizePath(path);
  const normalizedPattern = normalizePath(pattern);
  if (!hasGlob(normalizedPattern)) {
    return (
      normalizedPath === normalizedPattern ||
      normalizedPath.startsWith(`${normalizedPattern}/`)
    );
  }
  return globToRegex(normalizedPattern).test(normalizedPath);
}

function matchesAnyPath(paths: string[], patterns: string[] | undefined): boolean {
  if (!patterns || patterns.length === 0) return false;
  return paths.some((path) =>
    patterns.some((pattern) => matchesPattern(path, pattern)),
  );
}

function isFixturePath(path: string): boolean {
  const segments = pathSegments(path);
  if (segments.includes("__fixtures__")) return true;
  return segments.some(
    (segment, index) =>
      (segment === "test" || segment === "tests") && segments[index + 1] === "fixtures",
  );
}

function isGeneratedPath(path: string): boolean {
  const segments = pathSegments(path);
  if (segments.some((segment) => GENERATED_SEGMENTS.has(segment))) return true;
  return (
    /\.(d\.ts|d\.ts\.map)$/.test(normalizePath(path)) &&
    segments.some((segment) => segment === "generated" || segment === "build")
  );
}

function isOutOfScopePath(path: string): boolean {
  return pathSegments(path).some((segment) => OUT_OF_SCOPE_SEGMENTS.has(segment));
}

function isTestPath(path: string): boolean {
  return TEST_FILE_RE.test(normalizePath(path));
}

function findingPaths(finding: Pick<Finding, "file" | "flowPath">): string[] {
  return [
    finding.file,
    ...(finding.flowPath ?? []).map((step) => step.file),
  ].map(normalizePath);
}

function defaultExclusionReason(paths: string[]): ScopeExclusionReason | undefined {
  if (paths.some(isOutOfScopePath)) return "out-of-scope";
  if (paths.some(isFixturePath)) return "fixtures";
  if (paths.some(isGeneratedPath)) return "generated";
  if (paths.some(isTestPath)) return "tests";
  return undefined;
}

/** Decide report/fix scope for a finding without mutating it. */
export function classifyScope(
  finding: Pick<Finding, "file" | "flowPath">,
  options: ScopePolicyOptions = {},
): ScopeDecision {
  const paths = findingPaths(finding);
  if (options.inChangedScope === false) {
    return {
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "out-of-scope",
    };
  }

  if (matchesAnyPath(paths, options.exclude)) {
    return {
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: "out-of-scope",
    };
  }

  if (matchesAnyPath(paths, options.include)) {
    return { inReportScope: true, inFixScope: true };
  }

  const reason = defaultExclusionReason(paths);
  if (reason === "generated" && options.includeGenerated)
    return { inReportScope: true, inFixScope: true };
  if (reason === "fixtures" && options.includeFixtures)
    return { inReportScope: true, inFixScope: true };
  if (reason === "tests" && options.includeTests)
    return { inReportScope: true, inFixScope: true };

  if (reason) {
    return {
      inReportScope: true,
      inFixScope: false,
      scopeExclusionReason: reason,
    };
  }

  return { inReportScope: true, inFixScope: true };
}

/** Apply scope metadata in place so store/report state stays marked consistently. */
export function markScope(
  finding: Finding,
  options: ScopePolicyOptions = {},
): Finding {
  const decision = classifyScope(finding, options);
  finding.inReportScope = decision.inReportScope;
  finding.inFixScope = decision.inFixScope;
  if (decision.scopeExclusionReason) {
    finding.scopeExclusionReason = decision.scopeExclusionReason;
  } else {
    delete finding.scopeExclusionReason;
  }
  return finding;
}
