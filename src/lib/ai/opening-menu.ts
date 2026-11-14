/**
 * The opening menu's English lines, shared by the bot (sales.ts) and the
 * widget's welcome (widget/src/index.ts), which imports this file into its
 * bundle. No imports here, so the widget pulls nothing else in.
 *
 * The widget writes these lines into the welcome it saves when a chat opens;
 * the bot recognises a button (its `value`) or a typed digit after them. If
 * the two copies drifted, the widget's buttons would stop being understood,
 * which is why there is only one.
 */
export const OPENING_MENU_QUESTION = 'How can I help you today?';

export const OPENING_MENU: Array<{ label: string; value: string }> = [
  { label: '🚀 Become a funded trader', value: 'I want to become a funded trader / learn about the challenge' },
  { label: '🛠️ Account, payout or rules issue', value: 'I have an issue with my account, payout or rules' },
  { label: '💬 Something else', value: 'Something else' },
];
