# Hostman contributor guide

## Start here

- Read this file before changing the project. Use the task map below to inspect relevant code and tests;
  do not read the entire repository by default. Verify affected behavior against the implementation.
- Follow applicable user and global instructions. This guide adds project context and does not weaken them.
- Hostman is a hosts-native CLI for grouping hostnames and switching their shared destination targets.
- Runtime: Node.js 24 or newer. Implementation: strict TypeScript, NodeNext ESM, Commander, and Inquirer.
- The selected hosts file is the sole source of truth. Managed state is reconstructed from its markers;
  there is no database, cloud state, or optional cache implementation.
- User documentation is [README.md](README.md). Detailed behavior is in
  [docs/REFERENCE.md](docs/REFERENCE.md); build and storage notes are in
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Architecture and task map

| Module | Responsibility |
| --- | --- |
| `src/cli/index.ts` | Command tree, global options, prompts, menu, previews, and orchestration |
| `src/cli/hints.ts` | Pure contextual suggestions, related help, failure guidance, and shell quoting |
| `src/cli/migration.ts` | Pure multi-line migration proposal and final-summary formatting |
| `src/cli/cleaning.ts` | Terminal destination choices and pending cleanup/migration preview lines |
| `src/domain/model.ts` | Targets, groups, documents, validation, IP comparison, and semantic digests |
| `src/domain/operations.ts` | Operation union, pure domain mutations, and validated text transformation |
| `src/domain/cleaning.ts` | Pure IP buckets, source-derived cleanup proposals and choice validation |
| `src/hosts/document.ts` | Marker parsing, source spans, serialization, migration candidates and removal |
| `src/fs/storage.ts` | Source selection, decoding, locking, replacement, elevation, and helper protocol |
| `src/fs/helper.ts` | Non-interactive privileged commit entry point |
| `src/fs/windows.ps1` | Windows replacement, administrator checks, and UAC launch support |
| `scripts/copy-helpers.mjs` | Copy the PowerShell helper into compiled output |
| `scripts/package-smoke.mjs` | Packed and linked installation checks using temporary prefixes |
| `scripts/elevation-smoke.mjs`, `scripts/protected-fixture.ps1` | Disposable protected-fixture UAC check |
| `test/domain.test.mjs`, `test/fixtures/` | Parsing, digests, domain rules, migration, and repair |
| `test/migration.test.mjs`, `test/migration-cli.test.mjs` | Commented/multi-target imports and interactive naming |
| `test/cli.test.mjs` | Command help, lifecycle, temporary-file integration, and simulated TTY behavior |
| `test/hints.test.mjs` | State-aware suggestions, recovery guidance, and cross-shell argument quoting |
| `test/storage.test.mjs`, `test/acl.ps1` | Transactions, concurrency, metadata, encoding, and elevation |
| `test/rename.test.mjs` | Target renaming, active selections, global references, CLI and helper replay |
| `test/selection.test.mjs` | Existing-item menus, scope isolation, deletion restrictions and cancellation |
| `test/cleaning.test.mjs` | Cleanup, global migration reuse, pending previews, TTY cancellation and helper replay |

| Task | Inspect first |
| --- | --- |
| Add or change a command | CLI entry, Operation union, affected domain operation, CLI/domain tests |
| Change next-step suggestions | Hints module, CLI integration, hints/CLI tests |
| Change group or target behavior | Domain model and operations, parser representation, domain tests |
| Change markers or migration | Hosts document module, transform, domain fixtures/tests |
| Change cleanup or global reuse | Domain cleaning/operations, candidates, CLI choices and cleaning tests |
| Change writes or permissions | Storage, helper entries, PowerShell implementation, storage tests |
| Change build or installation | Package/TS config, helper-copy and package-smoke scripts, developer docs |

Normal mutation flow: parse arguments and finish prompts/selections, read the resolved source, compute a
validated transformation, commit with digest checks, then report the result and optional suggestions.
Only the commit helper is elevated. It replays the same domain operation without prompting.
Keep domain transformations independent of prompts and filesystem APIs. Keep suggestions free of I/O.

## Current CLI behavior

