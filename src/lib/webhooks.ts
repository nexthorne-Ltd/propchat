/** Events a Settings → Webhooks endpoint can subscribe to (migration 20261105090000). */
export const WEBHOOK_EVENTS = ['ticket.created', 'ticket.updated', 'ticket.solved', 'message.created'] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export const WEBHOOK_EVENT_LABELS: Record<WebhookEvent, string> = {
  'ticket.created': 'A ticket is created',
  'ticket.updated': 'A ticket changes (status, priority, assignee, tags, fields)',
  'ticket.solved': 'A ticket is solved',
  'message.created': 'A public message is sent (customer, agent or bot)',
};
