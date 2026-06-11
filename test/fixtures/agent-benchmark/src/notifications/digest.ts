// Contains a DUPLICATE local definition of dispatchNote (different symbol,
// same name). Its local call binds here — an edit proposal pointing at this
// file's call would be a false positive for the primary's refactor.
function dispatchNote(summary: string): void {
    void summary;
}

export function sendDigest(entries: string[]): void {
    dispatchNote(entries.join(", "));
}
