# Manual migration checks

These checks cover commented rules, multiple targets, conflicts, naming and source preservation.
Run commands in an interactive terminal so target naming prompts are available. Press Enter for defaults
unless a case asks for a custom name. Use fresh test group names if these groups already exist.

## Prepare the CLI and source

For a linked development installation, run from the project directory:

```powershell
npm run build
npm link
hostman --help
```

Rebuild after TypeScript changes; a linked command executes the compiled output. Alternatively, replace
`hostman` in every command below with `node .\dist\cli\index.js` from the project directory.

Before editing the Windows system hosts file, make a backup in PowerShell:

```powershell
$hostmanSource = Join-Path $env:SystemRoot 'System32\drivers\etc\hosts'
$hostmanBackup = Join-Path $env:TEMP ('hosts-before-migration-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
Copy-Item -LiteralPath $hostmanSource -Destination $hostmanBackup
$hostmanBackup
```

Open that hosts file with an editor that can save it. Add the supplied rules outside the
`# >>> hostman v1` / `# <<< hostman` section. Keep the backup path for recovery. On Unix, back up and edit
`/etc/hosts` using the appropriate permissions for your machine.

For an isolated custom-file alternative, create a disposable source in PowerShell:

```powershell
Set-Content -LiteralPath .\migration.hosts -Value '127.0.0.1 localhost' -Encoding utf8
$hostmanSource = (Resolve-Path .\migration.hosts).Path
```

Then replace **every** `hostman` invocation below with `hostman --hosts-file "$hostmanSource"`, for example:

```powershell
hostman --hosts-file "$hostmanSource" migrate --dry-run
hostman --hosts-file "$hostmanSource" migrate --group commentcase.test
hostman --hosts-file "$hostmanSource" show commentcase.test
```

A writable custom file needs no elevation. The system file may request elevation only when an actual write
needs additional permissions. Dry runs never prompt for names or request elevation. No `init` is needed before
the first actual migration. Other mutations, such as `add group`, require an initialized section.

## 1. Single comment marker and disabled targets

Append these rules:

```text
#10.12.34.56 www.commentcase.test
# 10.12.34.56 api.commentcase.test
#       127.0.0.1 www.commentcase.test
# 127.0.0.1 api.commentcase.test
```

Run:

```powershell
hostman migrate --dry-run
hostman migrate --group commentcase.test
hostman show commentcase.test
```

Accept both default names. Expect two targets: `imported=10.12.34.56` and `imported-2=127.0.0.1`, with exactly
two hosts, `www.commentcase.test` and `api.commentcase.test`. The preview and final summary show
`active: none (disabled); enable selects: imported`. `show` reports `disabled active=imported ip=10.12.34.56 CLEAN`.
There must be no ordinary effective mappings for these aliases. The stored active selection is for a later
`enable`, not an effective IP while disabled.

## 2. Unique effective IP and hostname union

Append:

```text
# 10.12.34.56 www.unioncase.test
#10.12.34.56 iam.unioncase.test
#       10.12.34.56 iot.unioncase.test
# 127.0.0.1 www.unioncase.test
# 127.0.0.1 iam.unioncase.test
10.11.22.33 foo.unioncase.test
```

Run:

```powershell
hostman migrate --dry-run
hostman migrate --group unioncase.test
hostman show unioncase.test
```

Accept all defaults. Expect three targets, four hosts (`www`, `iam`, `iot`, `foo`) and
`enabled active=imported-3 ip=10.11.22.33 CLEAN`. All four managed effective mappings use `10.11.22.33`.
No per-host IP overrides remain. The other IPs are available targets without effective mappings.

## 3. Double comment marker and ordinary comments are excluded

Append:

```text
## 127.0.0.1 www.ignoredcase.test
# This is a note about www.ignoredcase.test
```

Run:

```powershell
hostman migrate --dry-run
hostman migrate --group ignoredcase.test
```

Expect no candidate for `ignoredcase.test`. The explicit import fails with
`No candidate or managed group ignoredcase.test.` Both source lines remain unchanged, and no group is created.
Removing one `#` from the first line still leaves a comment, so it is not a commented hosts rule candidate.

## 4. Multiple effective IPs are skipped

Append:

