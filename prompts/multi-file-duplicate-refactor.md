# Cross-file duplicate refactor task

Remove the jscpd duplicate code from EVERY clone site (each finding's `flowPath` gives the
regions) — editing only one site leaves the finding standing. State the clone type, then extract:

- Exact clone → move the shared logic to one file, export it, import it in the other.
- Renamed/parameterized → extract a function taking the varying parts as parameters.
- Gapped → extract the shared core; pass the varying parts as a callback or options.

If an empty shared-module path is listed as editable, you may create it and put the extracted
function there. If the clones differ too much for a clean shared function, make one file the
canonical owner and import from it — don't add boolean/mode flags to bridge callers. For test
clones, extract a simple factory helper. Delete a clone only if it is provably dead code.

<file_contents>
{{fileContents}}
</file_contents>

<findings>
{{findings}}
</findings>

<editable_files>
{{editableFiles}}
</editable_files>

Example — `a.ts` and `b.ts` both reduce over different field names; extract once and import:
<example>
export function sumLineItems(lines: { price: number; qty: number }[]) {
  return lines.reduce((s, l) => s + l.price * l.qty, 0);
}
</example>

Done when the duplication is gone from these verification targets and imports/exports stay valid:
<verification_targets>
{{verificationTargets}}
</verification_targets>
