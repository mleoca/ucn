// Forwards through an unknown-receiver transport — deliberately NO import of
// the dispatcher here, so the method call has no binding/receiver evidence
// and must surface in the UNVERIFIED tier (never silently hidden).
export function forwardVia(transport: any, payload: object): void {
    transport.dispatchNote("forward", payload);
}
