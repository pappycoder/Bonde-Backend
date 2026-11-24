import { describe, expect, it, vi } from 'vitest';
import { ShoppingJobsController } from './shopping-jobs.controller.js';

function fixture() {
  const run = vi.fn(async () => undefined),
    reap = vi.fn(async () => undefined);
  const services = vi.fn(async () => undefined),
    renew = vi.fn(async () => undefined);
  const monitoring = vi.fn(async () => undefined),
    reminders = vi.fn(async () => undefined);
  const controller = new ShoppingJobsController(
    { get: () => ({ jobToken: 'secret' }) } as never,
    { run } as never,
    { reap } as never,
    { run: services } as never,
    {} as never,
    { run: monitoring } as never,
    { run: reminders } as never,
    { renewDue: renew } as never,
  );
  return { controller, run, reap, services, renew, monitoring, reminders };
}
describe('scheduled shopping jobs', () => {
  it('requires the job bearer token before any work', async () => {
    const f = fixture();
    await expect(f.controller.run('Bearer wrong')).rejects.toThrow();
    expect(f.renew).not.toHaveBeenCalled();
    expect(f.reap).not.toHaveBeenCalled();
  });
  it('runs renewals and reminders even if service reconciliation fails', async () => {
    const f = fixture();
    f.services.mockRejectedValue(new Error('supplier unavailable'));
    await expect(f.controller.run('Bearer secret')).rejects.toThrow('services');
    expect(f.renew).toHaveBeenCalledOnce();
    expect(f.reminders).toHaveBeenCalledOnce();
    expect(f.run).toHaveBeenCalledOnce();
  });
});
