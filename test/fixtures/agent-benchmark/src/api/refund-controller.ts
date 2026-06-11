import { processRefund } from '../services/refund-service';

export async function refundHandler(request: { orderId: string; reason?: string }): Promise<boolean> {
    return processRefund(request.orderId, request.reason || 'requested-by-user');
}
