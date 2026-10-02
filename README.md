# hostman

Hostman manages grouped hostnames and switches them between named targets. The selected hosts file is the sole source of truth: reinstalling hostman requires no database or project metadata.

## Build and install

Requirements: Node.js 24 or newer and npm. Windows, Linux, and macOS are supported. Windows writes and UAC elevation use built-in Windows PowerShell 5.1; Unix elevation uses `/usr/bin/sudo`.

From a source checkout (these npm commands also work in PowerShell):

```sh
git clone https://github.com/kent010341/hostman.git
cd hostman
npm ci
npm run build
npm test
npm link
hostman --help
```

`npm link` points the command to this checkout; rebuild after editing TypeScript. Installation permissions depend on your npm global prefix. Installing hostman and editing system hosts are separate operations.

For an independent installation:

```sh
npm pack
npm install --global ./hostman-1.0.0.tgz
hostman --help
```

The package includes the compiled CLI, domain engine, and privilege helpers. The destination machine also needs Node.js. Remove either installation with `npm uninstall --global hostman`. `npm run smoke:package` checks linked and packed installation in isolated temporary prefixes.

## Select a hosts file

| Platform | Default |
| --- | --- |
| Windows | `$env:SystemRoot\System32\drivers\etc\hosts` |
| Linux/macOS | `/etc/hosts` |

Every command accepts `--hosts-file <path>`. Relative paths resolve against the original working directory. If Windows `SystemRoot` is missing, specify the source explicitly. The file must already exist and use ASCII or UTF-8, optionally with a BOM. UTF-16 is rejected.

Try a disposable file first. PowerShell:

```powershell
Set-Content -LiteralPath '.\sample hosts' -Value '10.20.0.10 api.foo.test' -Encoding utf8
hostman --hosts-file '.\sample hosts' migrate --dry-run
hostman --hosts-file '.\sample hosts' migrate --group foo.test
hostman --hosts-file '.\sample hosts' show all
```

Unix:

```sh
printf '10.20.0.10 api.foo.test\n' > './sample hosts'
hostman --hosts-file './sample hosts' migrate --dry-run
hostman --hosts-file './sample hosts' migrate --group foo.test
hostman --hosts-file './sample hosts' show all
```

## Permissions and elevation

Reading, help, dry runs, and no-op operations never request elevation. Writable custom files work without administrator privileges.

Hostman first attempts a normal transactional write. If permissions deny it in an interactive terminal (stdin and stdout are both terminals), it explains the requirement and elevates only the commit helper:

- Windows displays the operating system's UAC dialog.
- Linux/macOS runs the helper through `sudo`, which may request your password.

Selections finish before elevation. The helper receives the resolved source path and approved operation. It verifies the request hash, original source hash, domain validation, and expected result hash. A source change while authentication is pending cancels the commit.

Cancelling or denying elevation leaves hosts unchanged. No credentials are stored, and elevation is not retried indefinitely. `--no-elevate` disables automatic elevation. Non-interactive processes never launch UAC or `sudo`; run them with sufficient privileges.

On Windows, open PowerShell using **Run as administrator**. If the npm command is unavailable under that account, invoke the installed entry with actual absolute paths:

```powershell
& 'C:\Program Files\nodejs\node.exe' 'C:\path\to\hostman\dist\cli\index.js' --hosts-file 'C:\Windows\System32\drivers\etc\hosts' migrate --all
```

On Unix, use actual absolute Node and entry paths, avoiding root's npm prefix:

```sh
sudo /absolute/path/to/node /absolute/path/to/hostman/dist/cli/index.js --hosts-file /etc/hosts migrate --all
```

An elevated process reports remaining permission errors without another elevation attempt. Read-only attributes, execution policy, and filesystem restrictions may still prevent writes. Hostman does not bypass system policy or truncate the live file as a fallback.

## Initialization and migration

`hostman init` appends an empty managed section when absent. Repeated runs preserve existing state without writing. It does not import rules or create a global `local` target. Conflicting managed documents must be repaired first.

`hostman migrate` scans current unmanaged effective rules every time. Without selection flags it previews candidates, collects selections, and confirms the move. Explicit selections work in scripts:

```sh
hostman migrate --dry-run
hostman migrate --group foo.test --group bar.test
hostman migrate --all
```

`--group` and `--all` are mutually exclusive. Dry runs never prompt or write. A missing managed section is created only as part of an actual import. No eligible rules means no changes.

Grouping uses the final two labels: `api.foo.test` belongs to `foo.test`. Public Suffix List handling is outside v1; `example.co.uk` groups under `co.uk`.

| Candidate | Result |
| --- | --- |
| New group, one IP | Enabled group with active group-owned target `imported` |
| Existing enabled group, matching active IP | Add hostnames; retain targets |
| Multiple IPs or mismatched active IP | Skip the whole candidate group |
| Disabled/conflicted group | Skip |
| Duplicate hostname or existing ownership | Skip |

Skip reasons appear in the preview. Comments, disabled rules, single-label names, IP-like names, and standard localhost aliases stay unmanaged. IPv6 comparison is semantic.

Selected hostname tokens move into management in one transaction. Unselected aliases retain their IP and comments. When all aliases on a line are imported, the inline comment remains separately. Unrelated lines remain byte-for-byte unchanged.

