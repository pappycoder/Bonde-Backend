import { pathToFileURL } from 'node:url';

// One supervised worker covers finance, AI recovery, service purchases,
// monitoring, reminders and billing renewals. It holds no provider keys.
export function workerOrigin(value) {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('FINANCE_API_URL must be an HTTPS origin (HTTP is allowed only on loopback)');
  }
  return url.origin;
}

export async function runJobs(base, token, request = fetch) {
  if (!token) throw new Error('FINANCE_JOB_TOKEN is required');
  const origin = workerOrigin(base);
  const results = await Promise.allSettled(
    ['finance', 'shopping'].map(async (job) => {
      const response = await request(`${origin}/api/${job}/jobs`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(300_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error(`${job} job failed with HTTP ${response.status}`);
      return { job, result: await response.json() };
    }),
  );
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length)
    throw new AggregateError(
      failures.map((result) => result.reason),
      'Background jobs failed',
    );
  return results.map((result) => result.value);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const base = workerOrigin(process.env.FINANCE_API_URL);
  const token = process.env.FINANCE_JOB_TOKEN;
  if (!token) throw new Error('FINANCE_JOB_TOKEN is required');
  async function tick() {
    const result = await runJobs(base, token);
    console.log(JSON.stringify({ at: new Date().toISOString(), result }));
  }
  if (process.argv.includes('--once')) await tick();
  else {
    for (;;) {
      try {
        await tick();
      } catch (error) {
        console.error(
          error instanceof AggregateError
            ? error.errors.map((e) => e.message).join('; ')
            : 'Background job failed',
        );
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    }
  }
}
