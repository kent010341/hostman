# Advanced usage and troubleshooting

See the [README](../README.md) for installation, quick starts, and common tasks.

## Initialization and migration

`init` creates an empty managed section. Repeated runs preserve existing state without writing. It does not
import rules or create a global `local` target. Conflicting managed documents require repair first.
In an interactive terminal, `init` suggests commands to import existing rules, create a mapping, or open the guided
menu. Repeated runs also provide suggestions. Suggested commands retain the custom `--hosts-file` path.

`migrate` scans current unmanaged effective and commented rules on every run. Without selection flags it previews
candidates, collects selections and target names, shows a final summary, and confirms the move. A missing managed
section is created only during an actual import.
No eligible rules means no changes.

```sh
hostman migrate --dry-run
hostman migrate --group foo.test --group bar.test
hostman migrate --all
hostman migrate --all --global local
```

`--group` is repeatable and mutually exclusive with `--all`. Dry runs never prompt, write, or request elevation.
Repeated migration with no new eligible rules makes no changes.

Grouping uses the final two labels: `api.foo.test` belongs to `foo.test`. Public Suffix List handling is outside
v1; `example.co.uk` groups under `co.uk`.

| Candidate | Result |
| --- | --- |
| New group, one effective IP | Reuse globals or create literal targets; enable and select the effective IP |
| New group, only commented rules | Reuse globals or create literal targets; keep the group disabled |
| Existing enabled group, matching effective IP or commented-only input | Merge hosts and missing targets; retain state |
| Existing disabled group, commented-only input | Merge hosts and missing targets; remain disabled |
| Multiple effective IPs, mismatched active IP, or effective input for a disabled group | Skip the whole group |
| Managed structural/effective conflicts or ownership by another group | Skip |
| Repeated aliases, including compatible aliases already owned by this group | Deduplicate and absorb outside rules |

After optional indentation or a BOM, remove exactly one leading `#` to recognize a commented hosts rule.
`#127.0.0.1 my.dev`, `# 127.0.0.1 my.dev`, and `#       127.0.0.1 my.dev` qualify; `## 127.0.0.1 my.dev`
does not. Ordinary comments, single-label names, IP-like names, and standard localhost aliases stay unmanaged.
Commented rules do not count as effective mappings or unmanaged hostname collisions. IPv6 comparison is semantic.

Each candidate contains the hostname union and one target per semantic IP, even when each IP originally had
different aliases. All enabled aliases use the selected active IP; migration does not preserve per-host IPs.
New literal target defaults follow IP first occurrence: `imported`, `imported-2`, and so on, avoiding occupied names.
In every interactive import, including `--all` and `--group`, each newly created target has a naming prompt.
Press Enter to accept the default. Scripts and dry runs use default names without prompting. Names must be
unique in the group and start with a letter or number, followed by letters, numbers, underscores or hyphens.
Renaming an earlier target can change the next available default. Final summaries show the accepted names.

Disabled new groups retain the first imported destination, including a global, for a later `enable`. Migration previews
and summaries show `active: none (disabled)` and `enable selects: <target>`; `show` reports the stored active
selection and its IP together with the disabled flag. There are no effective mappings while disabled.

Existing groups retain enabled state, active selection, target names and IPs. Matching IPs reuse the active
selection first, including a direct global selection, then the first matching group target. New destinations
reuse matching globals before creating literal group targets. Matching uses semantic IP comparison, including
equivalent IPv6 spellings. Migration does not clean or remove existing group targets.
One matching global is selected automatically. Multiple matching globals require an interactive selection or
repeatable `--global <name>` flags, one per ambiguous IP. The same new IP shares a choice across selected groups.
Scripts fail before writing if a choice is missing. Dry runs list matching names and mark unresolved choices
as pending rather than inventing an active selection. Flags naming unrelated globals or conflicting choices
for the same semantic IP are rejected. Reused globals do not prompt for a new literal target name.
Compatible outside duplicates owned by the same group can be absorbed without bypassing other validation.
Skip diagnostics identify source line numbers, aliases, outside IPs and the managed active IP or disabled state.
Edit conflicting outside rules before retrying; `repair` is for damaged managed blocks, not outside rules.

Every preview group occupies its own multi-line READY or SKIP block, separated by a blank line. READY blocks
and final summaries list targets and hostnames on separate lines, followed by active state. SKIP blocks show
the reason first, then the original source rules in line-number order with each line's aliases combined, and
a suggested action. They omit proposed target names, active state and enable selection because no import
will take place for that group. Formatting is the same in interactive terminals, dry runs and scripts.

Selected hostname tokens move into management in one transaction. Unselected aliases retain their IP, spacing,
comment prefix and inline comments. If every alias on a line is imported, its inline comment remains separately.

## Cleaning destinations

```sh
hostman target clean example.com --dry-run
hostman target clean example.com --global local --keep example.com=lab
hostman global clean --dry-run
hostman global clean --keep local --keep ipv6
```

`target clean [group]` cleans one group's definitions. There is no `--all` option. Omit the group in an interactive
terminal to choose it; scripts and dry runs require an explicit group. It removes all literal targets whose IP
matches a global. If the active literal is removed, its selection becomes `@global-name`. An existing direct
global selection is preserved, including when other globals have the same IP; matching local definitions are
removed without choosing a different global. A unique global match needs no prompt. Otherwise use repeatable
`--global <name>` flags or select a name interactively; scripts reject unresolved global ambiguity.

