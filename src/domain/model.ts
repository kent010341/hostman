import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
/** A group-owned destination containing a literal IP address. */
export type Target = {
    /** Name used to select this destination within its group. */
    name: string;
    /** Literal IPv4 or IPv6 destination. */
    ip: string;
};
/** Owned hostnames sharing one group or global destination selection. */
export type Group = {
    /** Two-label root domain identifying the group. */
    name: string;
    /** Whether the group emits effective hosts mappings. */
    enabled: boolean;
    /** Group target name or @global name selected for this group. */
    activeTarget: string;
    /** Literal destinations; may be empty when a global is selected. */
    targets: Target[];
    /** Hostnames owned exclusively by this group. */
    hosts: string[];
};
export type HostmanDocument = {
    version: 1;
    globals: {
        name: string;
        ip: string;
    }[];
    groups: Group[];
};
export type ConflictType =
    | 'DuplicateGlobalTargetConflict'
    | 'DuplicateGroupConflict'
    | 'DuplicateHostnameConflict'
    | 'DuplicateTargetConflict'
    | 'InvalidGroupHostnameConflict'
    | 'InvalidIpConflict'
    | 'InvalidTargetNameConflict'
    | 'MissingGlobalTargetConflict'
    | 'MissingTargetConflict'
    | 'UnmanagedHostnameConflict'
    | 'EffectiveIpConflict'
    | 'InvalidManagedContentConflict'
    | 'MalformedMarkerConflict';
export type Conflict = {
    type: ConflictType;
    message: string;
    group?: string;
};
export class HostmanError extends Error {
}
export const sha256 = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex');
export const emptyDocument = (): HostmanDocument => ({
    version: 1,
    globals: [],
    groups: []
});
export const validName = (name: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name);
export const normalizeHost = (host: string): string => host.toLowerCase();
export const validHost = (host: string): boolean => host.length <= 253
    && host.split('.').length >= 2
    && host.split('.').every(label => label.length <= 63
        && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
    && !isIP(host);
export const belongs = (host: string, group: string): boolean => host === group || host.endsWith(`.${group}`);
export function ipKey(ip: string): string {
    if (isIP(ip) === 6) {
        const [address, ...zone] = ip.split('%');
        return new URL(`http://[${address}]/`).hostname.toLowerCase() + (zone.length ? `%${zone.join('%')}` : '');
    }
    return ip;
}
/**
 * Resolve a group destination or an explicit global selection.
 * @param doc Managed global definitions.
 * @param group Group owning the selection.
 * @param name Group target name or @global name; defaults to the active selection.
 * @returns The selected literal IP address.
 */
export function resolveTarget(doc: HostmanDocument, group: Group, name = group.activeTarget): string {
    if (name.startsWith('@')) {
        /** Global name without the selection prefix. */
        const globalName = name.slice(1);
        if (!validName(globalName)) {
            throw new HostmanError(`Invalid global target name "${globalName}" in ${group.name}.`);
        }
        /** Shared definition selected directly by the group. */
        const global = doc.globals.find(t => t.name === globalName);
        if (!global) {
            throw new HostmanError(`Missing global target "${globalName}" in ${group.name}.`);
        }
        return global.ip;
    }
    /** Group-owned target selected without a global prefix. */
    const target = group.targets.find(t => t.name === name);
    if (!target) {
        throw new HostmanError(`Missing target "${name}" in ${group.name}.`);
    }
    return target.ip;
}
/**
 * Hash group configuration independently of target and hostname ordering.
 * @param group Configuration including the direct destination selection.
 * @returns Eight-character semantic SHA-256 digest.
 */
export function groupDigest(group: Group): string {
    /** Canonical literal destination definitions. */
    const targets = [...group.targets].sort((a, b) => a.name.localeCompare(b.name,
        'en')).map(t => `target:${t.name}=${ipKey(t.ip)}`);
    return sha256([
        `group=${group.name}`,
        `enabled=${group.enabled}`,
        `active=${group.activeTarget}`,
        ...targets,
        ...[...group.hosts].sort().map(h => `host:${h}`)
    ].join('\n')).slice(0,
        8);
}
/**
 * Validate ownership, literal destinations and group or global active selections.
 * @param doc Reconstructed managed definitions.
 * @param unmanaged Effective hostnames outside the managed section.
 * @returns All structural and group-scoped domain conflicts.
 */
export function validate(doc: HostmanDocument, unmanaged: Set<string> = new Set()): Conflict[] {
    const conflicts: Conflict[] = [];
    const add = (type: ConflictType, message: string, group?: string) => conflicts.push({
        type,
        message,
        group
    });
    const globals = new Set<string>();
    for (const t of doc.globals) {
        if (globals.has(t.name)) {
            add('DuplicateGlobalTargetConflict',
                `Duplicate global target ${t.name}.`);
        }
        globals.add(t.name);
        if (!validName(t.name)) {
            add('InvalidTargetNameConflict',
                `Invalid global target name ${t.name}.`);
        }
        if (!isIP(t.ip)) {
            add('InvalidIpConflict',
                `Invalid global IP ${t.ip}.`);
        }
    }
    const groups = new Set<string>(), hosts = new Map<string, string>();
    for (const g of doc.groups) {
        if (groups.has(g.name)) {
            add('DuplicateGroupConflict',
                `Duplicate group ${g.name}.`,
                g.name);
        }
        groups.add(g.name);
        if (!validHost(g.name) || g.name.split('.').length !== 2) {
            add('InvalidGroupHostnameConflict',
                `Invalid two-label group ${g.name}.`,
                g.name);
        }
        const targets = new Set<string>();
        for (const t of g.targets) {
            if (targets.has(t.name)) {
                add('DuplicateTargetConflict',
                    `Duplicate target ${t.name}.`,
                    g.name);
            }
            targets.add(t.name);
            if (!validName(t.name)) {
                add('InvalidTargetNameConflict',
                    `Invalid target name ${t.name}.`,
                    g.name);
            }
            if (!isIP(t.ip)) {
                add('InvalidIpConflict',
                    `Invalid IP ${t.ip}.`,
                    g.name);
            }
        }
        if (g.activeTarget.startsWith('@')) {
            /** Direct global selection, independent of group-owned targets. */
            const globalName = g.activeTarget.slice(1);
            if (!validName(globalName)) {
                add('InvalidTargetNameConflict', `Invalid global target name ${globalName}.`, g.name);
            } else if (!globals.has(globalName)) {
                add('MissingGlobalTargetConflict', `Missing global target ${globalName}.`, g.name);
            }
        } else if (!targets.has(g.activeTarget)) {
            add('MissingTargetConflict',
                `Missing active target ${g.activeTarget}.`,
                g.name);
        }
        for (const h of g.hosts) {
            if (!validHost(h) || !belongs(h,
                g.name)) {
                add('InvalidGroupHostnameConflict',
                    `Hostname ${h} does not belong to ${g.name}.`,
                    g.name);
            }
            const owner = hosts.get(h);
            if (owner) {
                add('DuplicateHostnameConflict',
                    `Duplicate hostname ${h}.`,
                    g.name);
                if (owner !== g.name) {
                    add('DuplicateHostnameConflict',
                        `Duplicate hostname ${h}.`,
                        owner);
                }
            }
            hosts.set(h,
                g.name);
            if (unmanaged.has(h)) {
                add('UnmanagedHostnameConflict',
                    `${h} also exists outside hostman.`,
                    g.name);
            }
        }
    }
    return conflicts;
}
