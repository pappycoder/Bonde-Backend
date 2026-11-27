/** Vercel functions are short lived; process timers are not reliable workers. */
export function shouldRunBackgroundJobs(): boolean {
  return process.env.VERCEL !== '1' || process.env.BONDE_ENABLE_BACKGROUND_JOBS === 'true';
}
