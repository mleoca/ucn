import type { Product } from '../catalog/catalog';

export interface InventoryItem {
    sku: string;
    available: number;
    reserved: number;
    reorderPoint: number;
}

export interface Reservation {
    sku: string;
    quantity: number;
    orderId: string;
}

export function availableToPromise(item: InventoryItem): number {
    return Math.max(0, item.available - item.reserved);
}

export function canReserve(
    item: InventoryItem,
    quantity: number,
): boolean {
    return quantity > 0 && availableToPromise(item) >= quantity;
}

export function reserveInventory(
    item: InventoryItem,
    reservation: Reservation,
): InventoryItem {
    if (item.sku !== reservation.sku) {
        throw new Error('Reservation SKU does not match inventory item');
    }
    if (!canReserve(item, reservation.quantity)) {
        throw new Error(`Insufficient inventory for ${item.sku}`);
    }
    return {
        ...item,
        reserved: item.reserved + reservation.quantity,
    };
}

export function releaseInventory(
    item: InventoryItem,
    quantity: number,
): InventoryItem {
    if (quantity < 0 || quantity > item.reserved) {
        throw new Error('Invalid release quantity');
    }
    return {
        ...item,
        reserved: item.reserved - quantity,
    };
}

export function commitInventory(
    item: InventoryItem,
    quantity: number,
): InventoryItem {
    if (quantity < 0 ||
        quantity > item.reserved ||
        quantity > item.available) {
        throw new Error('Invalid commit quantity');
    }
    return {
        ...item,
        available: item.available - quantity,
        reserved: item.reserved - quantity,
    };
}

export function needsReorder(item: InventoryItem): boolean {
    return availableToPromise(item) <= item.reorderPoint;
}

export function inventoryForProducts(
    products: Product[],
    items: InventoryItem[],
): Array<{ product: Product; inventory?: InventoryItem }> {
    const bySku = new Map(items.map(item => [item.sku, item]));
    return products.map(product => ({
        product,
        inventory: bySku.get(product.sku),
    }));
}

export function inventoryShortages(
    items: InventoryItem[],
): InventoryItem[] {
    return items
        .filter(needsReorder)
        .sort((left, right) =>
            availableToPromise(left) - availableToPromise(right));
}
