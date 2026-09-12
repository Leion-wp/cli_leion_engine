import * as readline from 'readline/promises';

export class InteractionRequiredError extends Error {
    readonly code = 'INTERACTION_REQUIRED';

    constructor(prompt: string) {
        super(`INTERACTION_REQUIRED: ${prompt}. An interactive terminal is required; no default or approval was selected.`);
        this.name = 'InteractionRequiredError';
    }
}

function requireInteractiveTerminal(prompt: string): void {
    if (!process.stdin.isTTY) {
        throw new InteractionRequiredError(prompt);
    }
}

export async function askInput(prompt: string, defaultValue?: string): Promise<string | undefined> {
    requireInteractiveTerminal(prompt);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        const suffix = defaultValue !== undefined ? ` [default: ${defaultValue}]` : '';
        const answer = await rl.question(`${prompt}${suffix}: `);
        const trimmed = String(answer || '').trim();
        if (!trimmed && defaultValue !== undefined) {
            return defaultValue;
        }
        return trimmed || undefined;
    } finally {
        rl.close();
    }
}

export async function askChoice(title: string, options: string[], defaultIndex = 0): Promise<string | undefined> {
    if (!options.length) {
        return undefined;
    }
    requireInteractiveTerminal(title);
    console.log(title);
    options.forEach((entry, index) => {
        console.log(`  ${index + 1}. ${entry}`);
    });
    const selected = await askInput('Select option number', String(defaultIndex + 1));
    const parsed = Number(selected || defaultIndex + 1);
    if (!Number.isFinite(parsed) || parsed < 1 || parsed > options.length) {
        return options[defaultIndex];
    }
    return options[Math.floor(parsed) - 1];
}