```text
hostman
hostman init
hostman migrate [--group <group> ... | --all] [--global <name> ...] [--dry-run]
hostman show [active | all | <group>]
hostman add group [group] [--target <name=value> ...] [--active <target>] [--host <hostname> ...] [--disabled]
hostman add host [group] [hostname]
hostman remove group [group]
hostman remove host [group] [hostname]
hostman enable [group]
hostman disable [group]
hostman use [group] [target]
hostman target add [group] [target] [value]
hostman target set [group] [target] [value]
hostman target rename [group] [target] [new-name]
hostman target remove [group] [target]
hostman target clean [group] [--global <name> ...] [--keep <group=target> ...] [--dry-run]
hostman global add [target] [ip]
hostman global set [target] [ip]
hostman global rename [target] [new-name]
hostman global remove [target]
hostman global clean [--keep <name> ...] [--dry-run]
hostman repair [group] [--strategy restore | keep]
```

- Global options: `--hosts-file <path>`, `--no-elevate`, `--no-hints`, `-h`/`--help`, and `-V`/`--version`.
- Running without a command opens a menu when stdin and stdout are terminals; otherwise it shows help.
  Missing inputs prompt only in an interactive terminal; scripts must supply complete arguments.
- Root, parent, and leaf help must work without accessing hosts, prompting, elevating, or writing.
  Command help includes related examples independently of runtime suggestion settings.
- `init` creates an empty outer managed section. Repeated valid initialization makes no byte changes.
  It preserves valid manual edits, imports nothing, and creates no global target. Conflicts are rejected.
- Other mutations require initialization, but `migrate` can create the section during an actual import.
- Creating a group defaults its active target to the first initial target. `--active @global-name` directly
  selects a global; without `--target`, it creates no group targets and skips the initial target prompt.
  In a terminal, omitting both `--target` and `--active` offers globals first in definition order with their IPs;
  the first global is the default and the final option enters a new group target. Selecting a global creates no
  local definitions and skips name/IP prompts. With no globals, only manual entry is offered. Manual entry
  retains the `local` name default and IP selection/input flow. Explicit destination flags bypass this menu;
  scripts still require explicit destinations. All creation prompts finish before writing, and destination
  selection and commit use the same source snapshot so intervening edits fail the transaction digest check.
  Without `--host`, it includes the group root. Explicit `--host` options are the complete initial list;
  `@` means root and `api` expands
  to `api.<group>`. Empty groups remain representable after removing their last hostname.
- Each group has an enabled flag, active target, targets, and owned hostnames. Enabled hostnames share the
  resolved active IP. Disabled groups keep their definitions but have no effective mappings.
- Group targets contain literal IPs only. `use <group> <name>` selects a group target;
  `use <group> @global-name` selects a global directly, stored as `active=@global-name`, without a group target.
  The interactive switch menu lists group targets first, then all globals, showing source and IP.
  Names do not imply environments. Global IP changes propagate to enabled groups directly selecting them;
  disabled groups retain their selection and use the latest IP when enabled. An active group target cannot
  be removed, and globals selected by any group, including disabled groups, cannot be removed.
  Group targets may be empty when the active selection resolves to an existing global. The former group
  reference format is unsupported; there is no compatibility or conversion layer.
- Group target renames preserve destinations and update the stored active selection when applicable.
  Global renames update direct active selections, including disabled groups, preserving
  group-owned targets and all IPs. Both are available in the guided menu and use replayable transactions.
  In interactive terminals, omitted existing target names are selected from the current scope's list and
  new names use text input. Group renames select an omitted group first; explicit arguments skip prompts.
  Empty target lists report actionable errors; scripts require complete arguments.
  Unknown targets, invalid names and duplicate names within their scope are rejected. Same-name renames of
  clean state are byte-stable; affected conflicts block renames and valid manual hostname additions survive.
- Next-step hints appear only when stdin and stdout are terminals and hints are enabled. `--no-hints`
  suppresses them, including from the menu. Scripts omit hints automatically.
- `target clean` cleans exactly one group; it has no `--all`. Omitted groups use terminal selection, while
  scripts and dry runs require a group. Matching local IPs reuse globals and remove their local definitions;
  active literals redirect to the chosen global. Existing direct global selections remain unchanged.
  Multiple global matches require a terminal choice or repeatable `--global <name>` flags. Remaining local
  duplicate IPs retain one target: terminal selection defaults to active or first source definition, and scripts
  use that default. Repeatable `--keep <group=target>` overrides retention and redirects active names if needed.