```text
192.0.2.10 www.conflictcase.test
192.0.2.20 api.conflictcase.test
```

Run:

```powershell
hostman migrate --dry-run
hostman migrate --group conflictcase.test
```

Expect a whole-group `SKIP`, with both source line numbers, IPs and hostnames, even though the hosts differ.
There are no naming prompts, no new group and no file changes. The CLI reports `No eligible imports; no changes.`
To make this eligible manually, comment out the second rule with one `#`, preview again, and retry the import.
The group should then have two targets and both aliases should use the only effective IP, `192.0.2.10`.
Alternatively, leave the conflict in place and remove these outside rules during cleanup.

## 5. Existing group: compatible merge and incompatible active IP

After case 1 has created the managed section, create a dedicated group:

```powershell
hostman add group existingcase.test --target lab=10.11.22.33 --host www
```

Append outside the markers:

```text
10.11.22.33 www.existingcase.test api.existingcase.test
# 192.0.2.50 www.existingcase.test iot.existingcase.test
```

Run:

```powershell
hostman migrate --dry-run
hostman migrate --group existingcase.test
hostman show existingcase.test
```

The preview may report that `www.existingcase.test` also exists outside hostman. This compatible duplicate
must not mark the candidate SKIP. Accept the one new target's default. Expect the existing `lab` active target
and enabled state to remain, one new target for `192.0.2.50`, three unique hosts and `CLEAN` status.
Both outside rules are absorbed; all three managed aliases use `10.11.22.33`.

Now append an incompatible effective rule:

```text
192.0.2.99 www.existingcase.test
```

Run the same three commands. Expect SKIP with the source line, `www.existingcase.test`, `192.0.2.99` and managed
active IP `10.11.22.33`. The import leaves the source unchanged. `show` can report `CONFLICT` because the external
duplicate remains. Manually change that outside IP to `10.11.22.33`, then preview and import again: the redundant
rule should be absorbed and the group should return to `CLEAN` without changing its targets or active selection.
`repair` does not remove conflicting outside rules.

## 6. Naming, partial alias preservation and repeatability

Append:

```text
  #       192.0.2.60 www.preservecase.test other.keepcase.test  # keep this inline note
#127.0.0.1 api.preservecase.test # retain this standalone note
```

Run:

```powershell
hostman migrate --dry-run
hostman migrate --group preservecase.test
hostman show preservecase.test
```

At the naming prompt for `192.0.2.60`, enter `lab`. At the prompt for `127.0.0.1`, press Enter. Since `imported`
is still available, the second target defaults to `imported`. Expect a disabled group with targets
`lab=192.0.2.60` and `imported=127.0.0.1`; `lab` remains the preselected target because its IP appeared first.
The final summary uses these accepted names. Targets and hosts in serialized blocks may appear sorted.

Inspect the original lines. The remaining alias line must still start with its original indentation and
`#       192.0.2.60`, retain `other.keepcase.test` and `# keep this inline note`, and remain commented.
The second line's `# retain this standalone note` survives as a separate comment. `keepcase.test` remains an
unselected candidate. Do not use `--all` for this case because it would also import that group.

Verify byte stability:

```powershell
$hostmanBefore = (Get-FileHash -LiteralPath $hostmanSource -Algorithm SHA256).Hash
hostman migrate --group preservecase.test
$hostmanAfter = (Get-FileHash -LiteralPath $hostmanSource -Algorithm SHA256).Hash
$hostmanBefore -eq $hostmanAfter
```

Expect `No eligible imports; no changes.` and `True`. To check cancellation, add a new commented IP for this
group, run its import and press Ctrl+C at the naming prompt. The newly added source line must remain unchanged.

## Cleanup

Remove the successfully imported test groups using the same source selection as above:

```powershell
hostman remove group commentcase.test
hostman remove group unioncase.test
hostman remove group existingcase.test
hostman remove group preservecase.test
```

If you imported `conflictcase.test` after resolving its conflict, remove it too. Manually remove the outside
rules for `ignoredcase.test`, any remaining `conflictcase.test` rules, `other.keepcase.test`, the cancellation
rule if added, and the test notes. Do not remove unrelated managed groups or markers. For a disposable custom
file, delete that file after testing. Restore the original backup only if you intend to discard all changes
made since it was taken.
