import { checkoutHandler } from '../src/api/checkout-controller';
import { processCheckout } from '../src/services/order-service';

test('checkoutHandler returns 201 when save succeeds', async () => {
    const order = {
        id: 'order-1',
        currency: 'USD',
        status: 'new',
        totalCents: 0,
        items: [{ sku: 'A', quantity: 1, unitPriceCents: 1000 }]
    };

    await processCheckout(order);
    const result = await checkoutHandler({ order });
    expect(result.status).toBe(201);
});
