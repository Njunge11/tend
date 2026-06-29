import { execFileSync } from "node:child_process";
import { existsSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { join,resolve } from "node:path";
import ts from "typescript";
import { detectPackageManager, type PackageManager } from "../detect/package-manager.js";
import type { RevertReason } from "../gate/check.js";
import type { FixOutcome } from "../orchestrator.js";
import { applyEslintFixesForFindings } from "../scanners/eslint-sonarjs.js";
import { zeroUsage, type FailureClass } from "../session/types.js";
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

type ApplyResult =
  | { ok: true }
  | { ok: false; reason: RevertReason; detail: string; failureClass?: FailureClass };

/**
 * A deterministic fixer hit a code shape its AST surgery doesn't support. The input is fixed, so
 * a retry reproduces the identical failure — flag it terminal/no-burn instead of letting it masquerade
 * as a (retryable, mislabeled) "session-error".
 */
function unsupported(detail: string): ApplyResult {
  return {
    ok: false,
    reason: "deterministic-unsupported",
    detail,
    failureClass: "deterministic-unsupported",
  };
}

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

function lockfileIn(cwd: string): string | undefined {
  return LOCKFILES.find((file) => existsSync(join(cwd, file)));
}

/**
 * Runs a package-manager command (for lockfile regeneration) in `cwd`, throwing on a non-zero exit.
 * Injectable through {@link DeterministicFixUnitDeps.runPackageManager} so tests can stub it; the
 * default shells out with output captured (not inherited) so a slow `install` stays quiet.
 */
export type PackageManagerRunner = (cmd: string, args: readonly string[], cwd: string) => void;

const defaultPackageManagerRun: PackageManagerRunner = (cmd, args, cwd) => {
  execFileSync(cmd, [...args], { cwd, stdio: "pipe" });
};

/**
 * The command that regenerates ONLY the lockfile to match an edited package.json — no node_modules
 * linking, no lifecycle scripts. yarn-classic and bun have no reliable lockfile-only mode, so they
 * return undefined and the cleanup punts rather than risk a package.json/lockfile that disagree.
 */
function lockfileOnlyCommand(pm: PackageManager, cwd: string): { cmd: string; args: string[] } | undefined {
  switch (pm) {
    case "pnpm":
      return { cmd: "pnpm", args: ["install", "--lockfile-only", "--ignore-scripts"] };
    case "npm":
      return { cmd: "npm", args: ["install", "--package-lock-only", "--ignore-scripts"] };
    case "yarn":
      // Only Berry (>= 2) supports `--mode update-lockfile`; its presence is marked by `.yarnrc.yml`.
      return existsSync(join(cwd, ".yarnrc.yml")) ? { cmd: "yarn", args: ["install", "--mode", "update-lockfile"] } : undefined;
    case "bun":
      return undefined;
  }
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

function applyPackageJsonCleanup(cwd: string, unit: WorkUnit, run: PackageManagerRunner): ApplyResult {
  const packageFiles = [...new Set(unit.findings.map((finding) => finding.file).filter((file) => /(^|\/)package\.json$/.test(file)))];
  for (const file of packageFiles) {
    const result = cleanupSinglePackageFile(cwd, file, unit.findings.filter((f) => f.file === file));
    if (!result.ok) return result;
  }

  // No lockfile → the package.json edit is the whole fix.
  if (!lockfileIn(cwd)) return { ok: true };

  // A lockfile exists: it must be regenerated to match, or the repo is left inconsistent. Run the
  // package manager's lockfile-only update; the gate snapshots the lockfile too, so a failure here
  // (or a later gate revert) restores both files atomically.
  const pm = detectPackageManager(cwd);
  const command = lockfileOnlyCommand(pm, cwd);
  if (!command) {
    return {
      ok: false,
      reason: "needs-lockfile-update",
      detail: `package.json dependency cleanup needs a lockfile update, which is not supported for ${pm}`,
    };
  }

  try {
    run(command.cmd, command.args, cwd);
  } catch (error) {
    const stderr = (error as { stderr?: Buffer | string })?.stderr;
    const detail = (typeof stderr === "string" ? stderr : stderr?.toString()) || (error instanceof Error ? error.message : String(error));
    return {
      ok: false,
      reason: "needs-lockfile-update",
      detail: `lockfile regeneration via \`${command.cmd} ${command.args.join(" ")}\` failed: ${detail.trim().slice(0, 200)}`,
    };
  }

  return { ok: true };
}

function applyUnusedFileDelete(cwd: string, unit: WorkUnit): ApplyResult {
  const files = [...new Set(unit.findings.filter((finding) => finding.rule === "unused-file").map((finding) => finding.file))];
  if (files.length === 0) {
    return {
      ok: false,
      reason: "session-error",
      detail: "No unused-file findings were present in the deterministic delete unit",
    };
  }

  for (const file of files) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) {
      return {
        ok: false,
        reason: "session-error",
        detail: `Unused file was already missing: ${file}`,
      };
    }
    rmSync(abs, { force: true });
  }
  return { ok: true };
}

