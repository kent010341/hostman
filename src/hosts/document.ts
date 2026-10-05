import { isIP } from 'node:net';
import {
    emptyDocument, groupDigest, ipKey, normalizeHost, resolveTarget, validate, validHost,
    type Conflict, type Group, type HostmanDocument
} from '#hostman/domain/model';
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
/** An unmanaged rule eligible for migration scanning, including its effective state. */
export type MigrationRule = Rule & {
    /** Whether the rule currently contributes an effective hosts mapping. */
    enabled: boolean;
};
export type ParsedGroup = {
    group: Group;
    start: number;
    end: number;
    hash?: string;
    effective: Rule[];
    status: 'CLEAN' | 'DIRTY' | 'CONFLICT';
};
/** Parsed source, managed validation state and independent migration rule spans. */
export type ParseResult = {
    /** Managed definitions reconstructed from markers. */
    document: HostmanDocument;
    /** Managed group blocks with source spans and effective rules. */
    groups: ParsedGroup[];
    /** Structural and semantic conflicts detected in the current source. */
    conflicts: Conflict[];
    /** Whether document-level conflicts prevent every mutation. */
    documentFatal: boolean;
    /** Outer marker spans when the managed section exists. */
    outer?: {
        /** Start of the opening marker, excluding a leading BOM. */
        start: number;
        /** End of the complete managed section. */
        end: number;
        /** Start of the managed body after the opening line. */
        bodyStart: number;
        /** End of the managed body before the closing line. */
        bodyEnd: number;
    };
    /** Original source lines and byte-preserving character offsets. */
    lines: Line[];
    /** Effective outside rules used for unmanaged collision validation. */
    unmanaged: Rule[];
    /** Effective and single-comment rules outside the managed section, in source order. */
    migrationRules: MigrationRule[];
    /** First detected newline sequence, defaulting to LF. */
    eol: string;
    /** Leading UTF-8 BOM represented in decoded text, when present. */
    bom: string;
    /** Complete original decoded source. */
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
/**
 * Reconstruct managed state while retaining effective and commented outside rules separately.
 * @param text Decoded hosts source.
 * @returns Source spans, domain conflicts and migration input rules.
 */
export function parse(text: string): ParseResult {
    /** Parsed state accumulated without rewriting the source. */
    const result: ParseResult = {
        document: emptyDocument(),
        groups: [],
        conflicts: [],
        documentFatal: false,
        lines: linesOf(text),
        unmanaged: [],
        migrationRules: [],
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
            /** Effective outside rule, independent of the commented migration scan. */
            const rule = ruleOf(line);
            if (rule) {
                result.unmanaged.push(rule);
                result.migrationRules.push({ ...rule, enabled: true });
            } else {
                /** The single leading comment marker, ignoring indentation and a possible BOM. */
                const marker = line.content.match(/^[\s\uFEFF]*#/);
                if (marker) {
                    /** Original marker offset retained when parsing tokens for surgical removal. */
                    const offset = marker[0].length - 1;
                    /** Replacing one marker with whitespace preserves every original token offset. */
                    const commented = ruleOf({
                        ...line,
                        content: line.content.slice(0, offset) + ' ' + line.content.slice(offset + 1)
                    });
                    if (commented) {
                        result.migrationRules.push({ ...commented, line, enabled: false });
                    }
                }
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
/** An IP target either reused from a managed group or proposed for creation. */
export type CandidateTarget = {
    /** Existing or default target name. */
    name: string;
    /** First source spelling of this semantic IP. */
    ip: string;
    /** Whether migration must create a group-owned target. */
    create: boolean;
};
/** A hostname occurrence retained for actionable migration diagnostics. */
export type MigrationSource = {
    /** Normalized hostname belonging to the candidate group. */
    host: string;
    /** Original IP spelling. */
    ip: string;
    /** Whether this occurrence is currently effective. */
    enabled: boolean;
    /** One-based line number in the selected source. */
    line: number;
};
/** The deterministic migration proposal for one group. */
export type Candidate = {
    /** Candidate group name. */
    group: string;
    /** Hostname union in source order. */
    hosts: string[];
    /** Distinct semantic IP targets in source order. */
    targets: CandidateTarget[];
    /** Resulting enabled state, preserving existing groups. */
    enabled: boolean;
    /** Selected target, also retained when the group is disabled. */
    activeTarget: string;
    /** All source occurrences for diagnostics. */
    sources: MigrationSource[];
    /** Explanation when the complete group must be skipped. */
    reason?: string;
};
/**
 * Choose the first available deterministic imported target name.
 * @param used Names already reserved within the group.
 * @returns An unused imported name.
 */
export function importedName(used: Set<string>): string {
    /** Numeric suffix, with the first target retaining the historical name. */
    let index = 1;
    while (used.has(index === 1 ? 'imported' : `imported-${index}`)) {
        index++;
    }
    return index === 1 ? 'imported' : `imported-${index}`;
}
/**
 * Build migration proposals without treating commented rules as effective mappings.
 * @param parsed Current source including managed validation results.
 * @returns Sorted group proposals, including actionable skip reasons.
 */
export function candidates(parsed: ParseResult): Candidate[] {
    /** Source occurrences grouped by the last two hostname labels. */
    const entries = new Map<string, MigrationSource[]>();
    for (const rule of parsed.migrationRules) {
        for (const host of rule.hosts) {
            if (!validHost(host) || ['localhost.localdomain', 'localhost6.localdomain6'].includes(host)
                || host.endsWith('.localhost')) {
                continue;
            }
            /** Group name derived without public suffix inference. */
            const name = host.split('.').slice(-2).join('.');
            /** Occurrences accumulated for this group. */
            const list = entries.get(name) ?? [];
            list.push({ host, ip: rule.ip, enabled: rule.enabled, line: parsed.lines.indexOf(rule.line) + 1 });
            entries.set(name, list);
        }
    }
    return [...entries].map(([name, list]) => {
        /** Existing group whose state and target definitions must be preserved. */
        const group = parsed.document.groups.find(g => g.name === name);
        /** Effective candidate IPs compared semantically. */
        const effective = new Set(list.filter(x => x.enabled).map(x => ipKey(x.ip)));
        /** Conflicts that migration cannot resolve merely by absorbing outside rules. */
        const conflicts = parsed.conflicts.filter(c => c.group === name && c.type !== 'UnmanagedHostnameConflict');
        /** Skip reason before adding source diagnostics. */
        let reason: string | undefined;
        /** Existing active IP, only resolved for otherwise valid groups. */
        let activeIp: string | undefined;
        if (group && !conflicts.length) {
            activeIp = resolveTarget(parsed.document, group);
        }
        if (effective.size > 1) {
            reason = 'Multiple effective candidate IPs.';
        }
        if (group) {
            if (conflicts.length) {
                reason = 'Existing group is conflicted; inspect the managed block and repair if appropriate.';
            } else if (!group.enabled && effective.size) {
                reason = 'Existing group is disabled; resolve outside effective rules or enable the group first.';
            } else if (group.enabled && [...effective].some(ip => ip !== ipKey(activeIp!))) {
                reason = `Candidate IP differs from managed active IP ${activeIp}.`;
            }
        }
        if (list.some(x => parsed.document.groups.some(g => g.name !== name && g.hosts.includes(x.host)))) {
            reason = 'Hostname is already managed by another group.';
        }
        if (parsed.documentFatal) {
            reason = 'Managed document has structural conflicts.';
        }
        /** Existing target names reserved before allocating new names. */
        const used = new Set(group?.targets.map(t => t.name));
        /** Distinct source IPs, retaining their first spelling and order. */
        const ips = new Map(list.map(x => [ipKey(x.ip), x.ip] as const).reverse());
        /** Source-ordered semantic IP keys. */
        const keys = [...new Set(list.map(x => ipKey(x.ip)))];
        /** Reusable targets with the active target taking precedence. */
        const reusable = group && !conflicts.length
            ? [...group.targets].sort((a, b) => Number(b.name === group.activeTarget)
                - Number(a.name === group.activeTarget)) : [];
        /** Proposed targets, including reused definitions. */
        const targets = keys.map(key => {
            /** Existing target resolving to this candidate IP. */
            const existing = reusable.find(t => ipKey(resolveTarget(parsed.document, group!, t.name)) === key);
            /** Name reserved for either a reused target or a new literal target. */
            const targetName = existing?.name ?? importedName(used);
            used.add(targetName);
            return { name: targetName, ip: ips.get(key)!, create: !existing };
        });
        /** New groups select the unique effective IP, otherwise their first imported target. */
        const selected = targets.find(t => effective.has(ipKey(t.ip))) ?? targets[0];
        return {
            group: name,
            hosts: [...new Set(list.map(x => x.host))],
            targets,
            enabled: group?.enabled ?? effective.size === 1,
            activeTarget: group?.activeTarget ?? selected.name,
            sources: list,
            reason: reason ? `${reason} Sources: ${list.map(x =>
                `line ${x.line}: ${x.ip} ${x.host} (${x.enabled ? 'effective' : 'commented'})`).join('; ')}` : undefined
        };
    }).sort((a, b) => a.group.localeCompare(b.group, 'en'));
}
/**
 * Remove selected aliases from effective and commented migration rules.
 * @param parsed Current source and original token spans.
 * @param hosts Hostnames selected for migration.
 * @returns Source with selected aliases removed and other bytes preserved.
 */
export function removeImported(parsed: ParseResult, hosts: Set<string>): string {
    /** Source rewritten from the end so earlier spans remain valid. */
    let output = parsed.text;
    for (const rule of [...parsed.migrationRules].reverse()) {
        /** Original hostname tokens moving into management. */
        const selected = rule.tokens.slice(1).filter(t => hosts.has(normalizeHost(t.value)));
        if (!selected.length) {
            continue;
        }
        /** Unselected aliases retain their original spacing and comment prefix. */
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
