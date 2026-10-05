import type { Group } from '#hostman/domain/model';
import type { Candidate, MigrationSource } from '#hostman/hosts/document';

/**
 * Render a migration group's targets, hostnames and proposed effective state on separate lines.
 * @param name Group name.
 * @param targets Display-ready target definitions.
 * @param hosts Hostname union.
 * @param enabled Whether the resulting group contributes effective mappings.
 * @param activeTarget Stored active selection, including the selection used by a later enable.
 * @returns A readable group block without terminal control sequences.
 */
function groupBlock(
    name: string,
    targets: string[],
    hosts: string[],
    enabled: boolean,
    activeTarget: string
): string {
    return [
        name,
        '  Targets:',
        ...targets.map(target => `    ${target}`),
        '  Hosts:',
        ...hosts.map(host => `    ${host}`),
        `  Active: ${enabled ? `${activeTarget} (enabled)` : 'none (disabled)'}`,
        ...enabled ? [] : [`  Enable selects: ${activeTarget}`]
    ].join('\n');
}

/**
 * Format a source-derived proposal, putting skip reasons before source diagnostics.
 * @param candidate Current migration proposal, including structured original source occurrences.
 * @returns A READY block or SKIP block with one diagnostic entry per source line.
 */
export function formatMigrationCandidate(candidate: Candidate): string {
    if (!candidate.reason) {
        return groupBlock(`${candidate.group} — READY`, candidate.targets.map(t => `${t.name}=${t.ip}`),
            candidate.hosts, candidate.enabled, candidate.activeTarget);
    }
    /** Occurrences grouped by original line, preserving every relevant alias without repeated entries. */
    const sources = new Map<number, MigrationSource[]>();
    for (const source of candidate.sources) {
        /** Aliases occurring together on this original source line. */
        const aliases = sources.get(source.line) ?? [];
        aliases.push(source);
        sources.set(source.line, aliases);
    }
    return [
        `${candidate.group} — SKIP`,
        `  Reason: ${candidate.reason}`,
        '',
        '  Source rules:',
        ...[...sources].sort(([a], [b]) => a - b).map(([line, aliases]) => {
            /** IP and effective state shared by every occurrence from this source line. */
            const source = aliases[0];
            /** Hostname union avoids repeating duplicate tokens from the same rule. */
            const hosts = [...new Set(aliases.map(alias => alias.host))];
            return `    Line ${line}  ${source.ip}  ${hosts.join(', ')}  `
                + `[${source.enabled ? 'effective' : 'commented'}]`;
        }),
        '',
        candidate.reason === 'Multiple effective candidate IPs.'
            ? '  Action: Keep one effective IP; comment out or correct the other rules.'
            : '  Action: Resolve the reason above, then run migrate --dry-run again.'
    ].join('\n');
}

/**
 * Render the validated final migration state after accepting target names.
 * @param group Resulting managed group, preserving literal targets and its active selection.
 * @returns A final summary block using accepted names and the resulting enabled state.
 */
export function formatMigrationGroup(group: Group): string {
    return groupBlock(group.name, group.targets.map(t =>
        `${t.name}=${t.ip}`),
    group.hosts, group.enabled, group.activeTarget);
}