function symbolNameFromFindingMessage(message: string): string | undefined {
  return /:\s*([A-Za-z_$][\w$]*)\b/.exec(message)?.[1];
}

function hasExportModifier(node: ts.Node): boolean {
  return ts.canHaveModifiers(node) && (ts.getModifiers(node) ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function exportModifier(node: ts.Node): ts.Modifier | undefined {
  if (!ts.canHaveModifiers(node)) return undefined;
  return (ts.getModifiers(node) ?? []).find((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

function declarationName(node: ts.Node): ts.Identifier | undefined {
  if (
    (ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isEnumDeclaration(node)) &&
    node.name
  ) {
    return node.name;
  }
  if (ts.isVariableStatement(node) && hasExportModifier(node)) {
    const [declaration] = node.declarationList.declarations;
    return declaration && ts.isIdentifier(declaration.name) ? declaration.name : undefined;
  }
  return undefined;
}

/**
 * What an unused exported symbol resolves to. `declaration` is an inline `export const/function/...`
 * whose `export` is a real modifier. `specifier` is a re-export entry — `export { x }`,
 * `export type { T }`, or `export { x } from "./m"` — where the `export` keyword belongs to the
 * ExportDeclaration syntax, not to any modifier, so the declaration scan never sees it.
 */
type ExportTarget =
  | { kind: "declaration"; node: ts.Node; name: ts.Identifier }
  | {
      kind: "specifier";
      statement: ts.ExportDeclaration;
      clause: ts.NamedExports;
      specifier: ts.ExportSpecifier;
    }
  | {
      // One name inside a destructured `export const { a, b } = expr`. The `export` keyword belongs
      // to the whole statement, so it cannot be stripped per-binding — the cleanup either drops just
      // this element from the pattern, or (when it is the last one) removes the whole statement.
      kind: "binding";
      statement: ts.VariableStatement;
      declarationList: ts.VariableDeclarationList;
      pattern: ts.ObjectBindingPattern;
      element: ts.BindingElement;
      name: ts.Identifier;
    };

/** Find a single unused name inside an exported object-destructuring statement. */
function findExportedObjectBinding(statement: ts.Node, name: string): ExportTarget | undefined {
  if (!ts.isVariableStatement(statement)) return undefined;
  for (const declaration of statement.declarationList.declarations) {
    const pattern = declaration.name;
    if (!ts.isObjectBindingPattern(pattern)) continue;
    const element = pattern.elements.find((el) => ts.isIdentifier(el.name) && el.name.text === name);
    if (element && ts.isIdentifier(element.name)) {
      return { kind: "binding", statement, declarationList: statement.declarationList, pattern, element, name: element.name };
    }
  }
  return undefined;
}

function findExportTarget(sourceFile: ts.SourceFile, name: string): ExportTarget | undefined {
  for (const statement of sourceFile.statements) {
    if (hasExportModifier(statement)) {
      const foundName = declarationName(statement);
      if (foundName?.text === name) return { kind: "declaration", node: statement, name: foundName };
      const binding = findExportedObjectBinding(statement, name);
      if (binding) return binding;
      continue;
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      // `element.name` is the EXPORTED identifier — for `export { local as exported }` that is
      // `exported`, which is exactly what knip reports as unused.
      const specifier = statement.exportClause.elements.find((element) => element.name.text === name);
      if (specifier) return { kind: "specifier", statement, clause: statement.exportClause, specifier };
    }
  }
  return undefined;
}

function hasIdentifierReference(sourceFile: ts.SourceFile, name: string, declaration: ts.Identifier): boolean {
  let referenced = false;
  const visit = (node: ts.Node): void => {
    if (referenced) return;
    if (node !== declaration && ts.isIdentifier(node) && node.text === name) {
      referenced = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return referenced;
}

function deletionSpan(sourceFile: ts.SourceFile, node: ts.Node): ts.TextSpan {
  const start = node.getFullStart();
  let length = node.getEnd() - start;
  const text = sourceFile.getFullText();
  while (text[start + length] === "\r" || text[start + length] === "\n") length++;
  return { start, length };
}

function removeExportChange(sourceFile: ts.SourceFile, node: ts.Node): ts.TextChange | undefined {
  const modifier = exportModifier(node);
  if (!modifier) return undefined;
  const text = sourceFile.getFullText();
  const start = modifier.getStart(sourceFile);
  let length = modifier.getEnd() - start;
  while (text[start + length] === " " || text[start + length] === "\t") length++;
  return { span: { start, length }, newText: "" };
}

/**
 * Drop one or more specifiers from a re-export. If every name is being removed the whole
 * `export { ... }` statement goes; otherwise the named-exports clause is rebuilt from the survivors
 * in a single replacement, which sidesteps the overlapping-comma surgery that per-specifier deletes
 * would need (and which `applyTextChanges` cannot apply once spans overlap). The underlying binding
 * is left untouched — a re-export only forwards it.
 */
function removeSpecifiersChange(
  sourceFile: ts.SourceFile,
  statement: ts.ExportDeclaration,
  clause: ts.NamedExports,
  remove: ReadonlySet<ts.ExportSpecifier>,
): ts.TextChange {
  const kept = clause.elements.filter((element) => !remove.has(element));
  if (kept.length === 0) {
    return { span: deletionSpan(sourceFile, statement), newText: "" };
  }
  const start = clause.getStart(sourceFile);
  return {
    span: { start, length: clause.getEnd() - start },
    newText: `{ ${kept.map((element) => element.getText(sourceFile)).join(", ")} }`,
  };
}

/**
 * Is this identifier a real value reference, as opposed to a NAME slot (a member name like
 * `obj.signIn`, an object-method/property key, or an import/export specifier)? Used to decide
 * whether dropping a destructured binding would strand a local user of that name.
 */
function isValueReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isQualifiedName(parent) && parent.right === node) return false;
  if (
    (ts.isPropertyAssignment(parent) ||
      ts.isMethodDeclaration(parent) ||
      ts.isPropertyDeclaration(parent) ||
      ts.isGetAccessorDeclaration(parent) ||
      ts.isSetAccessorDeclaration(parent) ||
      ts.isPropertySignature(parent) ||
      ts.isEnumMember(parent)) &&
    parent.name === node
  ) {
    return false;
  }
  // The property side of `{ key: local }` in a binding pattern, and import/export specifier slots.
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  return true;
}

/** Whether `name` is read anywhere in the file as a value, ignoring its own binding identifier. */
function isLocallyReferenced(sourceFile: ts.SourceFile, name: string, declaration: ts.Identifier): boolean {
  let referenced = false;
  const visit = (node: ts.Node): void => {
    if (referenced) return;
    if (node !== declaration && ts.isIdentifier(node) && node.text === name && isValueReference(node)) {
      referenced = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return referenced;
}

/**
 * Remove unused names from one destructured `export const { ... } = expr`. If every binding is
 * unused and it is the sole declaration, the whole statement goes; otherwise the object pattern is
 * rebuilt from the survivors in a single replacement (mirroring {@link removeSpecifiersChange}).
 */
function removeBindingsChange(
  sourceFile: ts.SourceFile,
  statement: ts.VariableStatement,
  declarationList: ts.VariableDeclarationList,
  pattern: ts.ObjectBindingPattern,
  remove: ReadonlySet<ts.BindingElement>,
): ts.TextChange {
  const kept = pattern.elements.filter((element) => !remove.has(element));
  if (kept.length === 0 && declarationList.declarations.length === 1) {
    return { span: deletionSpan(sourceFile, statement), newText: "" };
  }
  const start = pattern.getStart(sourceFile);
  return {
    span: { start, length: pattern.getEnd() - start },
    newText: `{ ${kept.map((element) => element.getText(sourceFile)).join(", ")} }`,
  };
}

type TextChangesResult = { ok: true; changes: ts.TextChange[] } | { ok: false; error: ApplyResult };

function unusedExportCleanupChanges(source: string, fileName: string, findings: { message: string }[]): TextChangesResult {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const changes: ts.TextChange[] = [];
  // Group re-export removals per statement so several unused names in one `export { a, b }` rebuild
  // the clause exactly once instead of fighting over the same commas.
  const specifierRemovals = new Map<ts.ExportDeclaration, { clause: ts.NamedExports; remove: Set<ts.ExportSpecifier> }>();
  // Group destructured-binding removals per pattern so several unused names in one
  // `export const { a, b, c } = expr` rebuild the pattern exactly once.
  const bindingRemovals = new Map<
    ts.ObjectBindingPattern,
    { statement: ts.VariableStatement; declarationList: ts.VariableDeclarationList; remove: Set<ts.BindingElement> }
  >();

  for (const finding of findings) {
    const name = symbolNameFromFindingMessage(finding.message);
    if (!name) {
      return { ok: false, error: unsupported(`Could not parse unused export name from finding: ${finding.message}`) };
    }
    const target = findExportTarget(sourceFile, name);
    if (!target) {
      return { ok: false, error: unsupported(`Could not find exported declaration for unused symbol: ${name}`) };
    }

    if (target.kind === "specifier") {
      const group = specifierRemovals.get(target.statement) ?? { clause: target.clause, remove: new Set<ts.ExportSpecifier>() };
      group.remove.add(target.specifier);
      specifierRemovals.set(target.statement, group);
      continue;
    }

    if (target.kind === "binding") {
      // A destructured `export const` cannot drop the `export` for one name only, so if the binding
      // is still read locally there is no safe deterministic edit — leave it for the AI track.
      if (isLocallyReferenced(sourceFile, name, target.name)) {
        return {
          ok: false,
          error: unsupported(`Unused export "${name}" is a destructured binding still referenced locally`),
        };
      }
      const group =
        bindingRemovals.get(target.pattern) ??
        ({ statement: target.statement, declarationList: target.declarationList, remove: new Set<ts.BindingElement>() } as const);
      group.remove.add(target.element);
      bindingRemovals.set(target.pattern, group);
      continue;
    }

    if (hasIdentifierReference(sourceFile, name, target.name)) {
      const change = removeExportChange(sourceFile, target.node);
      if (!change) {
        return { ok: false, error: unsupported(`Could not remove export modifier for unused symbol: ${name}`) };
      }
      changes.push(change);
    } else {
      changes.push({ span: deletionSpan(sourceFile, target.node), newText: "" });
    }
  }

  for (const [statement, { clause, remove }] of specifierRemovals) {
    changes.push(removeSpecifiersChange(sourceFile, statement, clause, remove));
  }

  for (const [pattern, { statement, declarationList, remove }] of bindingRemovals) {
    changes.push(removeBindingsChange(sourceFile, statement, declarationList, pattern, remove));
  }

  return { ok: true, changes };
}

function applyUnusedExportCleanup(cwd: string, unit: WorkUnit): ApplyResult {
  const files = [...new Set(unit.findings.map((finding) => finding.file))];
  for (const file of files) {
    const abs = join(cwd, file);
    if (!existsSync(abs)) {
      return {
        ok: false,
        reason: "session-error",
        detail: `Unused export file was missing: ${file}`,
      };
    }
    const result = unusedExportCleanupChanges(
      readFileSync(abs, "utf8"),
      abs,
      unit.findings.filter((finding) => finding.file === file),
    );
    if (!result.ok) return result.error;
    applyTextChanges(abs, result.changes);
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

async function applyStrategy(
  strategy: DeterministicRepairStrategy,
  cwd: string,
  unit: WorkUnit,
  run: PackageManagerRunner,
): Promise<ApplyResult> {
  switch (strategy) {
    case "deterministic-package-json-cleanup":
      return applyPackageJsonCleanup(cwd, unit, run);
    case "deterministic-unused-file-delete":
      return applyUnusedFileDelete(cwd, unit);
    case "deterministic-ts-unused-export-cleanup":
      return applyUnusedExportCleanup(cwd, unit);
    case "deterministic-ts-organize-imports":
      return organizeImports(cwd, unit.findings.map((finding) => finding.file));
    case "deterministic-eslint-fix":
      return applyEslint(cwd, unit);
  }
}

export function makeDeterministicFixer(deps: DeterministicFixUnitDeps): DeterministicFixer {
  const run = deps.runPackageManager ?? defaultPackageManagerRun;
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

      // A package.json cleanup also rewrites the shared lockfile; own it in the snapshot so a gate
      // revert restores it alongside the package.json (otherwise a regenerated lockfile would leak).
      const ownedFiles = [...unit.files];
      if (strategies.includes("deterministic-package-json-cleanup")) {
        const lock = lockfileIn(deps.cwd);
        if (lock && !ownedFiles.includes(lock)) ownedFiles.push(lock);
      }
      const before = snapshotUnitFiles(deps.cwd, ownedFiles);
      // Baseline findings already in the verification scope, so the gate's anti-regression
      // doesn't blame this fix for pre-existing cross-file (jscpd) duplicates it never touched.
      const verificationTargets = unit.verificationTargets ?? unit.files;
      const scannerTools = [...new Set(unit.findings.map((finding) => finding.tool))];
      const preexistingIds = new Set((await deps.scanFindings(verificationTargets, scannerTools)).map((f) => f.id));
      for (const strategy of strategies) {
        const applied = await applyStrategy(strategy, deps.cwd, unit, run);
        if (!applied.ok) {
          restoreSnapshot(deps.cwd, before);
          return {
            kept: false,
            reason: applied.reason,
            detail: applied.detail,
            failureClass: applied.failureClass,
            usage: ZERO_AI_USAGE,
          };
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
