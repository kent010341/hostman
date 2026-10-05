import { isIP } from 'node:net';
import {
    HostmanError, belongs, ipKey, normalizeHost, resolveTarget, validate, validName,
    type Group, type HostmanDocument, type Target
} from '#hostman/domain/model';
import {
    candidates, importedName, migrationFailure, parse, removeImported, serialize, type Candidate, type CandidateTarget
} from '#hostman/hosts/document';
/** A user-selected name for a newly imported semantic IP target. */
export type MigrationTargetName = {
    /** Group receiving the target. */
    group: string;
    /** Candidate IP, compared semantically during replay. */
    ip: string;
    /** Valid target name unique within the group. */
    name: string;
};
/** Replayable domain mutation, including optional migration target names. */
export type Operation = {
    kind: 'init';
} | {
    kind: 'migrate';
    /** Explicitly selected candidate groups. */
    groups: string[];
    /** Optional names collected before any write or elevation. */
    targetNames?: MigrationTargetName[];
} | {
    kind: 'add-group';
    group: Group;
} | {
    kind: 'remove-group' | 'enable' | 'disable';
    group: string;
} | {
    kind: 'add-host' | 'remove-host';
    group: string;
    host: string;
} | {
    /** Select a group-owned or directly shared destination. */
    kind: 'use';
    /** Group receiving the selection. */
    group: string;
    /** Group target name or @global name. */
    target: string;
} | {
    /** Define or replace a group-owned literal destination. */
    kind: 'target-add' | 'target-set';
    /** Group owning the destination. */
    group: string;
    /** Named literal IP, without a global reference. */
    target: Target;
} | {
    kind: 'target-remove';
    group: string;
    target: string;
} | {
    kind: 'global-add' | 'global-set';
    name: string;
    ip: string;
} | {
    kind: 'global-remove';
    name: string;
} | {
    kind: 'repair';
    group: string;
    strategy: 'restore' | 'keep';
    ip?: string;
};
export function expandHost(group: string, value: string): string {
    const host = normalizeHost(value === '@' ? group : value.includes('.') ? value : `${value}.${group}`);
    if (!belongs(host,
        group)) {
        throw new HostmanError(`${host} does not belong to ${group}.`);
    }
    return host;
}
/**
 * Apply one mutation to a clone and validate its affected scope.
 * @param document Original managed state, left unchanged.
 * @param operation Complete replayable mutation.
 * @returns Updated state and groups requiring serialization.
 */
