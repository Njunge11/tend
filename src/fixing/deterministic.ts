import { existsSync,readFileSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import ts from "typescript";
import type { RevertReason } from "../gate/check.js";
import type { FixOutcome } from "../orchestrator.js";
import { applyEslintFixesForFindings } from "../scanners/eslint-sonarjs.js";
import { zeroUsage } from "../session/types.js";
import type { WorkUnit } from "./dispatch.js";
import type { RepairStrategy } from "./repair-strategy.js";
import {
gateUnitChanges,
restoreSnapshot,
snapshotUnitFiles,
unitChanged,
type UnitGateDeps,
} from "./unit-gate.js";

type DeterministicRepairStrategy = Extract<RepairStrategy, `deterministic-${string}`>;

export interface DeterministicFixer {
  /** Fix a planned repair unit without starting an AI session. */
  fix(unit: WorkUnit): Promise<FixOutcome>;
}

export type DeterministicFixUnitDeps = UnitGateDeps;

type ApplyResult = { ok: true } | { ok: false; reason: RevertReason; detail: string };

const ZERO_AI_USAGE = zeroUsage();
const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lockb"];

function strategiesFor(unit: WorkUnit): DeterministicRepairStrategy[] {
  return (unit.strategies ?? (unit.strategy ? [unit.strategy] : [])).filter(
    (strategy): strategy is DeterministicRepairStrategy => strategy.startsWith("deterministic-"),
  );
}

function packageNameFromFindingMessage(message: string): string | undefined {
  const match = /:\s*(@?[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)?)(?:\s|$)/.exec(message);
  return match?.[1];
}

function hasLockfile(cwd: string): boolean {
  return LOCKFILES.some((file) => existsSync(join(cwd, file)));
}

type PackageJson = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

function removeDependencyFromJson(json: PackageJson, name: string): ApplyResult {
  if (json.dependencies?.[name] !== undefined) {
    delete json.dependencies[name];
  } else if (json.devDependencies?.[name] !== undefined) {
    delete json.devDependencies[name];
  } else {
    return {
      ok: false,
      reason: "session-error",
      detail: `Dependency "${name}" was not found in dependencies or devDependencies`,
    };
  }
  if (json.dependencies && Object.keys(json.dependencies).length === 0) delete json.dependencies;
  if (json.devDependencies && Object.keys(json.devDependencies).length === 0) delete json.devDependencies;
  return { ok: true };
}

function cleanupSinglePackageFile(cwd: string, file: string, findings: { message: string }[]): ApplyResult {
  const abs = join(cwd, file);
  const json = JSON.parse(readFileSync(abs, "utf8")) as PackageJson;
  let removed = false;

  for (const finding of findings) {
    const name = packageNameFromFindingMessage(finding.message);
    if (!name) {
      return {
        ok: false,
        reason: "session-error",
        detail: `Could not parse unused dependency name from finding: ${finding.message}`,
      };
    }
    const result = removeDependencyFromJson(json, name);
    if (!result.ok) return result;
    removed = true;
  }

  if (removed) writeFileSync(abs, `${JSON.stringify(json, null, 2)}\n`);
  return { ok: true };
}

function applyPackageJsonCleanup(cwd: string, unit: WorkUnit): ApplyResult {
  const packageFiles = [...new Set(unit.findings.map((finding) => finding.file).filter((file) => /(^|\/)package\.json$/.test(file)))];
  for (const file of packageFiles) {
    const result = cleanupSinglePackageFile(cwd, file, unit.findings.filter((f) => f.file === file));
    if (!result.ok) return result;
  }

  if (hasLockfile(cwd)) {
    return {
      ok: false,
      reason: "needs-lockfile-update",
      detail: "package.json dependency cleanup requires a lockfile update, which is not implemented yet",
    };
  }

  return { ok: true };
}

function applyTextChanges(fileName: string, changes: readonly ts.TextChange[]): void {
  let text = readFileSync(fileName, "utf8");
  for (const change of [...changes].sort((a, b) => b.span.start - a.span.start)) {
    text = `${text.slice(0, change.span.start)}${change.newText}${text.slice(change.span.start + change.span.length)}`;
  }
  writeFileSync(fileName, text);
}

function organizeImports(cwd: string, files: string[]): ApplyResult {
  const fileNames = [...new Set(files)]
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file))
    .map((file) => resolve(cwd, file))
    .filter(existsSync);

  if (fileNames.length === 0) return { ok: true };

  const compilerOptions: ts.CompilerOptions = {
    allowJs: true,
    checkJs: false,
    jsx: ts.JsxEmit.ReactJSX,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
  };

  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => compilerOptions,
    getScriptFileNames: () => fileNames,
    getScriptVersion: () => "0",
    getScriptSnapshot: (fileName) => {
      if (!existsSync(fileName)) return undefined;
      return ts.ScriptSnapshot.fromString(readFileSync(fileName, "utf8"));
    },
    getCurrentDirectory: () => cwd,
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  };

  const service = ts.createLanguageService(host);
  try {
    for (const fileName of fileNames) {
      const changes = service.organizeImports({ type: "file", fileName }, {}, {});
      for (const fileChanges of changes) {
        applyTextChanges(fileChanges.fileName, fileChanges.textChanges);
      }
    }
    return { ok: true };
  } finally {
    service.dispose();
  }
}

