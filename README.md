# hostman

Manage project hostnames together and switch them between local, lab, or production IPs.
For example, switch both `foo.test` and `api.foo.test` to another environment with one command.

**New here or unsure what to do? Just run `hostman`.** Its interactive menu is the recommended way to get
started: choose an action and follow the prompts without memorizing commands.

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

### Start with the interactive menu (recommended)

After installation, open a terminal and run:

```sh
hostman
```

The menu lets you initialize management, import existing rules, manage groups and hostnames, switch targets,
and more. Select an action, then follow its prompts for the required inputs.
You can return to this menu whenever you are unsure which command to use.

The command examples below provide direct alternatives for common workflows. Commands also prompt for
missing inputs in an interactive terminal. Without interactive input and output, `hostman` shows help instead
of the menu; scripts must supply complete command arguments.

### Already have custom hosts rules?

Preview what hostman can import, then select the groups you want to manage:

```sh
hostman migrate --dry-run
hostman migrate
hostman show all
```

You do not need to run `init` first. A hostname such as `api.foo.test` becomes part of the `foo.test` group.
Migration imports effective rules and commented rules such as `#127.0.0.1 api.foo.test`.
Each distinct IP becomes a target, with default names `imported`, `imported-2`, and so on. Interactive imports
let you name each new target; press Enter to accept its default. Hostnames are combined across targets.
One effective IP enables the new group and selects that target. Commented-only groups start disabled.

Run `hostman migrate` again whenever you add more rules manually. Multiple effective IPs or conflicts with
an existing group's active IP are skipped with source details; fix those rules before trying again.
The preview uses a separate READY or SKIP block for each group. Skipped groups show the reason and original
source line numbers, while eligible groups list their targets, hostnames and proposed active state.

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

Rename destinations while preserving their IPs and selections:

```sh
hostman target rename example.com local dev
hostman global rename local shared
```

Group target renames update the active selection when needed. Global renames update every direct `@local`
selection, including disabled groups, while preserving group-owned targets and all IPs.
Replacement names must be valid and unused in their scope.
Renaming a target to its current name makes no changes when its managed state is clean.
In an interactive terminal, omit the existing target name to select it from a list, then enter its new name.

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
hostman use foo.test '@local'
hostman global set local 192.168.50.21
```

Select a global directly with `@name`; no group target needs to be created first. The Switch target menu also
lists all global targets with their IPs. Changing a global IP updates every enabled group selecting it.
`local` selects a group-owned target; `@local` selects the global even when both have the same name.

You can create a group using only a global destination:

```sh
hostman add group example.com --active '@local' --host '@' --host api
```

Group targets created with `target add/set` or `--target name=IP` accept literal IPs only.

### Remove a target or project

```sh
hostman use foo.test local
hostman target remove foo.test prod
hostman remove group foo.test
```

Switch away from a target before removing it. Removing a group deletes its managed hosts and target definitions.
Remove a global with `hostman global remove <name>` after switching every group selecting it to another
destination. Disabled groups also retain their selection and prevent removal.

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