export function applyOperation(document: HostmanDocument, operation: Operation): {
    document: HostmanDocument;
    touched: Set<string>;
} {
    const doc: HostmanDocument = structuredClone(document), touched = new Set<string>();
    const group = (name: string): Group => {
        const g = doc.groups.find(x => x.name === name);
        if (!g) {
            throw new HostmanError(`Unknown group ${name}.`);
        }
        touched.add(name);
        return g;
    };
    switch (operation.kind) {
        case 'init':
        case 'migrate': break;
        case 'add-group':
            if (doc.groups.some(g => g.name === operation.group.name)) {
                throw new HostmanError('Group already exists.');
            }
            doc.groups.push(structuredClone(operation.group));
            touched.add(operation.group.name);
            break;
        case 'remove-group':
            group(operation.group);
            doc.groups = doc.groups.filter(g => g.name !== operation.group);
            break;
        case 'enable':
        case 'disable':
            group(operation.group).enabled = operation.kind === 'enable';
            break;
        case 'add-host':
        case 'remove-host': {
            const g = group(operation.group), host = expandHost(g.name,
                operation.host);
            if (operation.kind === 'add-host') {
                if (doc.groups.some(x => x.hosts.includes(host))) {
                    throw new HostmanError(`Hostname ${host} already exists.`);
                }
                g.hosts.push(host);
            } else {
                if (!g.hosts.includes(host)) {
                    throw new HostmanError(`Unknown hostname ${host}.`);
                }
                g.hosts = g.hosts.filter(h => h !== host);
            }
            break;
        }
        case 'use': {
            /** Group whose selected destination changes without adding targets. */
            const g = group(operation.group);
            resolveTarget(doc,
                g,
                operation.target);
            g.activeTarget = operation.target;
            break;
        }
        case 'target-add':
        case 'target-set': {
            const g = group(operation.group), index = g.targets.findIndex(t => t.name === operation.target.name);
            if (operation.kind === 'target-add' && index >= 0) {
                throw new HostmanError('Target already exists.');
            }
            if (operation.kind === 'target-set' && index < 0) {
                throw new HostmanError('Unknown target.');
            }
            if (index < 0) {
                g.targets.push(operation.target);
            } else {
                g.targets[index] = operation.target;
            }
            break;
        }
        case 'target-remove': {
            const g = group(operation.group);
            if (g.activeTarget === operation.target) {
                throw new HostmanError('Cannot remove the active target. Switch targets first.');
            }
            if (!g.targets.some(t => t.name === operation.target)) {
                throw new HostmanError('Unknown target.');
            }
            g.targets = g.targets.filter(t => t.name !== operation.target);
            break;
        }
        case 'global-add':
        case 'global-set': {
            const index = doc.globals.findIndex(t => t.name === operation.name);
            if (operation.kind === 'global-add' && index >= 0) {
                throw new HostmanError('Global target already exists.');
            }
            if (operation.kind === 'global-set' && index < 0) {
                throw new HostmanError('Unknown global target.');
            }
            if (index < 0) {
                doc.globals.push({
                    name: operation.name,
                    ip: operation.ip
                });
            } else {
                doc.globals[index].ip = operation.ip;
            }
            for (const g of doc.groups) {
                if (g.enabled && g.activeTarget === `@${operation.name}`) {
                    touched.add(g.name);
                }
            }
            break;
        }
        case 'global-remove': {
            /** Groups retaining this shared selection, including disabled groups. */
            const references = doc.groups.filter(g => g.activeTarget === `@${operation.name}`);
            if (references.length) {
                /** Group names explaining why deletion is blocked. */
                const names = references.map(g => g.name).join(', ');
                throw new HostmanError(`Cannot remove selected global target ${operation.name}: ${names}.`);
            }
            if (!doc.globals.some(t => t.name === operation.name)) {
                throw new HostmanError('Unknown global target.');
            }
            doc.globals = doc.globals.filter(t => t.name !== operation.name);
            break;
        }
        case 'repair': {
            const g = group(operation.group);
            if (operation.strategy === 'keep') {
                /** Only literal group targets may adopt an effective IP. */
                const target = g.targets.find(t => t.name === g.activeTarget);
                if (!target) {
                    throw new HostmanError('Keep effective IP requires a group-owned active target. '
                        + 'Repair shared globals explicitly.');
                }
                if (!operation.ip) {
                    throw new HostmanError('Repair requires an effective IP.');
                }
                target.ip = operation.ip;
            }
            break;
        }
        default: throw new HostmanError('Unsupported operation.');
    }
    const conflicts = validate(doc).filter(c => !c.group || touched.has(c.group));
    if (conflicts.length) {
        throw new HostmanError(conflicts.map(c => c.message).join('\n'));
    }
    return {
        document: doc,
        touched
    };
}
/**
 * Apply validated migration names while allocating deterministic defaults.
 * @param candidate Current source-derived migration proposal.
 * @param names Validated naming overrides collected by the CLI.
 * @param reserved Existing target names, including targets absent from the proposal.
 * @returns Candidate targets with their final names.
 */
export function migrationTargets(
    candidate: Candidate,
    names: MigrationTargetName[],
    reserved: string[]
): CandidateTarget[] {
    /** Target names unavailable for new definitions. */
    const used = new Set(reserved);
    return candidate.targets.map(target => {
        if (!target.create) {
            return target;
        }
        /** Explicit name for this group and semantic IP, if supplied. */
        const override = names.find(n => n.group === candidate.group && ipKey(n.ip) === ipKey(target.ip));
        /** Final name, allocated against previously accepted names. */
        const name = override?.name ?? importedName(used);
        if (!validName(name) || used.has(name)) {
            throw new HostmanError(`Invalid or duplicate migration target name ${name} in ${candidate.group}.`);
        }
        used.add(name);
        return { ...target, name };
    });
}
/**
 * Transform current hosts text through a validated replayable operation.
 * @param text Original selected hosts source.
 * @param operation Requested mutation, including any migration names.
 * @returns Validated transformed text, or the original text for a no-op.
 */
