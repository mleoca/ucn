export function cents(value: number): number {
    return Math.round(value * 100);
}

export function calculateTax(subtotalCents: number): number {
    return Math.round(subtotalCents * 0.2);
}

export function applyDiscount(subtotalCents: number, discountPct: number): number {
    if (discountPct <= 0) return subtotalCents;
    return subtotalCents - Math.round(subtotalCents * discountPct);
}
