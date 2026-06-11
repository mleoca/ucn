import type { Order } from './domain/order';
import { checkoutHandler } from './api/checkout-controller';
import { refundHandler } from './api/refund-controller';

export async function runDemo(order: Order): Promise<void> {
    await checkoutHandler({ order, usePaypal: false });
    await refundHandler({ orderId: order.id, reason: 'demo-refund' });
}
