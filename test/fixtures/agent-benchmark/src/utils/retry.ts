export async function withRetry(task: () => Promise<unknown> | unknown, label: string, maxAttempts = 2): Promise<unknown> {
    let attempts = 0;
    let lastError: unknown = null;

    while (attempts < maxAttempts) {
        attempts += 1;
        try {
            return await task();
        } catch (error) {
            lastError = error;
        }
    }

    throw new Error(`Retry exhausted for ${label}: ${String(lastError)}`);
}
