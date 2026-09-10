import { Global, Module } from '@nestjs/common';
import { MailService } from './mail.service.js';
import { MAIL_SENDER } from './mail.types.js';

/**
 * Global transactional-email module. Exposes the `MAIL_SENDER` token so any
 * feature can send (`send({ to, subject, html })`); tests override the token
 * with a capture stub. Production delivery is `MailService` → Resend.
 */
@Global()
@Module({
  providers: [MailService, { provide: MAIL_SENDER, useExisting: MailService }],
  exports: [MAIL_SENDER, MailService],
})
export class MailModule {}
