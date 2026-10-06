# Development

Install dependencies and build the TypeScript CLI:

```sh
npm ci
npm run build
npm link
```

Rebuild after editing TypeScript when using a linked installation. Installation permissions depend on your
npm global prefix and are separate from permission to edit system hosts.

Internal imports use the native Node package alias `#hostman/*`. The `package.json` imports map resolves
TypeScript types to `src/*.ts` and Node execution to `dist/*.js`, including tests and the commit helper.
NodeNext resolves the same map during compilation; no runtime loader or separate test alias is required.
The packaged CLI only needs the compiled files for runtime resolution.

Migration presentation lives in the pure `src/cli/migration.ts` formatter. Candidate skip reasons and source
occurrences remain separate structured data; domain and helper errors independently include source diagnostics.
Preview formatting combines same-line aliases and separates rejected proposals from hypothetical resulting state.

## Code quality and tests

```sh
npm run lint
npm run lint:fix
npm test
npm run smoke:package
```

`npm run lint -- --fix` is equivalent to `lint:fix`. ESLint enforces four-space indentation, a strict
120-character line limit, and multiline braced control flow. Type-aware rules prohibit explicit `any` and
unsafe uses of values inferred as `any`. TypeScript's `strict` setting rejects implicit `any` parameters.
Generated output and dependencies are excluded. Long expressions and external-data boundaries may need
manual fixes after automatic formatting; use `unknown` and validate external data.

Tests use temporary fixtures, never the machine's real hosts file. They cover parser stability, conflicts,
migration, CLI help/lifecycle, transaction failures, request tampering, and injected elevation. Migration tests
include real Inquirer input driven through simulated TTY pipes, cancellation, custom target names and compiled
helper replay. Windows tests perform real file replacement and ACL checks. Unix tests cover mode/ownership and
symlinks when run on Unix. No CI workflow is tracked in this checkout; run the checks on each target platform
before claiming cross-platform validation.

`test/migration-cli.test.mjs` also covers global-first initial group destinations, the final manual-entry option,
no-global fallback, explicit destination bypass, disabled groups, explicit hosts and cancellation. Simulated
TTY tests verify source bytes before supplying creation responses. Initial destination selection uses the same
source snapshot as the eventual transaction; all name/IP prompts remain in the unelevated CLI process.

`test/rename.test.mjs` covers group and global target renaming, literal target and direct active selection preservation,
disabled groups, naming errors, clean no-ops, manual edits, CLI transactions, interactive target selection and
selection/naming cancellation, and compiled helper replay.

`test/cleaning.test.mjs` covers single-group global reuse and local deduplication, global-only deduplication and
consumer redirects, IPv6 equivalence, enabled/disabled selections, invalid choices, scope conflicts, manual
additions, pending dry runs, scripts, Inquirer selection/cancellation, migration global reuse and compiled helper
replay. Every fixture is disposable; these subprocess tests do not prove actual privilege authentication.

`test/selection.test.mjs` drives actual Inquirer menus through simulated TTY pipes for hostname removal and
group/global target updates and removal. It covers scope isolation, disabled deletion choices, disabled-group
references, empty/protected lists, explicit and script arguments, and cancellation before any source write.

On Windows, `npm run smoke:elevation` protects a disposable directory and requests actual UAC elevation.
Accept the dialog to verify the privileged helper. The script restores permissions and removes the fixture.
Run it from an unelevated terminal. Actual Unix `sudo` authentication requires a separate manual check.

## Build a distributable package

```sh
npm pack
npm install --global ./hostman-1.0.0.tgz
hostman --help
```

The tarball includes compiled code, helpers, and documentation. Its destination machine also needs Node.js 24
or newer. `smoke:package` tests packed and linked installations in temporary npm prefixes, including their
command shims and a write to a temporary hosts fixture.

## Storage and transaction design

The selected hosts file is the sole source of truth. All managed state is reconstructable without a database
or project metadata. A group's semantic SHA-256 digest identifies valid manual changes; it is not a cache.

Group destinations contain only `{ name, ip }` literal targets. The active selection stores a group target
name or `@global-name`; direct global selection requires no group target definition. Empty target lists are
valid when a global is selected. Parsing, validation, serialization, migration, repair and helper replay use
the same resolver. Global updates serialize only enabled consumers, while disabled selections still prevent
global deletion. Migration reuses an existing active destination first, then group targets; previously missing
destinations reuse matching globals before creating literal targets. Existing definitions are not cleaned during
migration. Multiple global matches require source-validated choices before transaction preparation.
`src/domain/cleaning.ts` provides pure semantic IP buckets, relevant-choice validation and cleanup proposals.
`src/cli/cleaning.ts` resolves terminal choices and formats pending previews without filesystem I/O.
Single-group cleanup replaces matching local definitions with globals and deduplicates remaining local IPs.
Global cleanup only deduplicates globals and redirects direct consumers, including disabled groups. New
`target-clean` and `global-clean` operations share normal transaction validation and helper replay.
The v1 markers and semantic digest structure remain unchanged; there is no compatibility or conversion layer
for the former `# target alias=@global` format.

Writes prepare and flush a same-directory temporary file, validate the result, recheck the source digest,
and replace the destination. Unix mode/ownership and Windows attributes/ACLs are retained. Symlink destinations
resolve before writing. BOM and existing line endings are preserved. Appending to a file without a final
newline inserts a separator. Untouched managed blocks and unrelated unmanaged lines are preserved.

A sibling `.hostman.lock` serializes hostman writers. Abrupt crashes may leave locks or temporary files.
Remove a stale lock only after checking that no writer is running.

External editors do not honor this lock. The final digest check detects observed changes before replacement
but does not provide atomic compare-and-swap against arbitrary editors. Avoid simultaneous editing.
Mounted or restricted filesystems may reject replacement; no in-place truncation fallback is used.

## Privileged helper

Selections and new migration target naming complete in the original process. Only the commit helper is elevated,
using Windows UAC or Unix
`sudo`. Its versioned request includes the resolved path, source digest, fully specified operation, and result
digest. The helper validates the request hash, rereads the source, reapplies the domain operation, and verifies
the expected output before committing. Migration operations may include target naming overrides by group and IP;
the helper recalculates proposals and validates these names without prompting. Migration and group cleanup can
carry global-name choices; cleanup operations can carry retained names. These name arrays are untrusted: replay
reconstructs eligible semantic IP buckets, rejects unrelated or conflicting selections, and requires explicit
resolution of global ambiguity. Local cleanup defaults retain the active target or first definition. A change
while authentication is pending cancels the commit.

The original process checks the structured response and resulting file before reporting success. Request
and result files are removed afterward. Cancellation, denied authentication, and missing tools stop the
operation without retrying elevation indefinitely. Credentials are never stored.
