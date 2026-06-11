export async function chargePaypal(orderId: string, totalCents: number): Promise<{ ok: boolean; id: string }> {
    return {
        ok: totalCents > 0,
        id: `paypal-${orderId}`
    };
}
