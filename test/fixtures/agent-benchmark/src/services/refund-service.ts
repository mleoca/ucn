import { EventBus, publishOrderRefunded } from '../events/bus';
import { refundCard } from '../payments/stripe';
import { OrderRepo } from '../repo/order-repo';

export async function processRefund(orderId: string, reason: string): Promise<boolean> {
    const repo = new OrderRepo();
    const existing = repo.getById(orderId);
    if (!existing) return false;

    repo.markRefunded(orderId);
    await refundCard(orderId, existing.totalCents);

    const bus = new EventBus();
    publishOrderRefunded(bus, orderId, reason);
    return true;
}

export function replayRefund(orderId: string): Promise<boolean> {
    return processRefund(orderId, 'replay');
}