- `global clean` deduplicates the global namespace only. Terminals select one retained global per duplicate IP;
  scripts must provide repeatable `--keep <name>` covering every duplicate IP. Removed names' direct active
  consumers, including disabled groups, redirect to the retained global. Group-owned targets remain intact.
  Nonduplicate globals are preserved. Both clean commands appear in the guided menu, preserve enabled state,
  hostnames and semantic destination IPs, and finish selections before one transaction. Group cleanup makes
  future global IP changes apply to newly redirected consumers. Unknown, unrelated or contradictory choices
  fail before writes. Dry runs never prompt/write/elevate and show pending choices; global previews list consumers.
  Complete previews validate their affected scope. Summaries show removals, retained names and active redirects.
  Structural/affected conflicts block cleanup; unrelated group conflicts remain isolated. Clean no-ops and repeat
  runs without obsolete explicit flags preserve bytes, and valid manual additions survive changed blocks.
- Interactive `remove host` selects an omitted hostname from its group's full hostname list, including root
  and disabled-group hostnames. `target set/remove` and `global set/remove` select omitted existing names
  from their own scope, displaying names and IPs in definition order. Group operations select an omitted
  group first. Explicit arguments skip selection; scripts require complete arguments. New names use text input.
  Removal lists show but disable active group targets and referenced globals, including disabled-group
  references, explaining why. Empty or entirely protected lists fail with actionable guidance before prompting.
  Selection, replacement IP input and cancellation finish before any transaction write.
- Suggestions use actual names and resulting state, avoid existing suggested hostname/target names, retain
  the resolved custom source path, and quote arguments for PowerShell or Unix shells. Disabled groups need
  enabling; healthy nonempty `show` results need no hints. Failures suggest recovery without reporting success.

## Hosts format and domain invariants

- One `# >>> hostman v1` / `# <<< hostman` pair surrounds global definitions and group blocks.
  Group markers contain the name, enabled flag, active target, and an eight-character semantic SHA-256 hash.
  Targets and disabled hostnames use comments; enabled mappings use ordinary hosts rules.
- Preserve marker grammar and digest semantics. Target/hostname order does not affect the semantic hash.
  Full-file SHA-256 checks used for transactions are separate from the group hash.
- `CLEAN`: configured state, effective rules, and digest agree. `DIRTY`: valid manual changes or a stale
  digest; valid manual hostname additions survive a touched mutation. `CONFLICT`: invalid or ambiguous state.
- Hostnames must belong to their group and have unique ownership. Managed hostnames cannot also appear in
  unmanaged effective rules. Compare IPs semantically, including equivalent IPv6 representations.
- Structural document conflicts block mutations. Group-scoped conflicts block affected mutations;
  unaffected valid groups remain inspectable. Never bypass validation through elevation or serialization.
- Repair `restore` regenerates configured rules. `keep` adopts one unambiguous effective IP into a
  group-owned active target; it is unavailable for direct global selections and cannot update a global or
  invent targets. Structural damage needs
  manual correction. Inspect available repair strategies rather than silently choosing one.
- Migration rescans current unmanaged effective and commented rules on every run. After indentation or a
  BOM, removing exactly one leading `#` must produce a hosts rule; adjacent or spaced IPs qualify, double
  comment markers do not. Ordinary comments, single-label/IP-like names, and localhost aliases remain
  unmanaged. Grouping uses the final two labels, not the Public Suffix List. Commented migration rules
  stay separate from effective rules and unmanaged collision validation.
- Without selection flags, migration previews, selects, and confirms. Repeatable `--group` and `--all`
  are mutually exclusive. Dry runs do not prompt, write, or elevate. No eligible imports means no changes.
- New groups reuse matching globals or import one literal target per unmatched semantic IP and the hostname
  union, deduplicating repeated aliases. Unique global matches need no prompt; multiple matches require terminal
  selection or repeatable `--global <name>`. Each new IP shares a choice across selected groups. Scripts reject
  unresolved ambiguity; dry runs show matching names and pending selections without inventing active state.
  One effective IP enables the group and selects its target; multiple effective IPs skip the whole group.
  Commented-only groups start disabled with the first destination, possibly global, retained for a later enable.
  Previews and summaries report `active: none (disabled)` and the stored enable selection; `show` retains its existing
  disabled flag and stored active target display. Names default to available `imported`, `imported-2`, etc.
- Every interactive import, including `--all` and `--group`, prompts for each new literal target name with a default.
  Scripts and dry runs use deterministic defaults. Existing names and accepted names remain reserved within
  the group. Prompting finishes before summary, confirmation when required, and any write or elevation.
