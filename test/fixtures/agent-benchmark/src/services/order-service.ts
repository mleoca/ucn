import type { Order } from '../domain/order';
import { EventBus, publishOrderCreated } from '../events/bus';
import { chargeCard } from '../payments/stripe';
import { chargePaypal } from '../payments/paypal';
import { OrderRepo } from '../repo/order-repo';
import { calculateTax, applyDiscount } from '../utils/pricing';
import { withRetry } from '../utils/retry';

export function validateOrder(order: Order): void {
    if (!order.id || order.items.length === 0) {
        throw new Error('Invalid order payload');
    }
}

export function calculateTotal(order: Order): number {
    const subtotal = order.items.reduce((acc, item) => acc + item.unitPriceCents * item.quantity, 0);
    const discounted = applyDiscount(subtotal, 0.05);
    return discounted + calculateTax(discounted);
}

export async function processCheckout(order: Order, options: { usePaypal?: boolean } = {}): Promise<Order | null> {
    validateOrder(order);

    const repo = new OrderRepo();
    const bus = new EventBus();

    const runCardCharge = chargeCard;

    const totalCents = calculateTotal(order);
    await withRetry(() => runCardCharge(order.id, totalCents, order.currency), 'charge-order');
    if (options.usePaypal) {
        await withRetry(() => chargePaypal(order.id, totalCents), 'charge-paypal');
    }

    const paidOrder = { ...order, status: 'paid' as const, totalCents };
    repo.save(paidOrder);
    publishOrderCreated(bus, paidOrder, 'checkout-service');

    return repo.getById(order.id);
}

export async function processBulk(orders: Order[]): Promise<number> {
    let okCount = 0;
    for (const order of orders) {
        const saved = await processCheckout(order);
        if (saved) okCount += 1;
    }
    return okCount;
}

function experimentalFraudCheck(order: Order): boolean {
    return order.items.some(item => item.quantity > 500);
}
