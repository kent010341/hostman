# Advanced usage and troubleshooting

See the [README](../README.md) for installation, quick starts, and common tasks.

## Initialization and migration

`init` creates an empty managed section. Repeated runs preserve existing state without writing. It does not
import rules or create a global `local` target. Conflicting managed documents require repair first.
In an interactive terminal, `init` suggests commands to import existing rules, create a mapping, or open the guided
menu. Repeated runs also provide suggestions. Suggested commands retain the custom `--hosts-file` path.

`migrate` scans current unmanaged effective rules on every run. Without selection flags it previews candidates,
collects selections, and confirms the move. A missing managed section is created only during an actual import.
No eligible rules means no changes.

```sh
hostman migrate --dry-run
hostman migrate --group foo.test --group bar.test
hostman migrate --all
```

`--group` is repeatable and mutually exclusive with `--all`. Dry runs never prompt, write, or request elevation.
Repeated migration with no new eligible rules makes no changes.

Grouping uses the final two labels: `api.foo.test` belongs to `foo.test`. Public Suffix List handling is outside
v1; `example.co.uk` groups under `co.uk`.

| Candidate | Result |
| --- | --- |
| New group, one IP | Enabled group with active group-owned target `imported` |
| Existing enabled group, matching active IP | Add hosts; retain targets |
| Multiple IPs or mismatched active IP | Skip the whole candidate group |
| Disabled or conflicted group | Skip |
| Duplicate hostname or existing ownership | Skip |

Skip reasons appear in the preview. Comments, disabled rules, single-label names, IP-like names, and standard
localhost aliases stay unmanaged. IPv6 comparison is semantic. Migration does not switch targets or change
existing target IPs.

Selected hostname tokens move into management in one transaction. Unselected aliases retain their IP and
comments. If every alias on a line is imported, its inline comment remains separately.

## Groups and targets

Each hostname belongs to exactly one group and cannot also occur in unmanaged effective rules. All enabled
hosts in a group use its active target's IP. Disabled groups retain definitions without effective rules.

Target names are arbitrary: `local`, `lab`, and `prod` have no special runtime meaning. `@local` explicitly
references a global target named `local`. Changing its IP updates enabled groups actively using it.
Referenced globals and active group targets cannot be removed.

When creating a group, repeat `--target name=value` and `--host hostname` as needed. The first initial target
is active unless `--active <name>` is specified. Omitting `--host` includes the group root hostname by default.
Explicit `--host` options define the complete initial hostname list; use `@` to include the root.
`--disabled` creates the group without effective rules.

If an older version created an empty group, add its root with `hostman add host <group> @`.

## Source files and permissions

The source file must already exist and use ASCII or UTF-8, optionally with a BOM. UTF-16 is rejected.
Relative custom paths resolve against the original working directory. If Windows `SystemRoot` is missing,
specify `--hosts-file <path>` explicitly.

Windows writes and elevation use built-in Windows PowerShell 5.1. Unix elevation uses `/usr/bin/sudo`.
Reading, help, dry runs, no-op operations, and writable custom files do not require elevation.

Automatic elevation requires stdin and stdout to be terminals. `--no-elevate` disables it. For scripts, supply
complete arguments and run with sufficient permissions. Cancelled or denied elevation leaves hosts unchanged.

On Windows, open PowerShell using **Run as administrator**. If a per-user npm command is unavailable under
that account, use the actual absolute paths to Node and the installed entry:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\path\to\hostman\dist\cli\index.js' migrate --all
```

On Unix, avoid relying on root's npm prefix:

```sh
sudo /absolute/path/to/node /absolute/path/to/hostman/dist/cli/index.js migrate --all
```

An elevated process reports remaining permission errors without another elevation attempt. Read-only
attributes, execution policy, or filesystem restrictions may still prevent writing. Hostman does not bypass
system policy or use an in-place truncation fallback.

If hosts changes while an operation or elevation request is pending, reload and retry. For lock contention,
wait for the other writer. Remove a stale `.hostman.lock` only after verifying that no writer is running.

## Manual edits and repair

`show <group>` reports one of these states:

| State | Meaning |
| --- | --- |
| CLEAN | Definitions, digest, and effective rules agree |
| DIRTY | Valid manual changes; preserved when the group is next modified |
| CONFLICT | Ambiguous or invalid rules requiring repair |

Conflicts include mixed IPs, missing references, duplicate ownership, malformed markers, and invalid hosts.
Mutations reject affected conflicts; structural document conflicts block all writes. Valid groups remain
inspectable when another group is broken.

```sh
hostman repair foo.test
hostman repair foo.test --strategy restore
hostman repair foo.test --strategy keep
```

`restore` regenerates rules from the configured target. `keep` updates a group-owned active target to one
unambiguous effective IP. Shared globals require explicit repair; `keep` never silently changes other groups.
Structural conflicts require manual correction. Repair never invents target names.

## Hosts format

One pair of outer markers contains global definitions and group blocks. Targets and disabled hosts are stored
in comments; enabled hosts use normal rules. Group markers include an eight-character semantic SHA-256 digest.

```text
# >>> hostman v1
# global local=127.0.0.1
# >>> group foo.test enabled=true active=local hash=<digest>
# target local=@local
127.0.0.1 api.foo.test
# <<< group foo.test
# <<< hostman
```

`<digest>` is illustrative; the serializer supplies the value. A mismatched digest alone means DIRTY.
Valid manually added hosts matching the active IP survive the next mutation of their group. Untouched blocks
remain unchanged.
