#!/usr/bin/env node
import { Command, Option } from 'commander';
import {
    input, select, confirm, checkbox
} from '@inquirer/prompts';
import { networkInterfaces } from 'node:os';
import {
    HostmanError, ipKey, resolveTarget, sha256, type Group
} from '../domain/model.js';
import {
    targetFrom, transform, type Operation
} from '../domain/operations.js';
import { candidates, parse } from '../hosts/document.js';
import {
    execute, readSource, sourcePath
} from '../fs/storage.js';
const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
type RootOptions = {
    hostsFile?: string;
    elevate: boolean
};
type MigrationOptions = {
    group: string[];
    all?: boolean;
    dryRun?: boolean
};
type GroupOptions = {
    target: string[];
    active?: string;
    host: string[];
    disabled?: boolean
};
type RepairStrategy = 'restore' | 'keep';
type RepairOptions = { strategy?: RepairStrategy };
const program = new Command()
    .name('hostman')
    .description('Manage grouped hostnames and switch targets using the hosts file as the source of truth.')
    .version('1.0.0')
    .option('--hosts-file <path>',
        'Use this hosts file instead of the platform default')
    .option('--no-elevate',
        'Disable automatic interactive privilege elevation');
program.configureHelp({ showGlobalOptions: true });
program.addHelpText('after',
    '\nExamples:\n  hostman init\n  hostman migrate --dry-run\n'
    + '  hostman --hosts-file "./sample hosts" show all\n  hostman use foo.test prod');
const list = (value: string, previous: string[]) => [...previous, value];
function command(parent: Command, name: string, description: string, example: string): Command {
    return parent.command(name).description(description).addHelpText('after',
        `\nExample:\n  hostman ${example}`);
}
async function source() {
    return readSource(sourcePath(program.opts<RootOptions>().hostsFile));
}
async function text(value: string | undefined, message: string, defaultValue?: string): Promise<string> {
    if (value !== undefined) {
        return value;
    }
    if (!interactive) {
        throw new HostmanError(`${message} is required. Supply complete arguments or use an interactive terminal.`);
    }
    const result = await input({
        message,
        default: defaultValue
    });
    if (!result.trim()) {
        throw new HostmanError(`${message} cannot be empty.`);
    }
    return result.trim();
}
async function chooseGroup(value?: string): Promise<string> {
    if (value) {
        return value.toLowerCase();
    }
    if (!interactive) {
        throw new HostmanError('Group is required.');
    }
    const groups = parse((await source()).text).document.groups;
    if (!groups.length) {
        throw new HostmanError('No managed groups. Run init and add group, or migrate.');
    }
    return select({
        message: 'Group',
        choices: groups.map(g => ({
            name: g.name,
            value: g.name
        }))
    });
}
async function address(value?: string): Promise<string> {
    if (value !== undefined) {
        return value;
    }
    if (!interactive) {
        throw new HostmanError('IP or @global-reference is required.');
    }
    const detected = [
        ...new Set(
            Object.values(networkInterfaces()).flatMap(entries => entries?.map(x => x.address) ?? [])
        )
    ];
    const choice = await select({
        message: 'IP or global reference',
        choices: [
            ...detected.map(ip => ({
                name: ip,
                value: ip
            })),
            {
                name: 'Enter an IP or @global-reference',
                value: ''
            }
        ]
    });
    return choice || text(undefined,
        'IP or @global-reference');
}
async function mutate(operation: Operation, snapshot?: Awaited<ReturnType<typeof source>>): Promise<void> {
    const current = snapshot ?? await source(), next = transform(current.text,
        operation);
    if (next === current.text) {
        console.log(`No changes: ${current.path}`);
        return;
    }
    const changed = await execute({
        version: 1,
        sourcePath: current.path,
        sourceDigest: current.digest,
        operation,
        resultDigest: sha256(next)
    },
    {
        interactive,
        allowElevation: program.opts<RootOptions>().elevate,
        notify: console.log
    });
    console.log(`${changed ? 'Updated' : 'No changes'}: ${current.path}`);
}
command(program,
    'init',
    'Create an empty managed section; repeated runs preserve existing state.',
    'init').action(async () => mutate({ kind: 'init' }));
