import type { Order } from '../domain/order';
import { cloneOrder } from '../domain/order';

export class OrderRepo {
    private storage: Map<string, Order>;
    private auditTrail: string[];

    constructor() {
        this.storage = new Map();
        this.auditTrail = [];
    }

    save(order: Order): void {
        const cloned = cloneOrder(order);
        this.storage.set(order.id, cloned);
        this.appendAudit(`saved:${order.id}`);
    }

    getById(id: string): Order | null {
        const normalized = normalizeId(id);
        return this.storage.get(normalized) || null;
    }

    markRefunded(id: string): void {
        const existing = this.getById(id);
        if (!existing) return;
        existing.status = 'refunded';
        this.storage.set(existing.id, existing);
        this.appendAudit(`refunded:${existing.id}`);
    }

    appendAudit(message: string): void {
        this.auditTrail.push(message);
    }
}

function normalizeId(id: string): string {
    return id.trim().toLowerCase();
}