Rerun migration after manually adding eligible rules outside the markers. An unchanged file produces no diff. Migration never invents environment names, switches targets, or changes existing target IPs.

## Commands

Every command and nested command supports `-h` and `--help`, even with an inaccessible source. Running `hostman` in a terminal opens a menu; without a terminal it shows help. Missing command inputs prompt in a terminal and fail clearly in scripts.

```text
hostman init
hostman migrate [--group <group> ... | --all] [--dry-run]
hostman show [active | all | <group>]
hostman add group [group] --target <name=value> ... [--active <name>] [--host <host> ...] [--disabled]
hostman remove group [group]
hostman add host [group] [hostname]
hostman remove host [group] [hostname]
hostman enable [group]
hostman disable [group]
hostman use [group] [target]
hostman target add [group] [target] [IP-or-@global]
hostman target set [group] [target] [IP-or-@global]
hostman target remove [group] [target]
hostman global add [target] [IP]
hostman global set [target] [IP]
hostman global remove [target]
hostman repair [group] [--strategy restore|keep]
```

`show` defaults to enabled groups; `show all` includes disabled groups. Details include targets, hosts, effective IP, status, and conflicts. Valid groups remain inspectable when another is broken.

Example lifecycle:

```sh
hostman init
hostman global add local 127.0.0.1
hostman add group foo.test --target local=@local --target prod=10.20.0.10 --active local --host @ --host api
hostman target add foo.test lab 10.30.0.10
hostman use foo.test lab
hostman add host foo.test admin
hostman disable foo.test
hostman enable foo.test
hostman show foo.test
```

Target names are arbitrary; `local` has no special runtime meaning. `@local` explicitly references a global. Changing a global IP regenerates enabled groups actively using it. Removing a referenced global or an active group target is rejected.

Host inputs accept `@` for the root, a short subdomain such as `api`, or a full hostname belonging to the group. Each host belongs to exactly one group and cannot also appear in unmanaged effective rules. Disabled groups retain definitions but emit no effective rules.

## File format and manual edits

One pair of outer markers contains global definitions and group blocks. Targets and disabled hosts are stored in comments; enabled hosts use normal rules. Group markers include an eight-character semantic SHA-256 digest.

```text
# >>> hostman v1
# global local=127.0.0.1
# >>> group foo.test enabled=true active=local hash=<digest>
# target local=@local
127.0.0.1 api.foo.test
# <<< group foo.test
# <<< hostman
```

`<digest>` is illustrative; the serializer supplies the value. A mismatched digest alone means DIRTY. A valid manually added host matching the active IP survives the next mutation of its group. Untouched blocks remain unchanged.

Conflicts include mixed effective IPs, missing references, duplicate ownership, malformed markers, and invalid hosts. Mutations reject affected conflicts; structural document conflicts block all writes.

Use `hostman repair foo.test` for effective-IP conflicts. `--strategy restore` regenerates from the configured target. `--strategy keep` updates a group-owned active target to one unambiguous effective IP. Shared globals require explicit repair; `keep` never silently changes other groups. Structural conflicts require manual correction. Repair never invents target names.

## Write guarantees and tests

Code quality uses ESLint with type-aware TypeScript checks. JavaScript and TypeScript use four-space indentation,
a strict 120-character line limit, and multiline braced control-flow blocks. Explicit `any` and unsafe uses of
values inferred as `any` are errors; TypeScript's `strict` compiler setting also rejects implicit `any` parameters.
Generated output and dependencies are excluded. CI runs lint before tests.

```sh
npm run lint
npm run lint:fix
# Equivalent automatic fixes:
npm run lint -- --fix
```

ESLint fixes indentation and braces automatically. Long strings/expressions and unsafe type boundaries may
require manual changes. Use `unknown` and validate external data rather than bypassing rules with `any`.

Writes use same-directory temporary files, flushing, validation, a source digest check, and replacement. Unix mode/ownership and Windows attributes/ACLs are retained. Symlink destinations resolve before writing. BOM and existing line endings are preserved. Appending to a file without a final newline inserts a separator.

A sibling `.hostman.lock` serializes hostman writers. Remove a stale lock only after checking that no writer is running. Abrupt process or machine crashes may leave locks or temporary files.

External editors do not honor the lock. The final digest check detects observed changes before replacement, but does not provide atomic compare-and-swap against arbitrary editors. Avoid simultaneous editing. Mounted or restricted filesystems may reject atomic replacement; no in-place fallback is used.

```sh
npm test
npm run smoke:package
```

Tests use temporary fixtures, never real system hosts. They cover parser stability, domain conflicts, migration, CLI help/lifecycle, transaction failures, request tampering, and injected elevation. Windows tests perform actual replacement and ACL checks; Unix tests cover mode/ownership and symlinks. Real UAC and `sudo` require separate manual checks. CI is configured for Windows, Ubuntu, and macOS.

On Windows, `npm run smoke:elevation` temporarily protects a disposable directory and requests real UAC elevation. Accept the dialog to verify the privileged helper; the script restores permissions and removes the fixture afterward. Run it from a normal, unelevated terminal.
