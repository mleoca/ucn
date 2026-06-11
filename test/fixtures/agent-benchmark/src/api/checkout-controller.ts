import type { Order } from '../domain/order';
import { EventBus, publishOrderCreated } from '../events/bus';
import { processCheckout } from '../services/order-service';

export async function checkoutHandler(request: { order: Order; usePaypal?: boolean }): Promise<{ status: number; body: Order | null }> {
    const saved = await processCheckout(request.order, { usePaypal: request.usePaypal });
    return { status: saved ? 201 : 400, body: saved };
}

export function replayCreated(order: Order): void {
    const bus = new EventBus();
    // Intentional mismatch for verify benchmark: source param missing
    publishOrderCreated(bus, order);
}