- Migration previews use separate multi-line READY/SKIP blocks per group. READY blocks and final summaries
  list targets, hosts and active state separately. SKIP blocks show the reason, source rules sorted by original
  line number with same-line aliases combined, and an action; they omit hypothetical targets and active state.
  Explicit global flags resolve the displayed proposal; unresolved global ambiguity is marked pending.
  Candidate reasons and source occurrences remain separate; domain/helper errors retain source diagnostics.
- Compatible existing groups merge hosts and missing targets without changing enabled state, active target
  or existing definitions. Matching IPs reuse the active selection first, including a direct global, then the first
  matching existing target. Missing destinations reuse globals before creating literals. Migration does not
  clean or remove existing target definitions; use single-group `target clean` separately.
  Enabled groups require matching effective input; disabled groups only accept commented input.
  Same-group outside duplicates can be absorbed, resolving only their unmanaged hostname
  conflicts. Other managed conflicts and cross-group ownership remain blocking. Skip details identify source
  lines, hosts, outside IPs and managed active IP or disabled state; repair does not remove outside rules.
- Selected aliases are removed from unmanaged lines and inserted into management in one transaction.
  Preserve unselected aliases, their IP, spacing, comment prefix and inline comments; retain an inline comment
  separately when all aliases move.
  Repeated imports without new eligible rules are byte-stable.
- V1 excludes Public Suffix List grouping, per-host IP overrides, full-screen TUI, automatic environment
  inference, cloud state, and silent adoption of unmanaged rules. Do not assume these features exist.

## Source selection, preservation, and privileges

- An explicit source path resolves against the original working directory. Defaults are `/etc/hosts` on
  Unix and `SystemRoot/System32/drivers/etc/hosts` on Windows. Missing Windows `SystemRoot` requires an
  actionable `--hosts-file` error. Resolve symlink destinations and preserve the symlink itself.
- Accept ASCII/UTF-8 with optional BOM. Reject unsupported encodings and embedded NUL before mutation.
  Preserve unmanaged content, existing line endings, BOM presence, and untouched managed blocks.
  Appending to a source without a final newline inserts the required separator.
- Attempt current-permission writes first. Read-only commands, help, dry runs, no-ops, and writable custom
  sources never request elevation. Interactive permission failures may elevate unless `--no-elevate` is set.
  Non-interactive or already-elevated failures report the problem without another elevation attempt.
- Windows uses PowerShell/UAC; Unix uses sudo with terminal authentication. Use absolute executable paths,
  pass data as arguments, keep helper windows hidden, and never store credentials or retry indefinitely.
- The versioned request includes the resolved source path, expected source SHA-256, complete operation,
  and expected result SHA-256. Verify its separate request hash and structured helper result. The helper
  must validate, lock, reread, replay, and verify before committing; never resolve the source under a new account.
  Migration operations may include target naming overrides by group and semantic IP; replay recomputes
  candidates and validates names without prompting or trusting caller-supplied source state.
  Migration and group cleanup may include global-name choices; cleanup may include retention names. Replay
  reconstructs relevant semantic IP buckets, validates name arrays and requires resolved global choices.
- Serialize writers with a sibling `.hostman.lock`. Prepare and flush a same-directory temporary file,
  recheck the source immediately before replacement, and preserve Unix mode/ownership. Windows uses .NET
  `File.Replace` with metadata errors enforced to preserve destination attributes/ACLs. Never truncate live hosts.
- Clean temporary request/result/write files after completion or failure. Remove a stale lock only after
  verifying no writer is running. External editors do not honor the lock; digest checks are not an atomic
  compare-and-swap guarantee. Document this limitation rather than promising protection against all races.

## Coding and documentation rules

- Use English for comments, JSDoc, CLI messages/help, README, and developer documentation.
- Use four-space indentation, a 120-character line limit, single quotes, semicolons, no trailing spaces,
  and a final newline. Control flow uses multiline 1TBS braces; one statement per line; indent switch cases.
- Keep TypeScript strict and type-aware lint. Explicit `any` is forbidden; validate and narrow `unknown`.
  Use Node globals for this Node CLI, not for any future browser code.
- Apply global symbol-documentation rules to newly introduced or modified symbols: JSDoc for types and
  members, functions/methods, and variables including local/destructured declarations. Document parameters
  and non-void returns. Loop variables and callback parameters are exempt; `//` cannot replace required JSDoc.