For each remaining duplicated local IP, cleanup keeps one local definition. Repeatable `--keep <group=target>`
flags select the retained names. Without an override, terminals ask which name to keep, defaulting to the active
target or the first source definition; scripts use that default without prompting. If a different local name is
retained, the active selection redirects to it without changing its destination IP. Literal target names are
serialized in their existing canonical name order, so the first-source default refers to the current file.

`global clean` considers duplicate semantic IPs only within the global namespace. Each duplicate IP requires
one retained name, selected interactively or supplied through repeatable `--keep <name>` flags. Scripts must
explicitly cover every duplicate IP. Other names for that IP are removed, and every direct active selection of
a removed name is redirected to the retained global, including disabled groups. Group-owned targets are never
removed by global cleanup. Nonduplicated globals retain their definitions and order.

Both commands preserve enabled state, hostnames and semantic destination IPs. Removing local definitions in
favor of a global means future global IP updates now apply to that group. Unknown, unrelated, malformed or
contradictory retention choices fail before writing. All prompts finish before one digest-checked transaction;
cancelling any prompt preserves the source bytes. Structural conflicts block cleanup; group conflicts block
operations that rewrite those groups. Unrelated group conflicts remain isolated.

Dry runs never prompt, write or elevate. They show destination candidates, known selections and pending choices;
global previews also list direct consumer groups and their current selections. Complete previews validate their
affected scope. Execution summaries list removed and retained definitions and active redirects. Clean no-ops and
repeated cleanup without explicit obsolete flags make no byte changes. Valid manual hostname additions survive
when a changed group is serialized. No matching or duplicate destinations means no changes.

## Groups and targets

Each hostname belongs to exactly one group and cannot also occur in unmanaged effective rules. All enabled
hosts in a group use its active target's IP. Disabled groups retain definitions without effective rules.

Target names are arbitrary: `local`, `lab`, and `prod` have no special runtime meaning. Group targets contain
literal IPs only. `hostman use example.com local` selects the group's `local` target, while
`hostman use example.com '@local'` directly selects the global named `local`, without creating a group target.
The interactive Switch target menu lists group targets first, then all global targets, showing source and IP.
Changing a global IP updates enabled groups selecting it. Disabled groups retain their selection and use the
latest IP when enabled. A global selected by any group, including a disabled group, cannot be removed.
Active group targets cannot be removed; switch to another group or global target first.

Interactive `remove host` selects an omitted hostname from the selected group's full hostname list, including
the root and disabled-group hostnames. Interactive `target set/remove` and `global set/remove` select omitted
existing target names from their own scope, displaying names and IPs in definition order. Group operations
select an omitted group first. Explicit arguments bypass selection and retain domain validation; scripts
must supply complete arguments. Creation names and replacement names remain text inputs.
Removal choices disable active group targets and globals selected by any group, including disabled groups,
and show the reason or referencing group names. Empty lists and entirely protected lists report an actionable
error without opening a selection prompt. Cancellation leaves the source unchanged; all prompts finish before
the normal validated transaction begins.

`target rename [group] [target] [new-name]` renames a literal target within its group.
It preserves the destination, enabled state and hostnames, updating the stored active selection
if it names that target. `global rename [target] [new-name]` renames a shared definition and updates every
direct `active=@name` selection, including disabled groups, without renaming group-owned targets or changing IPs.
Both commands appear in the guided menu. Interactive terminals select omitted existing targets from a list
and prompt for the new name; group renames first select an omitted group. Explicit arguments skip their prompts.
An empty target list reports an actionable error. Scripts must supply all arguments.
Names start with a letter or number and contain only letters, numbers,
underscores or hyphens. Unknown targets, invalid names and names already used in the relevant scope are rejected.
Renaming to the current name is byte-stable for clean state. Affected conflicts block renames; valid manual
hostname additions survive and affected group digests are refreshed. Writes use the normal transaction protocol.

When creating a group, repeat `--target name=value` and `--host hostname` as needed. The first initial target
is active unless `--active <name>` is specified. Omitting `--host` includes the group root hostname by default.
Explicit `--host` options define the complete initial hostname list; use `@` to include the root.
`--disabled` creates the group without effective rules. `--active '@local'` selects a global directly;
when no `--target` options are supplied, it creates a group with no group-owned targets and skips the initial
target prompt. An empty target list is valid only when the active selection resolves to an existing global.
For example: `hostman add group example.com --active '@local' --host '@' --host api`.
Without `--target` or `--active`, interactive creation lists globals in source definition order with their IPs,
defaulting to the first global. The final choice, `Enter a new group target`, opens the literal name prompt
(default `local`) followed by IP selection/input. With no globals, manual entry is the only choice. Selecting
a global stores `active=@name`, creates no local definitions, and skips name/IP prompts. Explicit destination
flags bypass this initial menu; scripts must provide destinations. Cancellation leaves the source unchanged.
The destination menu and commit share a source snapshot; intervening edits invalidate its transaction digest.
`target add/set` and `--target name=value` reject global references; supply a literal IP instead.

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
# >>> group foo.test enabled=true active=@local hash=<digest>
127.0.0.1 api.foo.test
# <<< group foo.test
# <<< hostman
```

`<digest>` is illustrative; the serializer supplies the value. A mismatched digest alone means DIRTY.
Valid manually added hosts matching the active IP survive the next mutation of their group. Untouched blocks
remain unchanged.
