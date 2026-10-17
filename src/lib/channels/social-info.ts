/**
 * What each social channel can and cannot do, what it costs or needs, and how
 * to get it, written for the integrations page and mirrored in
 * docs/CHANNELS.md. Kept as data (no React, no secrets) so the page, the
 * server action that checks what is configured, and the tests share it.
 *
 * Facts come from each platform's official developer documentation; the
 * "checked" date says when that was last done. Platforms change pricing and
 * access rules often, so every entry names where the rule is published.
 */

export type SocialChannelId = 'x' | 'threads' | 'linkedin' | 'tiktok';

export type Support = 'yes' | 'no' | 'limited';

export interface CapabilityRow {
  label: string;
  support: Support;
  note?: string;
}

export interface SocialChannelInfo {
  id: SocialChannelId;
  /** One honest line for the card. */
  summary: string;
  capabilities: CapabilityRow[];
  /** What it costs or needs, in plain words. */
  requirements: string[];
  /**
   * self_serve: connect once the platform app is set up on the server.
   * paid: the same, but the platform charges for API use.
   * approval: the platform must approve your app first; nothing works before.
   */
  access: 'self_serve' | 'paid' | 'approval';
  /** Environment variables the server needs before anyone can connect. */
  env: string[];
  /** Set to "true" once the platform has approved the app (for access === 'approval'). */
  approvalFlag?: string;
  /** Steps to get approved or set up, in order. */
  steps: string[];
  /** How connecting works for the admin. */
  connect: 'oauth' | 'oauth_page' | 'token';
  /** Where the platform publishes the rules behind this entry. */
  docs: { label: string; url: string }[];
}

export const SOCIAL_CHECKED = '2026-10';