- Internal static imports, re-exports, and dynamic imports must use a project alias. Third-party imports
  keep package names; resource paths are separate. If absent, establish an appropriate project alias and
  matching compiler/build/test/runtime resolution before adding or changing internal imports. Confirm names
  if multiple candidates or conflicts exist; do not add aliases that only TypeScript can resolve.
- Internal code imports use native Node package imports `#hostman/*`, with source type resolution and compiled
  runtime resolution configured in package.json. NodeNext, tests, packaged code and the helper share this map.
  Existing untouched symbols may still lack required JSDoc. ESLint covers core formatting/type safety but not
  every global convention; do not backfill the whole project incidentally.
- Keep README focused on installation, getting started, and use cases first. Put deeper internals in the
  developer/reference documents. New creation examples use `example.com` and explicitly include `--host`.

## Validation and delivery

- Install with `npm ci`. Build with `npm run build`; this runs TypeScript and copies packaged helpers.
  The executable entry is `dist/cli/index.js`. Rebuild after TypeScript changes for linked installations.
- Prefer `npm run lint:fix` first, then fix remaining issues manually. Run `npm run lint` to verify.
- `npm test` builds and runs `test/*.test.mjs` through Node's test runner. Choose meaningful regression
  coverage for changed behavior; run the full suite for feature/domain/storage changes.
- `npm run smoke:package` checks packed and linked installations, command shims, and helper availability
  in temporary prefixes. Run it for installation, helper packaging, or module-resolution changes.
- Tests must use temporary hosts fixtures and injected elevation launchers, never the real system hosts.
  Simulated TTY tests exercise real Inquirer inputs, target naming, cancellation and final confirmation.
  Compiled helper tests verify custom-name replay and invalid-name rejection. They do not prove actual UAC
  or sudo authentication.
  Existing-item selection tests also cover scope isolation, disabled deletion choices, empty/protected lists
  and byte preservation throughout prompts and cancellation.
  Cleanup tests cover active/inactive and enabled/disabled destinations, global redirects without local removal,
  IPv6 equivalence, explicit/default retention, invalid choices, isolated conflicts, manual additions, dry-run
  ambiguity, script failures, real Inquirer cancellation, migration global reuse and compiled helper replay.
  Group creation TTY tests cover global-first initial selection, manual entry last, no-global fallback, explicit
  destination bypass, disabled/explicit-host creation and byte preservation during prompts and cancellation.
- Direct global regression coverage includes empty group targets, same-named local/global selections,
  disabled deletion protection, affected conflicts, semantic migration reuse, repair restrictions,
  simulated TTY selection/cancellation and compiled helper replay.
- For permission changes, validate actual elevation separately against disposable protected fixtures when
  the platform is available. `npm run smoke:elevation` is the Windows UAC check from an unelevated terminal.
  Report unavailable Unix sudo, symlink, or metadata checks; do not claim cross-platform validation from one OS.
- No CI workflow is tracked in this checkout. Verify actual automation before relying on it; do not report
  nonexistent CI as passing or infer cross-platform validation from tests on one platform.
- For documentation-only changes, verify source facts, paths/links, commands, and `git diff --check`;
  do not run the entire functional suite merely to change prose.
- Do not commit on master without explicit user authorization. Otherwise create `codex/<task-name>` first.
  Stage only this task's changes, inspect staged diff, commit after required checks pass, and verify the
  commit and remaining worktree state. Follow issue-prefix rules when an issue was specified. Do not push
  automatically. Report any externally blocked verification rather than presenting it as completed.

## Mandatory final-stage synchronization

- After any functional change and its required validation, review and update this project AGENTS.md in the
  final wrap-up stage, before committing. It must describe the final implementation, not the original proposal.
- Review commands/options, domain rules, file format, architecture, privileges/transactions, installation,
  and validation guidance. Update related README/reference/developer documentation in the same delivery.
- If implementation changes again after documentation review, repeat the synchronization before committing.
  Replace or remove stale statements instead of only appending new material.
- If existing guidance already describes the change correctly, avoid a meaningless edit and explicitly
  report that AGENTS.md was checked and required no update.
- Keep this guide durable: do not record transient branch names, commit IDs, fixed test counts, or individual
  machine verification results as permanent project state. Keep module/task navigation accurate as code moves.