async function applyEslint(cwd: string, unit: WorkUnit): Promise<ApplyResult> {
  const result = await applyEslintFixesForFindings(
    { cwd, files: unit.findings.map((finding) => finding.file), loop: 0 },
    unit.findings.filter((finding) => finding.tool === "sonarjs"),
  );
  if (!result.error) return { ok: true };
  return { ok: false, reason: "session-error", detail: result.error };
}

async function applyStrategy(strategy: DeterministicRepairStrategy, cwd: string, unit: WorkUnit): Promise<ApplyResult> {
  switch (strategy) {
    case "deterministic-package-json-cleanup":
      return applyPackageJsonCleanup(cwd, unit);
    case "deterministic-ts-organize-imports":
      return organizeImports(cwd, unit.findings.map((finding) => finding.file));
    case "deterministic-eslint-fix":
      return applyEslint(cwd, unit);
  }
}

export function makeDeterministicFixer(deps: DeterministicFixUnitDeps): DeterministicFixer {
  return {
    async fix(unit: WorkUnit): Promise<FixOutcome> {
      const strategies = strategiesFor(unit);
      if (strategies.length === 0) {
        return {
          kept: false,
          reason: "session-error",
          detail: "No deterministic strategy was planned for this unit",
          usage: ZERO_AI_USAGE,
        };
      }

      const before = snapshotUnitFiles(deps.cwd, unit.files);
      // Baseline findings already in the verification scope, so the gate's anti-regression
      // doesn't blame this fix for pre-existing cross-file (jscpd) duplicates it never touched.
      const verificationTargets = unit.verificationTargets ?? unit.files;
      const scannerTools = [...new Set(unit.findings.map((finding) => finding.tool))];
      const preexistingIds = new Set((await deps.scanFindings(verificationTargets, scannerTools)).map((f) => f.id));
      for (const strategy of strategies) {
        const applied = await applyStrategy(strategy, deps.cwd, unit);
        if (!applied.ok) {
          restoreSnapshot(deps.cwd, before);
          return { kept: false, reason: applied.reason, detail: applied.detail, usage: ZERO_AI_USAGE };
        }
      }

      if (!unitChanged(deps.cwd, unit.files, before)) {
        return {
          kept: false,
          reason: "session-error",
          detail: "Deterministic fixer completed without changing owned files",
          usage: ZERO_AI_USAGE,
        };
      }

      const outcome = await gateUnitChanges(unit, before, deps, {
        usage: ZERO_AI_USAGE,
        requireResolved: true,
        preexistingIds,
      });
      if (!outcome.kept) {
        restoreSnapshot(deps.cwd, before);
        return { ...outcome, usage: ZERO_AI_USAGE };
      }

      return { kept: true, usage: ZERO_AI_USAGE };
    },
  };
}

export const makeDeterministicFixUnit = (deps: DeterministicFixUnitDeps) =>
  makeDeterministicFixer(deps).fix;
