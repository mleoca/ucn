// Calls the primary dispatchNote directly (import binding → confirmed tier).
// Also mentions dispatchNote in a comment and a string — those lines are
// non-call occurrences and must NOT be proposed as edits.
import { dispatchNote } from "./dispatcher";

export function relayUrgent(payload: object): void {
    dispatchNote("urgent", payload);
}

// helper docs: dispatchNote takes a channel and a payload
export const RELAY_HELP = "use dispatchNote(channel, payload) to send directly";