export const SOCIAL_CHANNELS: Record<SocialChannelId, SocialChannelInfo> = {
  x: {
    id: 'x',
    summary: 'Mentions of your account, replies to your posts and direct messages become tickets. Replies to posts are public; replies to direct messages are private.',
    capabilities: [
      { label: 'Direct messages', support: 'limited', note: 'Arrive by webhook (needs Account Activity API access) or an optional slow poll that X bills per event.' },
      { label: 'Mentions of your account', support: 'yes', note: 'Polled every 2 minutes; billed only for new posts.' },
      { label: 'Replies to your posts', support: 'yes' },
      { label: 'Public reply from a ticket', support: 'yes', note: 'Up to 280 characters. Zentry only replies to posts that mention or reply to your account.' },
      { label: 'Images and files', support: 'no', note: 'Replies from Zentry are text only.' },
    ],
    requirements: [
      'Requires a paid X API plan: X now bills API use per request from credits you buy in the developer console. Reading a post, creating a post and each DM event all cost credits.',
      'Direct-message webhooks need Account Activity API access on your plan.',
    ],
    access: 'paid',
    env: ['X_CLIENT_ID', 'X_CLIENT_SECRET'],
    steps: [
      'Create an X developer account and a Project with an App at developer.x.com.',
      'Under User authentication settings choose OAuth 2.0, type “Web App, Automated App or Bot”, and add the callback URL shown below.',
      'Request the scopes tweet.read, tweet.write, users.read, dm.read, dm.write and offline.access.',
      'Buy API credits in the developer console, then set X_CLIENT_ID and X_CLIENT_SECRET on the server.',
      'Optional, for direct messages by webhook: set X_API_SECRET to the app’s API secret and register the webhook URL shown below.',
    ],
    connect: 'oauth',
    docs: [
      { label: 'X API pricing', url: 'https://docs.x.com/x-api/getting-started/pricing' },
      { label: 'Account Activity API', url: 'https://docs.x.com/x-api/account-activity/introduction' },
    ],
  },
  threads: {
    id: 'threads',
    summary: 'Threads has no direct messages. Replies to your posts and mentions of your account become tickets, and the answer is a public reply.',
    capabilities: [
      { label: 'Direct messages', support: 'no', note: 'The Threads API has none.' },
      { label: 'Replies to your posts', support: 'yes', note: 'By webhook, and polled every 5 minutes from your last 7 days of posts until the webhook is approved.' },
      { label: 'Mentions of your account', support: 'limited', note: 'Webhook only, which needs App Review for Advanced Access.' },
      { label: 'Public reply from a ticket', support: 'yes', note: 'Up to 500 characters; Threads allows 1,000 replies per account per day.' },
      { label: 'Images and files', support: 'no', note: 'Replies from Zentry are text only.' },
    ],
    requirements: [
      'Free to use, but your Meta app must pass App Review for the Threads permissions before anyone outside your team can connect.',
      'Webhooks for replies and mentions need Advanced Access to threads_read_replies and threads_manage_mentions.',
    ],
    access: 'self_serve',
    env: ['THREADS_APP_ID', 'THREADS_APP_SECRET', 'THREADS_WEBHOOK_VERIFY_TOKEN'],
    steps: [
      'In Meta for Developers, create an app and add the Threads use case.',
      'Add the redirect URL shown below, and your Threads account as a Threads tester while the app is in development.',
      'Request threads_basic, threads_read_replies, threads_manage_replies, threads_content_publish and threads_manage_mentions, and submit the app for App Review.',
      'Set THREADS_APP_ID, THREADS_APP_SECRET and a THREADS_WEBHOOK_VERIFY_TOKEN of your choice on the server.',
      'In the app dashboard subscribe to the replies and mentions webhook fields with the callback URL shown below.',
    ],
    connect: 'oauth',
    docs: [
      { label: 'Threads API overview', url: 'https://developers.facebook.com/docs/threads' },
      { label: 'Threads webhooks', url: 'https://developers.facebook.com/docs/threads/webhooks' },
    ],
  },
  linkedin: {
    id: 'linkedin',
    summary: 'Comments on your Company Page’s posts become tickets, and the answer is a public comment as the Page. LinkedIn offers no direct messages to this kind of integration.',
    capabilities: [
      { label: 'Direct messages', support: 'no', note: 'LinkedIn’s messaging API is limited to approved partners.' },
      { label: 'Comments on your Page’s posts', support: 'yes', note: 'Polled every 15 minutes from the 10 most recently active posts; replies nested under a comment are not read.' },
      { label: 'Mentions of your Page in other people’s posts', support: 'no', note: 'Not available through the API.' },
      { label: 'Public reply from a ticket', support: 'yes', note: 'A comment as the Page, up to 1,250 characters.' },
      { label: 'Images and files', support: 'no', note: 'Replies from Zentry are text only.' },
    ],
    requirements: [
      'Requires LinkedIn approval: your app must be accepted into the Community Management API product.',
      'The person who connects must be an administrator of the Page. LinkedIn’s push notifications for comments are not available to new apps, so Zentry polls instead.',
    ],
    access: 'approval',
    env: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    approvalFlag: 'LINKEDIN_APPROVED',
    steps: [
      'Create an app at linkedin.com/developers and associate it with your Company Page.',
      'Under Products, request “Community Management API” and complete LinkedIn’s access form (use case, Page, screenshots). Approval can take days to weeks.',
      'Add the redirect URL shown below under Auth.',
      'Once approved, set LINKEDIN_CLIENT_ID and LINKEDIN_CLIENT_SECRET on the server, and LINKEDIN_APPROVED=true.',
    ],
    connect: 'oauth_page',
    docs: [
      { label: 'Community Management overview', url: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/community-management-overview' },
      { label: 'Comments API', url: 'https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/comments-api' },
    ],
  },
  tiktok: {
    id: 'tiktok',
    summary: 'Comments on your TikTok videos become tickets, and the answer is a public reply. Direct messages are not supported yet.',
    capabilities: [
      { label: 'Direct messages', support: 'no', note: 'The Business Messaging API is limited to approved partners and is unavailable in the EEA, UK and Switzerland. Not implemented.' },
      { label: 'Comments on your videos', support: 'yes', note: 'By signed webhook once your app is approved.' },
      { label: 'Public reply from a ticket', support: 'yes', note: 'Up to 150 characters.' },
      { label: 'Images and files', support: 'no', note: 'Replies from Zentry are text only.' },
    ],
    requirements: [
      'Requires TikTok approval: a TikTok Business Account and a developer app approved for the organic comment APIs.',
      'This connection has not been tested against TikTok’s live API, because access is granted by TikTok. Expect to check the first real webhook delivery.',
    ],
    access: 'approval',
    env: ['TIKTOK_CLIENT_SECRET'],
    approvalFlag: 'TIKTOK_APPROVED',
    steps: [
      'Switch the TikTok account to a Business Account and link it to TikTok for Business.',
      'Register an app at developers.tiktok.com and the TikTok API for Business portal, and apply for access to managing comments on your own videos.',
      'After approval, generate the access token and Business Account id (open_id) for your account.',
      'Add the webhook URL shown below to the app and set TIKTOK_CLIENT_SECRET to the app secret on the server, and TIKTOK_APPROVED=true.',
    ],
    connect: 'token',
    docs: [
      { label: 'TikTok API for Business', url: 'https://business-api.tiktok.com/portal/docs' },
      { label: 'Webhook signature verification', url: 'https://developers.tiktok.com/doc/webhooks-verification' },
    ],
  },
};

export const SOCIAL_IDS = Object.keys(SOCIAL_CHANNELS) as SocialChannelId[];

export function isSocialChannel(id: string): id is SocialChannelId {
  return id in SOCIAL_CHANNELS;
}

export type SocialAccessState = 'ready' | 'requires_approval' | 'server_setup';

/**
 * Where a channel stands on this server. Pure: pass `process.env`.
 * - requires_approval: the platform has not approved the app yet (per the
 *   operator's approval flag), so connecting would only fail.
 * - server_setup: approved or self-serve, but the app credentials are missing.
 */
export function socialAccess(id: SocialChannelId, env: Record<string, string | undefined>): { state: SocialAccessState; missing: string[] } {
  const info = SOCIAL_CHANNELS[id];
  if (info.access === 'approval' && info.approvalFlag && env[info.approvalFlag] !== 'true') {
    return { state: 'requires_approval', missing: [info.approvalFlag, ...info.env.filter((k) => !env[k])] };
  }
  const missing = info.env.filter((k) => !env[k]);
  // X's webhook secret and Threads' verify token only matter once webhooks are set up.
  const optional = new Set(['X_API_SECRET', 'THREADS_WEBHOOK_VERIFY_TOKEN']);
  const blocking = missing.filter((k) => !optional.has(k));
  return blocking.length ? { state: 'server_setup', missing: blocking } : { state: 'ready', missing: [] };
}
