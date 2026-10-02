import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
export type Target = {
    name: string;
    source: 'global';
    globalName: string;
} | {
    name: string;
    source: 'group';
    ip: string;
};
export type Group = {
    name: string;
    enabled: boolean;
    activeTarget: string;
    targets: Target[];
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
export function resolveTarget(doc: HostmanDocument, group: Group, name = group.activeTarget): string {
    const target = group.targets.find(t => t.name === name);
    if (!target) {
        throw new HostmanError(`Missing target "${name}" in ${group.name}.`);
    }
    if (target.source === 'group') {
        return target.ip;
    }
    const global = doc.globals.find(t => t.name === target.globalName);
    if (!global) {
        throw new HostmanError(`Missing global target "${target.globalName}" in ${group.name}.`);
    }
    return global.ip;
}
export function groupDigest(group: Group): string {
    const targets = [...group.targets].sort((a, b) => a.name.localeCompare(b.name,
        'en')).map(t => `target:${t.name}=${t.source === 'global' ? `@${t.globalName}` : ipKey(t.ip)}`);
    return sha256([
        `group=${group.name}`,
        `enabled=${group.enabled}`,
        `active=${group.activeTarget}`,
        ...targets,
        ...[...group.hosts].sort().map(h => `host:${h}`)
    ].join('\n')).slice(0,
        8);
}
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
            if (t.source === 'group' && !isIP(t.ip)) {
                add('InvalidIpConflict',
                    `Invalid IP ${t.ip}.`,
                    g.name);
            }
            if (t.source === 'global' && !globals.has(t.globalName)) {
                add('MissingGlobalTargetConflict',
                    `Missing global target ${t.globalName}.`,
                    g.name);
            }
        }
        if (!targets.has(g.activeTarget)) {
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
