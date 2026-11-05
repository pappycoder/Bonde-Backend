import { describe, expect, it, vi } from 'vitest';
import { ServiceWebhooksController } from './service-purchases.controller.js';
describe('service provider callbacks', () => {
  it('requires the callback token and only triggers a provider requery, never trusts callback status', () => {
    const service = { requeryReference: vi.fn(async () => undefined) };
    const controller = new ServiceWebhooksController(
      service as never,
      { get: () => ({ vtpassWebhookToken: 'test-webhook-token' }) } as never,
    );
    expect(() =>
      controller.receive('wrong', { data: { requestId: 'ref', status: 'delivered' } }),
    ).toThrow();
    expect(service.requeryReference).not.toHaveBeenCalled();
    expect(
      controller.receive('test-webhook-token', {
        data: { requestId: 'reference', status: 'delivered' },
      }),
    ).toEqual({ response: 'success' });
    expect(service.requeryReference).toHaveBeenCalledWith('reference');
  });
});