command(program,
    'migrate',
    'Preview and import explicitly selected unmanaged rules.',
    'migrate --group foo.test')
    .addOption(new Option('--group <group>',
        'Import this candidate group; repeat for multiple groups').argParser(list).default([]).conflicts('all'))
    .option('--all',
        'Import every eligible candidate group')
    .option('--dry-run',
        'Preview without prompts, writes, or elevation')
    .action(async (options: MigrationOptions) => {
        const snapshot = await source(), parsed = parse(snapshot.text), found = candidates(parsed);
        console.log(`Source: ${snapshot.path}`);
        for (const conflict of parsed.conflicts) {
            console.log(`CONFLICT${conflict.group ? ` ${conflict.group}` : ''}: ${conflict.message}`);
        }
        for (const c of found) {
            console.log(`${c.group}: ${c.ip}; ${c.hosts.join(', ')}${c.reason ? ` [SKIP: ${c.reason}]` : ''}`);
        }
        if (!found.length) {
            console.log('No migration candidates.');
        }
        const requested: string[] = options.group.map((name: string) => name.toLowerCase());
        for (const name of requested) {
            if (!found.some(c => c.group === name) && !parsed.document.groups.some(g => g.name === name)) {
                throw new HostmanError(`No candidate or managed group ${name}.`);
            }
        }
        const eligible = found.filter(c => !c.reason && (!requested.length || requested.includes(c.group)));
        if (options.dryRun) {
            console.log(`Eligible: ${eligible.map(c => c.group).join(', ') || 'none'}`);
            return;
        }
        if (!eligible.length) {
            console.log('No eligible imports; no changes.');
            return;
        }
        let selected = eligible.map(c => c.group);
        if (!options.all && !requested.length) {
            if (!interactive) {
                throw new HostmanError('Migration requires --group, --all, or an interactive terminal.');
            }
            selected = await checkbox({
                message: 'Select groups to migrate',
                choices: eligible.map(c => ({
                    name: c.group,
                    value: c.group
                }))
            });
            if (!selected.length || !await confirm({
                message: `Move selected rules into hostman in ${snapshot.path}?`,
                default: false
            })) {
                console.log('Cancelled; no changes.');
                return;
            }
        }
        await mutate({
            kind: 'migrate',
            groups: selected
        },
        snapshot);
    });
command(program,
    'show [selection]',
    'Show enabled groups (active), every group (all), or one group.',
    'show foo.test').action(async (selection: string | undefined) => {
    const snapshot = await source(), parsed = parse(snapshot.text);
    console.log(`Source: ${snapshot.path}`);
    if (parsed.document.globals.length) {
        console.log(`Globals: ${parsed.document.globals.map(t => `${t.name}=${t.ip}`).join(', ')}`);
    }
    const requested = selection ?? 'active';
    const groups = parsed.groups.filter(g => requested === 'all'
        || requested === 'active' && g.group.enabled
        || g.group.name === requested);
    if (!['all', 'active'].includes(requested) && !groups.length) {
        throw new HostmanError(`Unknown group ${requested}.`);
    }
    for (const entry of groups) {
        const g = entry.group;
        let effective = 'unresolved';
        try {
            effective = resolveTarget(parsed.document,
                g);
        } catch {
            // Conflicts are reported below; other groups remain inspectable.
        }
        console.log(`${g.name} ${g.enabled ? 'enabled' : 'disabled'} active=${g.activeTarget}`
            + ` ip=${effective} ${entry.status}`);
        const targets = g.targets.map(t => `${t.name}=${t.source === 'global' ? `@${t.globalName}` : t.ip}`);
        console.log(`  targets: ${targets.join(', ')}`);
        console.log(`  hosts: ${g.hosts.join(', ')}`);
    }
    for (const conflict of parsed.conflicts) {
        console.log(`CONFLICT${conflict.group ? ` ${conflict.group}` : ''}: ${conflict.message}`);
    }
});
const add = command(program,
    'add',
    'Add a managed group or hostname.',
    'add host foo.test api');
