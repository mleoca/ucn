export type LineItem = {
    sku: string;
    quantity: number;
    unitPriceCents: number;
};

export type Order = {
    id: string;
    currency: string;
    items: LineItem[];
    status: 'new' | 'paid' | 'refunded';
    totalCents: number;
};

export function cloneOrder(order: Order): Order {
    return {
        ...order,
        items: order.items.map(item => ({ ...item }))
    };
}
