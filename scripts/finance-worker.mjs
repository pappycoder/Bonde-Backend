// Run as a supervised worker, or invoke once per minute from your scheduler.
// The API owns durable claims and reconciliation. This process holds no provider keys.
const base = process.env.FINANCE_API_URL;
const token = process.env.FINANCE_JOB_TOKEN;
if (!base || !token || !base.startsWith('https://')) {
  throw new Error('FINANCE_API_URL (HTTPS) and FINANCE_JOB_TOKEN are required');
}
async function tick() {
  const result = await fetch(`${base.replace(/\/$/, '')}/api/finance/jobs`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(300_000), redirect: 'error',
  });
  if (!result.ok) throw new Error(`Finance job failed with HTTP ${result.status}`);
  console.log(JSON.stringify({ at: new Date().toISOString(), result: await result.json() }));
}
if (process.argv.includes('--once')) await tick();
else {
  for (;;) {
    try { await tick(); } catch (error) { console.error(error instanceof Error ? error.message : 'Finance job failed'); }
    await new Promise(resolve => setTimeout(resolve, 60_000));
  }
}
