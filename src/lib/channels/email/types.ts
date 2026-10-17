/**
 * What the email channel passes around, independent of any email provider.
 * Providers (providers/*.ts) translate their own webhook and API formats to
 * and from these shapes, so swapping provider means writing one file.
 */

export interface EmailAddress {
  email: string;
  name?: string;
}

export interface EmailAttachment {
  filename: string;
  contentType: string;
  size: number;
  content: Buffer;
  /** The Content-ID an HTML body refers to as `cid:...`, without angle brackets. */
  contentId?: string;
  /** Shown inside the message (a pasted image or logo) rather than attached as a file. */
  inline: boolean;
}

/** One received email, normalised. Message ids carry no angle brackets and are lowercase. */
export interface ParsedEmail {
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  from: EmailAddress | null;
  to: EmailAddress[];
  cc: EmailAddress[];
  /** Addresses the provider says the mail was delivered to (the envelope), lowercase. */
  envelopeTo: string[];
  /** The part after "+" in the address it was delivered to, when the provider reports it. */
  mailboxHash?: string;
  subject: string;
  text: string;
  html: string | null;
  date: Date;
  /** Header names lowercased; repeated headers joined with a newline. */
  headers: Record<string, string>;
  attachments: EmailAttachment[];
}

export interface OutboundEmail {
  from: EmailAddress;
  to: EmailAddress[];
  cc?: EmailAddress[];
  replyTo?: string;
  subject: string;
  text: string;
  html: string;
  /** Message-ID is passed here too; a provider that cannot honour it says so in its result. */
  headers: Record<string, string>;
  attachments?: { filename: string; contentType: string; content: Buffer }[];
}

export type EmailSendResult =
  | { ok: true; providerId?: string }
  | {
      ok: false;
      error: string;
      /** Worth trying again later (rate limit, provider outage, network). */
      retryable: boolean;
      /** The address can never receive mail (unknown, blocked): suppress it. */
      recipientRejected?: boolean;
      /** The sender side is broken (bad token, unverified domain): an admin must act. */
      needsAttention?: boolean;
    };

export interface DnsRecord {
  type: 'TXT' | 'CNAME' | 'MX';
  host: string;
  value: string;
  /** What the record is for, in words an admin understands. */
  purpose: string;
  verified: boolean;
}

export interface SenderDomainStatus {
  domain: string;
  /** Mail can be sent From this domain (every record verified). */
  verified: boolean;
  records: DnsRecord[];
  /** The provider's id for the domain, kept to re-check it later. */
  providerRef: string;
}

export interface EmailProvider {
  id: string;
  /** Sending needs credentials; the channel page explains what is missing when this is false. */
  isConfigured(): boolean;
  send(email: OutboundEmail): Promise<EmailSendResult>;
  /** True when a webhook request really comes from the provider. */
  verifyInbound(headers: Headers): boolean;
  /** Turns the provider's webhook body into emails. Throws on a body that is not an email. */
  parseInbound(rawBody: string): Promise<ParsedEmail>;
  /** Optional: authenticate a customer's own sending domain. */
  createSenderDomain?(domain: string): Promise<SenderDomainStatus>;
  checkSenderDomain?(providerRef: string, domain: string): Promise<SenderDomainStatus>;
}

/** Everything the adapter needs to compose one reply to a ticket thread. */
export interface EmailSendContext {
  /** The stored message being sent, so the provider's own id can be recorded on it. */
  messageRowId?: string;
  ticketNumber: number;
  ticketSubject: string;
  agentName?: string;
  /** Message-ID of the customer's latest email, for In-Reply-To. */
  inReplyTo?: string;
  /** Message-IDs already in the thread, oldest first. */
  references?: string[];
  cc?: string[];
}
