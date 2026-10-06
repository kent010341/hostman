import { select } from '@inquirer/prompts';
import { requireChoices, type CleanChoice } from '#hostman/domain/cleaning';

/**
 * Finish source-derived choices before a transaction, keeping scripts non-interactive.
 * @param choices Validated choices with defaults or unresolved global ambiguity.
 * @param interactive Whether both terminal streams permit prompting.
 * @param explicit Names supplied by flags, which must skip prompting.
 * @param local Whether duplicate locals should prompt even when a deterministic default exists.
 * @returns Fully resolved names for replay, without filesystem writes.
 */
export async function finishChoices(
    choices: CleanChoice[], interactive: boolean, explicit: string[], local = false
): Promise<string[]> {
    /** Resolved copies retain caller proposals for dry-run display. */
    const resolved = structuredClone(choices);
    for (const choice of resolved) {
        if (interactive && choice.names.length > 1 && !choice.names.some(name => explicit.includes(name))
            && (local || !choice.selected)) {
            choice.selected = await select({
                message: `${local ? 'Target to keep' : 'Global target for'} ${choice.ip}`,
                default: choice.selected,
                choices: choice.names.map(name => ({ name, value: name }))
            });
        }
    }
    requireChoices(resolved);
    return resolved.map(choice => choice.selected!);
}

/**
 * Render destination choices without inventing a resolution for ambiguous globals.
 * @param choices Current cleanup or migration proposal.
 * @param label Namespace or action heading.
 * @returns Display lines with every candidate and the retained destination, if known.
 */
export function choicePreview(choices: CleanChoice[], label: string): string[] {
    return choices.map(choice => `  ${label} ${choice.ip}: ${choice.names.join(', ')} -> `
        + (choice.selected ?? 'pending selection'));
}
