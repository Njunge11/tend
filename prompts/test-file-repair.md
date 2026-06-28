# Test-file repair task

Fix the findings in test code. Keep every test as strict — a changed test must still fail against
the old broken code. Fix the test's own defect, not production behavior.

<file_contents>
{{fileContents}}
</file_contents>

<findings>
{{findings}}
</findings>

<editable_files>
{{editableFiles}}
</editable_files>

Done when these verification targets no longer report the findings:
<verification_targets>
{{verificationTargets}}
</verification_targets>
