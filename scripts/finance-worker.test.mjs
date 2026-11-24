import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runJobs, workerOrigin } from './finance-worker.mjs';

test('rejects credentials, remote HTTP and paths before sending the job token', () => {
  for (const origin of [
    'http://api.example.com',
    'https://user:pass@example.com',
    'https://example.com/api',
    'https://example.com?token=x',
  ]) {
    assert.throws(() => workerOrigin(origin));
  }
  assert.equal(workerOrigin('http://127.0.0.1:3001'), 'http://127.0.0.1:3001');
});
test('runs shopping even when finance fails and surfaces the failure', async () => {
  const calls = [];
  await assert.rejects(
    runJobs('https://example.com', 'test-token', async (url, options) => {
      calls.push(url);
      assert.equal(options.headers.Authorization, 'Bearer test-token');
      assert.equal(options.redirect, 'error');
      return {
        ok: !url.includes('/finance/'),
        status: 503,
        json: async () => ({ processed: true }),
      };
    }),
    AggregateError,
  );
  assert.deepEqual(calls.sort(), [
    'https://example.com/api/finance/jobs',
    'https://example.com/api/shopping/jobs',
  ]);
});
