import type { Operation } from '../domain/operations.js';
import type { ParseResult } from '../hosts/document.js';

export type Hint = { description: string; args: string[]; additional?: string[][] };
const hint = (description: string, ...args: string[]): Hint => ({ description, args });
const create = () => hint('Create a mapping:',
    'add', 'group', 'example.com', '--target', 'local=127.0.0.1', '--host', '@');
const view = (group: string) => hint('View hosts and targets:', 'show', group);

function addTarget(group: string, names: string[]): Hint {
    let name = 'lab';
    while (names.includes(name)) {
        name += '-new';
    }
    return hint('Add another target:', 'target', 'add', group, name, '192.0.2.10');
}

export function operationHints(operation: Operation, parsed: ParseResult): Hint[] {
    if (operation.kind === 'init') {
        return [
            { ...hint('Preview and import existing rules:', 'migrate', '--dry-run'), additional: [['migrate']] },
            parsed.document.groups.length ? view('all') : create(),
            hint('Open the guided menu:')
        ];
    }
    if (operation.kind === 'migrate') {
        const groups = parsed.document.groups.filter(g => operation.groups.includes(g.name));
        if (groups.length === 1) {
            return [view(groups[0].name), addTarget(groups[0].name, groups[0].targets.map(t => t.name))];
        }
        return [view('all')];
    }
    if (operation.kind === 'global-add') {
        const group = parsed.document.groups.find(g => !parsed.conflicts.some(c => c.group === g.name));
        let name = operation.name;
        while (group?.targets.some(t => t.name === name)) {
            name += '-new';
        }
        return group ? [hint('Reference this global target in a group:',
            'target', 'add', group.name, name, `@${operation.name}`), view(group.name)]
            : parsed.document.groups.length ? [view('all'),
                hint('Learn how to reference a global target:', 'target', 'add', '--help')]
                : [create(), hint('Learn how to reference a global target:', 'target', 'add', '--help')];
    }
    if (operation.kind === 'global-set') {
        const affected = parsed.document.groups.filter(g => g.targets.some(t =>
            t.source === 'global' && t.globalName === operation.name));
        return [view(affected.length === 1 ? affected[0].name : 'all')];
    }
    if (operation.kind === 'global-remove' || operation.kind === 'remove-group') {
        return [view('all')];
    }
    if (!('group' in operation)) {
        return [view('all')];
    }
    const name = operation.kind === 'add-group' ? operation.group.name : operation.group;
    const group = parsed.document.groups.find(g => g.name === name);
    if (!group) {
        return [view('all')];
    }
    const enable = hint('This group is disabled; enable it to apply its mappings:', 'enable', name);
    if (operation.kind === 'add-group') {
        let host = 'api';
        while (group.hosts.includes(`${host}.${name}`)) {
            host += '-new';
        }
        return [hint('Add another hostname to this group:', 'add', 'host', name, host),
            group.enabled ? addTarget(name, group.targets.map(t => t.name)) : enable, view(name)];
    }
    if (operation.kind === 'disable') {
        return [hint('Enable this group again:', 'enable', name), view(name)];
    }
    if (!group.enabled) {
        return [enable, view(name)];
    }
    if ((operation.kind === 'target-add' || operation.kind === 'target-set')
        && operation.target.name !== group.activeTarget) {
        return [hint('Switch to this target:', 'use', name, operation.target.name), view(name)];
    }
    if (operation.kind === 'add-host') {
        const alternative = group.targets.find(t => t.name !== group.activeTarget);
        return alternative ? [view(name), hint('Switch this group to another target:',
            'use', name, alternative.name)] : [view(name)];
    }
    return [view(name)];
}

export function showHints(parsed: ParseResult, names: string[]): Hint[] {
    const entries = parsed.groups.filter(g => names.includes(g.group.name));
    const damaged = entries.find(g => g.status !== 'CLEAN');
    if (damaged) {
        return [hint('Review repair strategies before changing this group:', 'repair', damaged.group.name, '--help')];
    }
    if (parsed.conflicts.length) {
        return [hint('Review conflicts and repair options:', 'repair', '--help')];
    }
    const disabled = entries.find(g => !g.group.enabled)
        ?? (!entries.length ? parsed.groups.find(g => !g.group.enabled) : undefined);
    if (disabled) {
        return [hint('Enable this group to apply its mappings:', 'enable', disabled.group.name)];
    }
    if (!parsed.document.groups.length) {
        return parsed.outer ? [create(), hint('Preview existing rules:', 'migrate', '--dry-run')] : [
            hint('Initialize hostman:', 'init'), hint('Preview existing rules:', 'migrate', '--dry-run')
        ];
    }
    const empty = entries.find(g => !g.group.hosts.length);
    return empty ? [hint('Add the root hostname to this empty group:', 'add', 'host', empty.group.name, '@')] : [];
}

export function quoteArgument(value: string, platform = process.platform): string {
    if (/^[a-zA-Z0-9_./:=-]+$/.test(value)) {
        return value;
    }
    const escaped = platform === 'win32' ? value.replaceAll("'", "''") : value.replaceAll("'", "'\\''");
    return `'${escaped}'`;
}

export function formatHints(hints: Hint[], source?: string, platform = process.platform): string {
    const prefix = source ? ['hostman', '--hosts-file', source] : ['hostman'];
    return '\nNext steps:\n' + hints.map(item => {
        const commands = [item.args, ...item.additional ?? []].map(args =>
            `    ${[...prefix, ...args].map(arg => quoteArgument(arg, platform)).join(' ')}`);
        return `  ${item.description}\n${commands.join('\n')}`;
    }).join('\n\n');
}

export function relatedHints(key: string): Hint[] {
    if (key === 'init') {
        return [hint('Import existing rules:', 'migrate', '--dry-run'), create()];
    }
    if (key === 'add group') {
        return [hint('Add a hostname:', 'add', 'host', 'example.com', 'api'), view('example.com')];
    }
    if (key === 'global remove' || key === 'global set') {
        return [view('all')];
    }
    if (key.startsWith('global')) {
        return [hint('Reference a global target:', 'target', 'add', 'example.com', 'shared', '@local'), view('all')];
    }
    if (key.startsWith('target') || key === 'add host') {
        return [hint('Switch targets:', 'use', 'example.com', 'lab'), view('example.com')];
    }
    if (key === 'show') {
        return [create(), hint('Review repair options:', 'repair', '--help')];
    }
    if (key === 'disable') {
        return [hint('Enable the group again:', 'enable', 'example.com')];
    }
    return [view(key === 'migrate' || key === 'remove group' ? 'all' : 'example.com')];
}

export function errorHints(message: string, args: string[]): Hint[] {
    if (message.includes('No hostman section')) {
        return [hint('Initialize hostman before creating mappings:', 'init'),
            hint('Or preview existing rules for import:', 'migrate', '--dry-run')];
    }
    if (message.includes('outside hostman')) {
        return [hint('Preview existing rules for import instead of duplicating them:', 'migrate', '--dry-run')];
    }
    if (/conflict|structural repair/i.test(message)) {
        return [hint('Inspect the current document:', 'show', 'all'),
            hint('Review repair strategies:', 'repair', '--help')];
    }
    if (message.includes('Cannot remove the active target')) {
        return [hint('Inspect available targets before choosing another:', 'show', 'all'),
            hint('Learn how to switch before removing a target:', 'use', '--help')];
    }
    return [hint('Review command arguments and requirements:', ...args, '--help')];
}
