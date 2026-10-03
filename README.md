# hostman

Manage project hostnames together and switch them between local, lab, or production IPs.
For example, switch both `foo.test` and `api.foo.test` to another environment with one command.

## Install

You need **Node.js 24 or newer** and npm. Hostman runs on Windows, Linux, and macOS.

Build and install from source. These commands work in PowerShell and Unix shells:

```sh
git clone https://github.com/kent010341/hostman.git
cd hostman
npm ci
npm run build
npm link
hostman --help
```

Keep the checkout while using this linked installation. To install from a supplied package instead:

```sh
npm install --global ./hostman-1.0.0.tgz
hostman --help
```

To uninstall, run `npm uninstall --global hostman`.

## Get started

### Already have custom hosts rules?

Preview what hostman can import, then select the groups you want to manage:

```sh
hostman migrate --dry-run
hostman migrate
hostman show all
```

You do not need to run `init` first. A hostname such as `api.foo.test` becomes part of the `foo.test` group.
Imported groups start with a target named `imported`, using their existing IP.

Run `hostman migrate` again whenever you add more rules manually. Groups with conflicting or mixed IPs are
skipped with an explanation; fix those rules before trying again.

### Starting a new project?

Create a group pointing to your local machine, then add a lab target:

```sh
hostman init
hostman add group foo.test --target local=127.0.0.1
hostman add host foo.test api
hostman target add foo.test lab 10.20.0.10
hostman show foo.test
hostman use foo.test lab
```

This creates `foo.test` and `api.foo.test`. The first target, `local`, is initially active.
The final command switches both names to the lab IP. Replace the example domain and IPs with your own.

Without `--host`, `add group` includes the root hostname (`foo.test`) automatically. To choose the initial
hostnames explicitly, use `--host @ --host api` for the root and `api.foo.test`, or `--host api` for only
`api.foo.test`.

For a guided menu, run `hostman` without a command. Commands also prompt for missing inputs in a terminal.

**Permissions:** when writing system hosts, an interactive terminal may show Windows UAC or request your
`sudo` password. Approve it to save the changes; cancelling leaves the file unchanged.

## Common tasks

The examples below assume that `foo.test` is already managed.

### See what is active

```sh
hostman show
hostman show all
hostman show foo.test
```

Use `show` for enabled groups, `show all` to include disabled groups, and `show <group>` for its hosts and targets.

### Add an environment and switch to it

```sh
hostman target add foo.test prod 10.30.0.10
hostman use foo.test prod
hostman target set foo.test prod 10.30.0.20
```

`target add` defines a destination; `use` selects it. `target set` changes an existing destination's IP.
If that target is active, all enabled hosts in the group update immediately.

To add a local destination to an imported group:

```sh
hostman target add foo.test local 127.0.0.1
hostman use foo.test local
```

### Add or remove a hostname

```sh
hostman add host foo.test admin
hostman remove host foo.test admin
```

Use `@` for `foo.test`, `api` for `api.foo.test`, or a full name such as `admin.foo.test`.

### Temporarily turn a project off

```sh
hostman disable foo.test
hostman enable foo.test
```

Disabling removes the group's effective mappings while keeping its hosts and targets for later use.

### Share one target across projects

```sh
hostman global add local 127.0.0.1
hostman target add foo.test shared-local @local
hostman use foo.test shared-local
hostman global set local 192.168.50.21
```

Other groups can reference the same `@local` target. Changing its global IP updates every enabled group using it.

### Remove a target or project

```sh
hostman use foo.test local
hostman target remove foo.test prod
hostman remove group foo.test
```

Switch away from a target before removing it. Removing a group deletes its managed hosts and target definitions.
Remove a global with `hostman global remove <name>` after removing every group target that references it.

### Resolve changes made by hand

```sh
hostman show foo.test
hostman repair foo.test
```

Use `migrate` for rules added **outside** hostman's markers. Use `repair` when changes **inside** a managed group
conflict with its target. Repair offers available resolutions; malformed markers may require manual correction.

## Help and another hosts file

Every command has help, including nested commands:

```sh
hostman --help
hostman migrate --help
hostman target set --help
```

In an interactive terminal, commands suggest relevant next steps using your group and target names.
For example, after `add group`, you can copy a command to add a hostname to that group. Suggestions keep
your custom hosts file path. Use `hostman --no-hints <command>` to hide them; scripts omit them automatically.
Command help also includes related command examples.

Hostman uses the system hosts file by default: `$env:SystemRoot\System32\drivers\etc\hosts` on Windows,
or `/etc/hosts` on Linux/macOS. To work with an existing custom file, put its path before the command:

```sh
hostman --hosts-file "./sample hosts" migrate --dry-run
hostman --hosts-file "./sample hosts" show all
```

For scripts, supply complete arguments and use `migrate --group foo.test` or `migrate --all` for explicit imports.
Scripts must already have write permission; automatic elevation only runs in an interactive terminal.
`--no-elevate` disables it there too.

## Further reading

- [Advanced usage and troubleshooting](docs/REFERENCE.md): migration eligibility, manual edits, permissions,
  and the hosts file format.
- [Development](docs/DEVELOPMENT.md): linting, tests, package builds, and write guarantees.
