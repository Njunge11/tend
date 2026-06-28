# Generated-source repair task

The finding is in a generated artifact that is rebuilt from source. Fix the source owner, never a
generated file under `dist`/`build`/`out`/`.next` or generated client output — the build
overwrites those.

<file_contents>
{{fileContents}}
</file_contents>

<findings>
{{findings}}
</findings>

<editable_files>
{{editableFiles}}
</editable_files>

Done when, after the build regenerates the artifact, these verification targets no longer report
the findings:
<verification_targets>
{{verificationTargets}}
</verification_targets>
