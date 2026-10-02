import { isIP } from 'node:net';
import {
    emptyDocument, groupDigest, ipKey, normalizeHost, resolveTarget, validate, validHost,
    type Conflict, type Group, type HostmanDocument
} from '../domain/model.js';
export type Line = {
    raw: string;
    content: string;
    start: number;
    end: number;
};
export type Rule = {
    line: Line;
    ip: string;
    hosts: string[];
    tokens: {
        value: string;
        start: number;
        end: number;
    }[];
    comment: string;
};
export type ParsedGroup = {
    group: Group;
    start: number;
    end: number;
    hash?: string;
    effective: Rule[];
    status: 'CLEAN' | 'DIRTY' | 'CONFLICT';
};
export type ParseResult = {
    document: HostmanDocument;
    groups: ParsedGroup[];
    conflicts: Conflict[];
    documentFatal: boolean;
    outer?: {
        start: number;
        end: number;
        bodyStart: number;
        bodyEnd: number;
    };
    lines: Line[];
    unmanaged: Rule[];
    eol: string;
    bom: string;
    text: string;
};
export function linesOf(text: string): Line[] {
    const lines: Line[] = [];
    const re = /[^\r\n]*(?:\r\n|\n|\r|$)/g;
    for (const m of text.matchAll(re)) {
        if (m[0]) {
            lines.push({
                raw: m[0],
                content: m[0].replace(/[\r\n]+$/,
                    ''),
                start: m.index,
                end: m.index + m[0].length
            });
        }
    }
    return lines;
}
export function ruleOf(line: Line): Rule | undefined {
    const index = line.content.indexOf('#');
    const body = index < 0 ? line.content : line.content.slice(0,
        index);
    const tokens = [...body.matchAll(/\S+/g)].map(m => ({
        value: m[0],
        start: m.index,
        end: m.index + m[0].length
    }));
    if (tokens.length < 2 || !isIP(tokens[0].value)) {
        return;
    }
    return {
        line,
        ip: tokens[0].value,
        hosts: tokens.slice(1).map(t => normalizeHost(t.value)),
        tokens,
        comment: index < 0 ? '' : line.content.slice(index)
    };
}
export function parse(text: string): ParseResult {
    const result: ParseResult = {
        document: emptyDocument(),
        groups: [],
        conflicts: [],
        documentFatal: false,
        lines: linesOf(text),
        unmanaged: [],
        eol: text.match(/\r\n|\n|\r/)?.[0] ?? '\n',
        bom: text.startsWith('\uFEFF') ? '\uFEFF' : '',
        text
    };
    let inside = false, current: ParsedGroup | undefined, seen = false;
    const conflict = (type: Conflict['type'], message: string, group?: string, fatal = false) => {
        result.conflicts.push({
            type,
            message,
            group
        });
        result.documentFatal ||= fatal;
    };
    for (const line of result.lines) {
        const content = line.content.replace(/^\uFEFF/,
            '').trim();
        if (content === '# >>> hostman v1') {
            if (inside || seen) {
                conflict('MalformedMarkerConflict',
                    'Duplicate or nested hostman marker.',
                    undefined,
                    true);
            }
            inside = true;
            seen = true;
            result.outer = {
                start: line.start + (line.content.startsWith('\uFEFF') ? 1 : 0),
                end: text.length,
                bodyStart: line.end,
                bodyEnd: text.length
            };
            continue;
        }
        if (content === '# <<< hostman') {
            if (!inside || current) {
                conflict('MalformedMarkerConflict',
                    'Unpaired hostman closing marker.',
                    undefined,
                    true);
            }
            inside = false;
            if (result.outer) {
                result.outer.bodyEnd = line.start;
                result.outer.end = line.end;
            }
            continue;
        }
        if (!inside) {
            if (/^#\s*(?:>>>|<<<)\s*(?:hostman|group)\b/.test(content)) {
                conflict('MalformedMarkerConflict',
                    'Unexpected marker outside hostman.',
                    undefined,
                    true);
            }
            const rule = ruleOf(line);
            if (rule) {
                result.unmanaged.push(rule);
            }
            continue;
        }
        const opening = content.match(/^# >>> group (\S+) enabled=(true|false) active=(\S+)(?: hash=([a-f0-9]{8}))?$/);
        if (opening) {
            if (current) {
                conflict('MalformedMarkerConflict',
                    'Nested group marker.',
                    undefined,
                    true);
            }
            const group: Group = {
                name: normalizeHost(opening[1]),
                enabled: opening[2] === 'true',
                activeTarget: opening[3],
                targets: [],
                hosts: []
            };
            current = {
                group,
                start: line.start,
                end: text.length,
                hash: opening[4],
                effective: [],
                status: 'CLEAN'
            };
            result.groups.push(current);
            result.document.groups.push(group);
            continue;
        }
        const closing = content.match(/^# <<< group (\S+)$/);
        if (closing) {
            if (!current || closing[1].toLowerCase() !== current.group.name) {
                conflict('MalformedMarkerConflict',
                    'Unpaired group closing marker.',
                    undefined,
                    true);
            }
            if (current) {
                current.end = line.end;
            }
            current = undefined;
            continue;
        }
        if (/^#\s*(?:>>>|<<<)/.test(content)) {
            conflict('MalformedMarkerConflict',
                'Malformed or unsupported marker.',
                undefined,
                true);
            continue;
        }
        if (!current) {
            const global = content.match(/^# global ([^=\s]+)=(\S+)$/);
            if (global) {
                result.document.globals.push({
                    name: global[1],
                    ip: global[2]
                });
            } else if (content && (!content.startsWith('#') || /^#\s*(?:global|target|host)\b/.test(content))) {
                conflict('MalformedMarkerConflict',
                    `Unexpected managed content: ${content}`,
                    undefined,
                    true);
            }
            continue;
        }
        const target = content.match(/^# target ([^=\s]+)=(\S+)$/);
        const host = content.match(/^# host (\S+)$/);
        const rule = ruleOf(line);
        if (target) {
            current.group.targets.push(target[2].startsWith('@') ? {
                name: target[1],
                source: 'global',
                globalName: target[2].slice(1)
            } : {
                name: target[1],
                source: 'group',
                ip: target[2]
            });
        } else if (host) {
            current.group.hosts.push(normalizeHost(host[1]));
            if (current.group.enabled) {
                conflict('EffectiveIpConflict',
                    'Enabled group contains disabled host definitions.',
                    current.group.name);
            }
        } else if (rule) {
            current.effective.push(rule);
            current.group.hosts.push(...rule.hosts);
        } else if (content && (!content.startsWith('#') || /^#\s*(?:global|target|host)\b/.test(content))) {
            conflict('InvalidManagedContentConflict',
                `Unexpected group content: ${content}`,
                current.group.name);
        }
    }
    if (inside || current) {
        conflict('MalformedMarkerConflict',
            'Unclosed managed marker.',
            undefined,
            true);
    }
    result.conflicts.push(...validate(result.document,
        new Set(result.unmanaged.flatMap(r => r.hosts))));
    if (result.conflicts.some(c => !c.group)) {
        result.documentFatal = true;
    }
    for (const entry of result.groups) {
        try {
            const ip = resolveTarget(result.document,
                entry.group);
            if ((!entry.group.enabled && entry.effective.length)
                || entry.effective.some(r => ipKey(r.ip) !== ipKey(ip))) {
                conflict('EffectiveIpConflict',
                    'Effective rules disagree with enabled state or active target IP.',
                    entry.group.name);
            }
        } catch { /* Domain validation already reports missing references. */ }
        const conflicted = result.documentFatal || result.conflicts.some(c => c.group === entry.group.name);
        entry.status = conflicted ? 'CONFLICT' : entry.hash === groupDigest(entry.group) ? 'CLEAN' : 'DIRTY';
    }
    return result;
}
export function serializeGroup(doc: HostmanDocument, group: Group, eol = '\n'): string {
    const lines = [
        `# >>> group ${group.name} enabled=${group.enabled}`
        + ` active=${group.activeTarget} hash=${groupDigest(group)}`
    ];
    for (const t of [...group.targets].sort((a, b) => a.name.localeCompare(b.name,
        'en'))) {
        lines.push(`# target ${t.name}=${t.source === 'global' ? `@${t.globalName}` : t.ip}`);
    }
    for (const h of [...group.hosts].sort()) {
        lines.push(group.enabled ? `${resolveTarget(doc,
            group)} ${h}` : `# host ${h}`);
    }
    lines.push(`# <<< group ${group.name}`);
    return lines.join(eol) + eol;
}
export function serialize(
    parsed: ParseResult,
    doc: HostmanDocument,
    touched: Set<string> = new Set(doc.groups.map(g => g.name))
): string {
    const eol = parsed.eol;
    const globalLines = doc.globals.map(t => `# global ${t.name}=${t.ip}`).join(eol);
    if (!parsed.outer) {
        const prefix = parsed.text && !/[\r\n]$/.test(parsed.text) && parsed.text !== parsed.bom ? eol : '';
        return parsed.text + prefix + `# >>> hostman v1${eol}`
            + (globalLines ? globalLines + eol : '') + doc.groups.map(g => serializeGroup(doc,
            g,
            eol)).join('') + `# <<< hostman${eol}`;
    }
    const edits: {
        start: number;
        end: number;
        text: string;
    }[] = [];
    for (const old of parsed.groups) {
        const group = doc.groups.find(g => g.name === old.group.name);
        if (!group) {
            edits.push({
                start: old.start,
                end: old.end,
                text: ''
            });
        } else if (touched.has(group.name)) {
            edits.push({
                start: old.start,
                end: old.end,
                text: serializeGroup(doc,
                    group,
                    eol)
            });
        }
    }
    const added = doc.groups.filter(g => !parsed.groups.some(p => p.group.name === g.name));
    if (added.length) {
        edits.push({
            start: parsed.outer.bodyEnd,
            end: parsed.outer.bodyEnd,
            text: added.map(g => serializeGroup(doc,
                g,
                eol)).join('')
        });
    }
    if (JSON.stringify(doc.globals) !== JSON.stringify(parsed.document.globals)) {
        for (const line of parsed.lines) {
            if (line.start >= parsed.outer.bodyStart && line.end <= parsed.outer.bodyEnd
                && /^# global /.test(line.content.trim())) {
                edits.push({
                    start: line.start,
                    end: line.end,
                    text: ''
                });
            }
        }
        edits.push({
            start: parsed.outer.bodyStart,
            end: parsed.outer.bodyStart,
            text: globalLines ? globalLines + eol : ''
        });
    }
    let output = parsed.text;
    for (const edit of edits.sort((a, b) => b.start - a.start || b.end - a.end)) {
        output = output.slice(0,
            edit.start) + edit.text + output.slice(edit.end);
    }
    return output;
}
export type Candidate = {
    group: string;
    hosts: string[];
    ip: string;
    reason?: string;
};
export function candidates(parsed: ParseResult): Candidate[] {
    const entries = new Map<string, {
        host: string;
        ip: string;
    }[]>();
    for (const rule of parsed.unmanaged) {
        for (const host of rule.hosts) {
            if (!validHost(host) || ['localhost.localdomain', 'localhost6.localdomain6'].includes(host)
                || host.endsWith('.localhost')) {
                continue;
            }
            const name = host.split('.').slice(-2).join('.');
            const list = entries.get(name) ?? [];
            list.push({
                host,
                ip: rule.ip
            });
            entries.set(name,
                list);
        }
    }
    return [...entries].map(([name, list]) => {
        const group = parsed.document.groups.find(g => g.name === name);
        let reason: string | undefined;
        if (new Set(list.map(x => ipKey(x.ip))).size !== 1) {
            reason = 'Multiple candidate IPs.';
        }
        if (new Set(list.map(x => x.host)).size !== list.length) {
            reason = 'Duplicate unmanaged hostname.';
        }
        if (group) {
            if (!group.enabled) {
                reason = 'Existing group is disabled.';
            } else if (parsed.groups.find(p => p.group.name === name)?.status === 'CONFLICT') {
                reason = 'Existing group is conflicted.';
            } else if (list.some(x => ipKey(x.ip) !== ipKey(resolveTarget(parsed.document,
                group)))) {
                reason = 'Candidate IP differs from active target.';
            }
        }
        if (list.some(x => parsed.document.groups.some(g => g.hosts.includes(x.host)))) {
            reason = 'Hostname is already managed.';
        }
        if (parsed.documentFatal) {
            reason = 'Managed document has structural conflicts.';
        }
        return {
            group: name,
            hosts: list.map(x => x.host),
            ip: list[0].ip,
            reason
        };
    }).sort((a, b) => a.group.localeCompare(b.group,
        'en'));
}
export function removeImported(parsed: ParseResult, hosts: Set<string>): string {
    let output = parsed.text;
    for (const rule of [...parsed.unmanaged].reverse()) {
        const selected = rule.tokens.slice(1).filter(t => hosts.has(normalizeHost(t.value)));
        if (!selected.length) {
            continue;
        }
        let replacement = rule.line.raw;
        if (selected.length === rule.hosts.length) {
            replacement = rule.comment ? rule.comment + rule.line.raw.slice(rule.line.content.length) : '';
        } else {
            for (const token of selected.reverse()) {
                replacement = replacement.slice(0,
                    token.start) + replacement.slice(token.end);
            }
        }
        output = output.slice(0,
            rule.line.start) + replacement + output.slice(rule.line.end);
    }
    return parsed.bom && !output.startsWith(parsed.bom) ? parsed.bom + output : output;
}
