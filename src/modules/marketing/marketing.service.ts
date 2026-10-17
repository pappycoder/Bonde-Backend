import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditLogService } from '../audit/audit-log.service.js';
import { MAIL_SENDER, type MailSender } from '../../common/mail/mail.types.js';
import { contactMessageEmail } from '../../common/mail/templates/contact-message.js';
import { waitlistConfirmationEmail } from '../../common/mail/templates/waitlist-confirmation.js';
import { waitlistSignupEmail } from '../../common/mail/templates/waitlist-signup.js';
import type { AppConfig } from '../../config/configuration.js';
import type { CreateContactMessageDto, JoinWaitlistDto } from './marketing.dto.js';

export interface WaitlistJoinResult {
  status: 'joined';
  email: string;
  /** True when the address was already on the list (idempotent repeat). */
  alreadyJoined: boolean;
}

export interface ContactMessageResult {
  status: 'received';
  id: string;
}

/**
 * Public-marketing write surface for the Bonde website: the pre-launch waitlist
 * and the contact form. Both persist synchronously and then notify the Bonde
 * inbox on a best-effort basis — the row is the source of truth, so a mail
 * outage never fails a visitor's submission.
 */
@Injectable()
export class MarketingService {
  private readonly logger = new Logger('MarketingService');

  constructor(
    private readonly prisma: PrismaService,
    @Inject(MAIL_SENDER) private readonly mail: MailSender,
    private readonly audit: AuditLogService,
    private readonly config: ConfigService<AppConfig, true>,
  ) {}

  async joinWaitlist(dto: JoinWaitlistDto): Promise<WaitlistJoinResult> {
    const existing = await this.prisma.waitlistSignup.findUnique({
      where: { email: dto.email },
      select: { id: true, name: true },
    });
    if (existing) {
      await this.confirmWaitlist(existing.id, dto.email, existing.name, true);
      return { status: 'joined', email: dto.email, alreadyJoined: true };
    }

    const id = randomUUID();
    await this.prisma.waitlistSignup.create({
      data: {
        id,
        email: dto.email,
        name: dto.name || null,
        source: dto.source || null,
      },
    });

    await this.audit.record({
      action: 'marketing.waitlist.join',
      entityType: 'waitlist_signup',
      entityId: id,
      metadata: { email: dto.email, source: dto.source ?? null },
    });

    await this.confirmWaitlist(id, dto.email, dto.name || null, false);

    const mail = waitlistSignupEmail({
      email: dto.email,
      name: dto.name || null,
      source: dto.source || null,
    });
    await this.notifyInbox('mail.waitlist', id, dto.email, mail.subject, mail.html);

    return { status: 'joined', email: dto.email, alreadyJoined: false };
  }

  async createContactMessage(dto: CreateContactMessageDto): Promise<ContactMessageResult> {
    const id = randomUUID();
    await this.prisma.contactMessage.create({
      data: {
        id,
        name: dto.name,
        email: dto.email,
        subject: dto.subject || null,
        message: dto.message,
      },
    });

    await this.audit.record({
      action: 'marketing.contact.create',
      entityType: 'contact_message',
      entityId: id,
      metadata: { email: dto.email, subject: dto.subject ?? null },
    });

    const mail = contactMessageEmail({
      name: dto.name,
      email: dto.email,
      subject: dto.subject || null,
      message: dto.message,
    });
    await this.notifyInbox('mail.contact', id, dto.email, mail.subject, mail.html);

    return { status: 'received', id };
  }

  /** Confirmation failures never discard a saved place; resubmitting retries delivery. */
  private async confirmWaitlist(
    id: string,
    email: string,
    name: string | null,
    alreadyJoined: boolean,
  ): Promise<void> {
    const message = waitlistConfirmationEmail({ email, name, alreadyJoined });
    let sent = false;
    try {
      await this.mail.send({ to: email, ...message });
      sent = true;
    } catch (error) {
      this.logger.warn(
        `Waitlist confirmation failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    await this.audit
      .record({
        action: 'mail.waitlist_confirmation',
        entityType: 'mail',
        entityId: id,
        metadata: { to: email, sent, alreadyJoined },
      })
      .catch(() => undefined);
  }

  /**
   * Best-effort notification to the Bonde inbox. Never throws: a failed send is
   * logged and audited, but the already-persisted submission still succeeds.
   */
  private async notifyInbox(
    auditAction: string,
    entityId: string,
    fromEmail: string,
    subject: string,
    html: string,
  ): Promise<void> {
    const to = this.config.get('contactInboxEmail', { infer: true });
    try {
      await this.mail.send({ to, subject, html });
      await this.audit
        .record({
          action: auditAction,
          entityType: 'mail',
          entityId,
          metadata: { to, from: fromEmail },
        })
        .catch(() => undefined);
    } catch (error) {
      this.logger.warn(
        `Inbox notification failed (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
}