command(add,
    'group [group]',
    'Create a group with explicit initial targets.',
    'add group foo.test --target local=127.0.0.1 --host @')
    .option('--target <name=value>',
        'Initial target IP or @global-reference; repeat to add targets',
        list,
        [])
    .option('--active <target>',
        'Active target (default: first initial target)')
    .option('--host <hostname>',
        'Initial hostname, short subdomain, or @; repeat',
        list,
        [])
    .option('--disabled',
        'Create a disabled group (default: enabled)')
    .action(async (name: string | undefined, options: GroupOptions) => {
        const groupName = (await text(name,
            'Two-label group root')).toLowerCase();
        let specs: string[] = options.target;
        if (!specs.length) {
            specs = [
                `${await text(undefined,
                    'Initial target name',
                    'local')}=${await address()}`
            ];
        }
        const targets = specs.map(spec => {
            const index = spec.indexOf('=');
            if (index < 1) {
                throw new HostmanError('Use --target name=IP or name=@global.');
            }
            return targetFrom(spec.slice(0,
                index),
            spec.slice(index + 1));
        });
        const { expandHost } = await import('../domain/operations.js');
        const group: Group = {
            name: groupName,
            targets,
            activeTarget: options.active ?? targets[0].name,
            enabled: !options.disabled,
            hosts: options.host.map((h: string) => expandHost(groupName,
                h))
        };
        await mutate({
            kind: 'add-group',
            group
        });
    });
const remove = command(program,
    'remove',
    'Remove a managed group or hostname.',
    'remove host foo.test api');
command(remove,
    'group [group]',
    'Remove only this managed group.',
    'remove group foo.test').action(async (name: string | undefined) => {
    const group = await chooseGroup(name);
    if (interactive && !await confirm({
        message: `Remove group ${group}?`,
        default: false
    })) {
        console.log('Cancelled; no changes.');
        return;
    }
    await mutate({
        kind: 'remove-group',
        group
    });
});
for (const [parent, kind] of [[add, 'add-host'], [remove, 'remove-host']] as const) {
    command(parent,
        'host [group] [hostname]',
        `${kind === 'add-host' ? 'Add' : 'Remove'} a hostname, short subdomain, or @.`,
        `${kind === 'add-host' ? 'add' : 'remove'} host foo.test api`)
        .action(async (name: string | undefined, host: string | undefined) => mutate({
            kind,
            group: await chooseGroup(name),
            host: await text(host,
                'Hostname or subdomain')
        }));
}
for (const kind of ['enable', 'disable'] as const) {
    command(program,
        `${kind} [group]`,
        `${kind === 'enable' ? 'Enable' : 'Disable'} effective rules while retaining definitions.`,
        `${kind} foo.test`).action(async (name: string | undefined) => mutate({
        kind,
        group: await chooseGroup(name)
    }));
}
command(program,
    'use [group] [target]',
    'Switch all enabled hostnames in a group to a target.',
    'use foo.test prod').action(async (name: string | undefined, target: string | undefined) => {
    const group = await chooseGroup(name);
    if (!target && interactive) {
        const g = parse((await source()).text).document.groups.find(g => g.name === group);
        if (!g) {
            throw new HostmanError(`Unknown group ${group}.`);
        }
        target = await select({
            message: 'Target',
            choices: g.targets.map(t => ({
                name: t.name,
                value: t.name
            }))
        });
    }
    await mutate({
        kind: 'use',
        group,
        target: await text(target,
            'Target')
    });
});
const target = command(program,
    'target',
    'Manage group-owned targets and global references.',
    'target add foo.test prod 10.0.0.1');
for (const action of ['add', 'set'] as const) {
    command(target,
        `${action} [group] [target] [value]`,
        `${action === 'add' ? 'Add' : 'Set'} a group target using an IP or @global-reference.`,
        `target ${action} foo.test prod 10.0.0.1`)
        .action(async (name: string | undefined, targetName: string | undefined, value: string | undefined) => mutate({
            kind: `target-${action}`,
            group: await chooseGroup(name),
            target: targetFrom(await text(targetName,
                'Target name'),
            await address(value))
        }));
}
command(target,
    'remove [group] [target]',
    'Remove an inactive group target.',
    'target remove foo.test lab')
    .action(async (name: string | undefined, targetName: string | undefined) => mutate({
        kind: 'target-remove',
        group: await chooseGroup(name),
        target: await text(targetName,
            'Target name')
    }));
