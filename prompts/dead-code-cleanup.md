# Dead-code cleanup task

A `knip` `unused-export`/`unused-type` finding means the export is unnecessary, NOT that the
symbol is dead. A symbol is still live if it's reached dynamically — public API, reflection/DI,
config-loaded, or non-static imports — even when knip reports it unused; never delete those.
Otherwise check the contents below for in-file references:

- Referenced in-file → remove only the `export` keyword (and any re-export/barrel entry); keep
  the declaration. Deleting it would break typecheck.
- Zero in-file references → delete the whole declaration (and its re-export). For an unused
  `default` export still used in-file, drop the `default export` modifiers and keep the binding.
- When unsure a reference exists, prefer dropping the `export` over deleting.

<file_contents>
{{fileContents}}
</file_contents>

<findings>
{{findings}}
</findings>

<editable_files>
{{editableFiles}}
</editable_files>

Done when these verification targets no longer report the dead-code findings:
<verification_targets>
{{verificationTargets}}
</verification_targets>
