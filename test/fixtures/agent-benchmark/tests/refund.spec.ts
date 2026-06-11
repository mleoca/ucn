import { processRefund } from '../src/services/refund-service';

describe('refund service', () => {
    it('returns false when order cannot be found', async () => {
        const ok = await processRefund('missing', 'missing-order');
        expect(ok).toBe(false);
    });
});
