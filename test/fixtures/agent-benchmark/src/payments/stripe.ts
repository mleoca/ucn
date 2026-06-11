export async function chargeCard(orderId: string, totalCents: number, currency = 'USD'): Promise<{ ok: boolean; id: string }> {
    const nonce = createNonce(orderId);
    return {
        ok: totalCents > 0,
        id: `${currency}-${nonce}`
    };
}

export async function refundCard(orderId: string, totalCents: number): Promise<boolean> {
    return orderId.length > 0 && totalCents > 0;
}

export function buildChargeDescription(orderId: string): string {
    return `charge:${orderId}`;
}

function createNonce(orderId: string): string {
    return `${orderId}-${Date.now()}`;
}