export function transform(text: string, operation: Operation): string {
    /** Parsed source refreshed after imported aliases have been removed. */
    let parsed = parse(text);
    if (parsed.documentFatal) {
        throw new HostmanError(parsed.conflicts.map(c => c.message).join('\n'));
    }
    if (operation.kind === 'init') {
        if (parsed.conflicts.length) {
            throw new HostmanError('Resolve managed conflicts before initialization.');
        }
        return parsed.outer ? text : serialize(parsed,
            parsed.document,
            new Set());
    }
    if (operation.kind === 'migrate') {
        /** Current proposals; caller input never supplies source-derived group state. */
        const found = candidates(parsed);
        /** Explicitly selected proposals. */
        const chosen = found.filter(c => operation.groups.includes(c.group));
        for (const name of operation.groups) {
            if (!found.some(c => c.group === name) && !parsed.document.groups.some(g => g.name === name)) {
                throw new HostmanError(`No candidate or managed group ${name}.`);
            }
        }
        if (chosen.some(c => c.reason)) {
            throw new HostmanError(chosen.filter(c => c.reason).map(migrationFailure).join('\n'));
        }
        /** Naming payload is untrusted when received through the helper protocol. */
        const payload: unknown = operation.targetNames === undefined ? [] : operation.targetNames;
        if (!Array.isArray(payload)) {
            throw new HostmanError('Invalid migration target names.');
        }
        /** Narrowed overrides checked against current candidate IPs and selection. */
        const names: MigrationTargetName[] = [];
        for (const value of payload as unknown[]) {
            if (!value || typeof value !== 'object' || !('group' in value) || typeof value.group !== 'string'
                || !('ip' in value) || typeof value.ip !== 'string' || !isIP(value.ip)
                || !('name' in value) || typeof value.name !== 'string' || !validName(value.name)) {
                throw new HostmanError('Invalid migration target name.');
            }
            /** Stable narrowed entry for candidate checks and helper replay. */
            const entry = { group: value.group, ip: value.ip, name: value.name };
            if (!chosen.some(c => c.group === entry.group
                && c.targets.some(t => t.create && ipKey(t.ip) === ipKey(entry.ip)))
                || names.some(n => n.group === entry.group && ipKey(n.ip) === ipKey(entry.ip))) {
                throw new HostmanError('Invalid, duplicate, or unrelated migration target name.');
            }
            names.push(entry);
        }
        if (!chosen.length) {
            return text;
        }
        /** Original newline style survives complete removal of all source rules. */
        const originalEol = parsed.eol;
        parsed = parse(removeImported(parsed,
            new Set(chosen.flatMap(c => c.hosts))));
        parsed.eol = originalEol;
        /** Managed document after removal, preserving unrelated groups. */
        const doc = structuredClone(parsed.document);
        for (const candidate of chosen) {
            /** Existing group, when this is a compatible incremental import. */
            const g = doc.groups.find(g => g.name === candidate.group);
            /** Final target names shared by normal commits and helper replay. */
            const targets = migrationTargets(candidate, names, g?.targets.map(t => t.name) ?? []);
            if (g) {
                g.hosts = [...new Set([...g.hosts, ...candidate.hosts])];
                g.targets.push(...targets.filter(t => t.create).map(t => ({
                    name: t.name, ip: t.ip
                })));
            } else {
                /** Original selected IP identifies the renamed active target without changing its semantics. */
                const active = candidate.targets.find(t => t.name === candidate.activeTarget)!;
                doc.groups.push({
                    name: candidate.group,
                    enabled: candidate.enabled,
                    activeTarget: targets.find(t => ipKey(t.ip) === ipKey(active.ip))!.name,
                    targets: targets.map(t => ({ name: t.name, ip: t.ip })),
                    hosts: candidate.hosts
                });
            }
        }
        return checked(serialize(parsed,
            doc,
            new Set(chosen.map(c => c.group))),
        new Set(chosen.map(c => c.group)));
    }
    const affected = 'group' in operation
        ? typeof operation.group === 'string' ? operation.group : operation.group.name
        : undefined;
    /** Global mutations also validate groups directly selecting the shared destination. */
    const hasAffectedConflict = parsed.conflicts.some(c => !c.group || c.group === affected
        || (!affected && parsed.document.groups.some(g => g.name === c.group
            && 'name' in operation && g.activeTarget === `@${operation.name}`)));
    if (operation.kind !== 'repair' && hasAffectedConflict) {
        throw new HostmanError('Conflicted scope. Run hostman repair before mutation.');
    }
    if (operation.kind === 'repair') {
        const group = parsed.groups.find(g => g.group.name === operation.group);
        if (!group) {
            throw new HostmanError(`Unknown group ${operation.group}.`);
        }
        if (parsed.conflicts.some(c => c.group === operation.group && c.type !== 'EffectiveIpConflict')) {
            throw new HostmanError('This conflict requires manual structural repair.');
        }
        if (operation.strategy === 'keep') {
            const ips = new Set(group.effective.map(r => ipKey(r.ip)));
            if (ips.size !== 1 || !operation.ip || !ips.has(ipKey(operation.ip))) {
                throw new HostmanError('Keep requires one unambiguous effective IP.');
            }
        }
    }
    const { document, touched } = applyOperation(parsed.document,
        operation);
    if (!parsed.outer) {
        throw new HostmanError('No hostman section. Run hostman init or migrate first.');
    }
    if (operation.kind !== 'repair'
        && JSON.stringify(document) === JSON.stringify(parsed.document)
        && [...touched].every(name => parsed.groups.find(g => g.group.name === name)?.status === 'CLEAN')) {
        return text;
    }
    return checked(serialize(parsed,
        document,
        touched),
    touched);
}
function checked(text: string, touched: Set<string>): string {
    const parsed = parse(text);
    const conflicts = parsed.conflicts.filter(c => parsed.documentFatal || !c.group || touched.has(c.group));
    if (conflicts.length) {
        throw new HostmanError(conflicts.map(c => c.message).join('\n'));
    }
    return text;
}
