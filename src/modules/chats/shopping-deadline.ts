import { GatewayTimeoutException } from '@nestjs/common';
/** Also bounds adapters that fail to cooperate with cancellation. */
export function shoppingDeadline<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(new GatewayTimeoutException('The assistant timed out. No AI credit was charged.'));
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    work.then(
      (value) => {
        signal.removeEventListener('abort', abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', abort);
        reject(error);
      },
    );
  });
}
