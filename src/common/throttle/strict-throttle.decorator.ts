export const STRICT_THROTTLE = 'STRICT_THROTTLE';

/**
 * Opt a handler into the `strict` rate-limit throttler.
 *
 * The `strict` throttler is registered globally but skipped by default
 * (`skipIf`). Only handlers bearing this marker are subject to it — stamp it on
 * security-sensitive endpoints (OTP send/verify, password flows, etc.)
 *
 *   @StrictThrottle()
 *   @Post('otp/send')
 *   sendOtp(...) { ... }
 */
export function StrictThrottle(): MethodDecorator {
  return (target: object, _key: string | symbol, descriptor: PropertyDescriptor) => {
    Reflect.defineMetadata(STRICT_THROTTLE, true, descriptor.value);
    return descriptor;
  };
}
