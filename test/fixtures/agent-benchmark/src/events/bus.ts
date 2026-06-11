import type { Order } from '../domain/order';

type EventHandler = (payload: unknown) => void;

export class EventBus {
    private handlers: Map<string, EventHandler[]>;

    constructor() {
        this.handlers = new Map();
    }

    subscribe(topic: string, handler: EventHandler): void {
        const existing = this.handlers.get(topic) || [];
        existing.push(handler);
        this.handlers.set(topic, existing);
    }

    publish(topic: string, payload: unknown): void {
        const handlers = this.handlers.get(topic) || [];
        for (const handler of handlers) {
            handler(payload);
        }
    }
}

export function publishOrderCreated(bus: EventBus, order: Order, source: string, metadata: Record<string, unknown> = {}): void {
    bus.publish('order.created', {
        id: order.id,
        totalCents: order.totalCents,
        source,
        metadata
    });
}

export function publishOrderRefunded(bus: EventBus, orderId: string, reason: string): void {
    bus.publish('order.refunded', {
        orderId,
        reason
    });
}

function formatInternalSnapshot(payload: unknown): string {
    return JSON.stringify(payload);
}