const global = command(program,
    'global',
    'Manage shared targets referenced by groups.',
    'global add local 127.0.0.1');
for (const action of ['add', 'set'] as const) {
    command(global,
        `${action} [target] [ip]`,
        `${action === 'add' ? 'Add' : 'Set'} a global target IP.`,
        `global ${action} local 127.0.0.1`)
        .action(async (name: string | undefined, ip: string | undefined) => mutate({
            kind: `global-${action}`,
            name: await text(name,
                'Global target name'),
            ip: await address(ip)
        }));
}
command(global,
    'remove [target]',
    'Remove a global target only when no group references it.',
    'global remove local').action(async (name: string | undefined) => mutate({
    kind: 'global-remove',
    name: await text(name,
        'Global target name')
}));
command(program,
    'repair [group]',
    'Repair effective-IP conflicts or canonicalize valid manual edits.',
    'repair foo.test --strategy restore')
    .addOption(new Option('--strategy <strategy>',
        'Restore configured IP, or keep one effective IP for a group-owned target').choices(['restore', 'keep']))
    .action(async (name: string | undefined, options: RepairOptions) => {
        const group = await chooseGroup(name);
        const snapshot = await source();
        const parsed = parse(snapshot.text);
        const entry = parsed.groups.find(g => g.group.name === group);
        if (!entry) {
            throw new HostmanError(`Unknown group ${group}.`);
        }
        let strategy = options.strategy;
        if (!strategy) {
            if (!interactive) {
                throw new HostmanError('Repair requires --strategy restore|keep.');
            }
            let configured = 'unresolved';
            try {
                configured = resolveTarget(parsed.document,
                    entry.group);
            } catch {
                // The repair operation validates unresolved target references.
            }
            const effectiveIps = [...new Set(entry.effective.map(r => r.ip))].join(', ') || 'none';
            console.log(`Configured: ${configured}; effective: ${effectiveIps}`);
            const choices: {
                name: string;
                value: RepairStrategy
            }[] = [
                {
                    name: 'Restore configured target',
                    value: 'restore'
                }
            ];
            const activeTarget = entry.group.targets.find(t => t.name === entry.group.activeTarget);
            const hasSingleIp = new Set(entry.effective.map(r => ipKey(r.ip))).size === 1;
            if (activeTarget?.source === 'group' && hasSingleIp) {
                choices.push({
                    name: 'Keep effective IP and update group-owned target',
                    value: 'keep'
                });
            }
            strategy = await select({
                message: 'Repair strategy',
                choices
            });
        }
        await mutate({
            kind: 'repair',
            group,
            strategy,
            ip: strategy === 'keep' ? entry.effective[0]?.ip : undefined
        },
        snapshot);
    });
program.action(async () => {
    if (!interactive) {
        program.outputHelp();
        return;
    }
    const choice = await select({
        message: 'Hostman',
        choices: [
            ['Show active', 'show'],
            ['Show all', 'show all'],
            ['Initialize', 'init'],
            ['Migrate rules', 'migrate'],
            ['Switch target', 'use'],
            ['Enable group', 'enable'],
            ['Disable group', 'disable'],
            ['Add group', 'add group'],
            ['Add hostname', 'add host'],
            ['Remove group', 'remove group'],
            ['Remove hostname', 'remove host'],
            ['Add target', 'target add'],
            ['Set target', 'target set'],
            ['Remove target', 'target remove'],
            ['Add global target', 'global add'],
            ['Set global target', 'global set'],
            ['Remove global target', 'global remove'],
            ['Repair external changes', 'repair'],
            ['Exit', 'exit']
        ].map(([name, value]) => ({
            name,
            value
        }))
    });
    if (choice === 'exit') {
        return;
    }
    const opts = program.opts<RootOptions>();
    const hostArguments = opts.hostsFile ? ['--hosts-file', opts.hostsFile] : [];
    const elevationArguments = opts.elevate ? [] : ['--no-elevate'];
    const globals = [...hostArguments, ...elevationArguments];
    await program.parseAsync([...globals, ...choice.split(' ')],
        { from: 'user' });
});
try {
    await program.parseAsync();
} catch (error) {
    console.error(`Error: ${(error as Error).message}`);
    process.exitCode = 1;
}
