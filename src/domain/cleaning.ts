import { HostmanError, ipKey, type HostmanDocument, type Target } from '#hostman/domain/model';

/** One semantic IP requiring a destination name to retain or reuse. */
export type CleanChoice = {
    /** First source spelling of the destination IP. */
    ip: string;
    /** Valid destination names in source definition order. */
    names: string[];
    /** Resolved name, absent when a global choice is still required. */
    selected?: string;
};

/** Source-derived choices for cleaning one group's literal targets. */
export type TargetCleanPlan = {
    /** Global destinations replacing matching local definitions. */
    globals: CleanChoice[];
    /** Local duplicate destinations requiring one retained definition. */
    locals: CleanChoice[];
};

/**
 * Group literal definitions by semantic IP while preserving source order.
 * @param targets Current definitions, without caller-supplied IP buckets.
 * @returns One ordered bucket per semantic IP.
 */
export function ipBuckets(targets: Target[]): CleanChoice[] {
    /** Buckets keyed by normalized IP. */
    const buckets = new Map<string, CleanChoice>();
    for (const target of targets) {
        /** Existing bucket or the first definition of this destination. */
        const bucket = buckets.get(ipKey(target.ip)) ?? { ip: target.ip, names: [] };
        bucket.names.push(target.name);
        buckets.set(ipKey(target.ip), bucket);
    }
    return [...buckets.values()];
}

/**
 * Validate explicit choices against freshly reconstructed destination buckets.
 * @param choices Relevant source-derived options.
 * @param payload Untrusted repeated destination names.
 * @returns Choices with explicit selections applied, retaining unresolved ambiguity.
 */
export function selectChoices(choices: CleanChoice[], payload: unknown): CleanChoice[] {
    if (!Array.isArray(payload) || payload.some(value => typeof value !== 'string')) {
        throw new HostmanError('Invalid target choices.');
    }
    /** Clone prevents caller options from altering source-derived proposals. */
    const result = structuredClone(choices);
    /** Buckets already explicitly selected by this payload. */
    const used = new Set<string>();
    for (const name of payload as string[]) {
        /** Only relevant names can participate in this operation. */
        const choice = result.find(bucket => bucket.names.includes(name));
        if (!choice || used.has(ipKey(choice.ip))) {
            throw new HostmanError(`Invalid, unrelated, or conflicting target choice ${name}.`);
        }
        used.add(ipKey(choice.ip));
        choice.selected = name;
    }
    return result;
}

/**
 * Require resolved global choices before any domain mutation or helper write.
 * @param choices Source-derived destination choices.
 */
export function requireChoices(choices: CleanChoice[]): void {
    for (const choice of choices) {
        if (!choice.selected) {
            throw new HostmanError(`Choose a global target for ${choice.ip}: ${choice.names.join(', ')}. `
                + 'Supply --global for migration/target clean or --keep for global clean.');
        }
    }
}

/**
 * Propose deduplication within the global namespace without touching local definitions.
 * @param document Current managed state.
 * @param keep Untrusted global names explicitly retained.
 * @returns Duplicate IP buckets, with unresolved choices left visible for previews.
 */
export function globalCleanPlan(document: HostmanDocument, keep: unknown = []): CleanChoice[] {
    return selectChoices(ipBuckets(document.globals).filter(bucket => bucket.names.length > 1), keep);
}

/**
 * Propose global reuse and local deduplication for exactly one group.
 * @param document Current managed state.
 * @param name Group to clean.
 * @param globals Untrusted global names explicitly selected.
 * @param keep Untrusted group=target names explicitly retained.
 * @returns Source-derived choices with deterministic local defaults.
 */
export function targetCleanPlan(
    document: HostmanDocument, name: string, globals: unknown = [], keep: unknown = []
): TargetCleanPlan {
    /** Scope owner whose current active selection must remain semantically stable. */
    const group = document.groups.find(owner => owner.name === name);
    if (!group) {
        throw new HostmanError(`Unknown group ${name}.`);
    }
    /** Matching globals replacing group definitions. */
    const shared: CleanChoice[] = [];
    /** Duplicate local IPs without a shared destination. */
    const locals: CleanChoice[] = [];
    for (const bucket of ipBuckets(group.targets)) {
        /** Global definitions resolving to this local destination. */
        const matches = document.globals.filter(target => ipKey(target.ip) === ipKey(bucket.ip));
        if (matches.length) {
            /** Preserve a directly selected global rather than choosing another equivalent name. */
            const active = matches.find(target => `@${target.name}` === group.activeTarget);
            /** Only the existing global is eligible when the group already selects it. */
            const names = active ? [active.name] : matches.map(target => target.name);
            shared.push({ ip: bucket.ip, names, selected: names.length === 1 ? names[0] : undefined });
        } else if (bucket.names.length > 1) {
            locals.push({ ...bucket, selected: bucket.names.includes(group.activeTarget)
                ? group.activeTarget : bucket.names[0] });
        }
    }
    if (!Array.isArray(keep) || keep.some(value => typeof value !== 'string'
        || !value.startsWith(`${name}=`))) {
        throw new HostmanError('Invalid group=target retention choices.');
    }
    return {
        globals: selectChoices(shared, globals),
        locals: selectChoices(locals, (keep as string[]).map(value => value.slice(name.length + 1)))
    };
}
