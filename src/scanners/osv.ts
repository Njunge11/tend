import type { RawFinding } from "../findings/normalize.js";
import { toRepoRelative } from "./paths.js";
import type { Scanner, ScanContext, SpawnResult } from "./scanner.js";

type OsvEvent = { introduced?: string; fixed?: string; last_affected?: string };
type OsvAffected = { ranges?: { events?: OsvEvent[] }[] };
type OsvVuln = {
  id: string;
  summary?: string;
  references?: { url: string }[];
  affected?: OsvAffected[];
};
type OsvPackage = {
  package: { name: string; version: string; ecosystem: string };
  vulnerabilities?: OsvVuln[];
};
type OsvResult = { source: { path: string }; packages?: OsvPackage[] };
type OsvReport = { results?: OsvResult[] };

/** First `fixed` version across a vulnerability's affected ranges, if any. */
function fixedVersion(vuln: OsvVuln): string | undefined {
  for (const affected of vuln.affected ?? []) {
    for (const range of affected.ranges ?? []) {
      for (const event of range.events ?? []) {
        if (event.fixed) return event.fixed;
      }
    }
  }
  return undefined;
}

export const osvScanner: Scanner = {
  tool: "osv",
  binary: "osv-scanner",

  buildArgs(ctx: ScanContext): string[] {
    return ["--format", "json", "--recursive", ctx.cwd];
  },

  parse(raw: SpawnResult, ctx: ScanContext): RawFinding[] {
    const report = JSON.parse(raw.stdout) as OsvReport;
    const findings: RawFinding[] = [];

    for (const result of report.results ?? []) {
      const file = toRepoRelative(ctx.cwd, result.source.path);
      for (const pkg of result.packages ?? []) {
        const { name, version } = pkg.package;
        for (const vuln of pkg.vulnerabilities ?? []) {
          const fixed = fixedVersion(vuln);
          const finding: RawFinding = {
            tool: "osv",
            rule: vuln.id,
            category: "vuln-dep",
            severity: "error",
            file,
            range: { startLine: 0, startCol: 0, endLine: 0, endCol: 0 },
            message: vuln.summary ?? `${name}@${version} is vulnerable (${vuln.id})`,
          };
          if (fixed) finding.remediation = `Bump ${name} from ${version} to ${fixed}`;
          const ref = vuln.references?.[0]?.url;
          if (ref) finding.helpUri = ref;
          findings.push(finding);
        }
      }
    }

    return findings;
  },
};
