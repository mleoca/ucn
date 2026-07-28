import { processRefund } from '../services/refund-service';

export function listOrders(_request: unknown, response: { json(value: unknown): void }): void {
    response.json([]);
}

export async function refundEndpoint(
    request: { body: { orderId: string; reason: string } },
    response: { json(value: unknown): void },
): Promise<void> {
    // Intentional missing await for the public audit-async benchmark.
    processRefund(request.body.orderId, request.body.reason);
    response.json({ accepted: true });
}

app.get('/orders', listOrders);
app.post('/refunds', refundEndpoint);

export async function requestOrders(): Promise<unknown> {
    return fetch('/orders');
}
