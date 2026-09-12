// Host implementations (including the CLI) use this code when no human can
// answer. It must not be treated as a retryable provider failure or approval.
export function isInteractionRequired(error: unknown): boolean {
    return !!error && typeof error === 'object'
        && (error as { code?: unknown }).code === 'INTERACTION_REQUIRED';
}
