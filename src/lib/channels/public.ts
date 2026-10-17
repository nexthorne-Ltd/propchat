/**
 * Public versus private on a channel.
 *
 * X, LinkedIn, TikTok and Threads mix two kinds of conversation: direct
 * messages (private, where the platform offers them) and public items (a post
 * that mentions the business, a reply to its post, a comment on its video).
 * The answer to a public item is public: everyone can read it.
 *
 * The two are kept apart by the sender id stored on the conversation. A public
 * item's sender is "pub:<author>", a direct message's is the bare id, so a
 * person's DMs and their public posts become separate tickets and no reply can
 * cross from one to the other. The prefix is the single source of truth: the
 * outbound worker, the ticket screen and the tests all read it from here.
 */

export const PUBLIC_PREFIX = 'pub:';

export type Audience = 'public' | 'private';

export function publicSender(authorId: string): string {
  return `${PUBLIC_PREFIX}${authorId}`;
}

export function isPublicSender(senderId: string | null | undefined): boolean {
  return Boolean(senderId && senderId.startsWith(PUBLIC_PREFIX));
}

/** The platform's own id for the author, with the audience marker removed. */
export function authorOf(senderId: string): string {
  return isPublicSender(senderId) ? senderId.slice(PUBLIC_PREFIX.length) : senderId;
}

export function audienceOf(senderId: string | null | undefined): Audience {
  return isPublicSender(senderId) ? 'public' : 'private';
}

/** Cuts text to a platform's limit without splitting a character, ending in an ellipsis. */
export function clip(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join('')}…`;
}

export function charCount(text: string): number {
  return Array.from(text).length;
}
