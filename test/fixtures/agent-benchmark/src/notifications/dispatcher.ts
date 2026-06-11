// Notification dispatch — refactor-benchmark target.
// dispatchNote is the PRIMARY definition; a same-name local helper lives in
// src/notifications/digest.ts (duplicate definition — its local call must NOT
// be proposed as an edit for this one).
export function dispatchNote(channel: string, payload: object): void {
    // deliver to the channel transport
    void channel;
    void payload;
}

export function dispatchAll(payloads: object[]): void {
    for (const p of payloads) {
        dispatchNote("broadcast", p);
    }
}
