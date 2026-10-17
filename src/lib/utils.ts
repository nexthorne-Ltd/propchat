import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// The design system adds font sizes (text-2xs / text-ui / text-md) that
// tailwind-merge can't know about. Without this it reads `text-ui` as a text
// colour and drops it whenever the same class list also sets `text-ink`.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['2xs', 'ui', 'md'] }],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatTimeAgo(input: string | number | Date): string {
  const date = new Date(input);
  const now = new Date();
  const seconds = Math.floor((now.getTime() - date.getTime()) / 1000);

  if (seconds < 15) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatTime(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function parseUserAgent(ua: string | null): { browser: string; os: string } {
  if (!ua) return { browser: 'Unknown Browser', os: 'Unknown OS' };

  let browser = 'Browser';
  if (ua.includes('Firefox')) browser = 'Firefox';
  else if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome')) browser = 'Chrome';
  else if (ua.includes('Safari')) browser = 'Safari';
  else if (ua.includes('Opera') || ua.includes('OPR/')) browser = 'Opera';

  let os = 'OS';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('Linux')) os = 'Linux';

  return { browser, os };
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission !== 'denied') {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  }
  return false;
}

export function sendBrowserNotification(
  title: string,
  body: string,
  options?: {
    icon?: string;
    tag?: string;
    onClick?: () => void;
  }
) {
  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission === 'granted') {
    try {
      const notif = new Notification(title, {
        body: body.length > 140 ? `${body.slice(0, 137)}...` : body,
        icon: options?.icon || '/chat-icon.png',
        tag: options?.tag || 'zen-try-notification',
      });

      notif.onclick = () => {
        window.focus();
        if (options?.onClick) options.onClick();
        notif.close();
      };
    } catch {
      // Ignored in environments where Notification constructor fails
    }
  }
}

/**
 * Strips markdown symbols from text so previews render cleanly as plain text.
 */
export function stripMarkdown(markdown: string | null | undefined): string {
  if (!markdown) return '';
  return markdown
    // Images: ![alt](url) -> alt
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links: [anchor](url) -> anchor
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    // Headers: # Title
    .replace(/^#{1,6}\s+/gm, '')
    // Bold / italic: ***text***, **text**, *text*, ___text___, __text__, _text_
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/(\*|_)(.*?)\1/g, '$2')
    // Strikethrough: ~~text~~
    .replace(/~~(.*?)~~/g, '$1')
    // Fenced code blocks: ```code```
    .replace(/```[\s\S]*?```/g, (match) => {
      const lines = match.replace(/^```[^\n]*\n?/, '').replace(/\n?```$/, '');
      return lines.trim();
    })
    // Inline code: `code`
    .replace(/`([^`]+)`/g, '$1')
    // Blockquotes: > quote
    .replace(/^\s*>\s+/gm, '')
    // Unordered lists: * item, - item, + item
    .replace(/^\s*[-*+]\s+/gm, '')
    // Ordered lists: 1. item
    .replace(/^\s*\d+\.\s+/gm, '')
    // Horizontal rules: ---, ***, ___
    .replace(/^[-*_]{3,}\s*$/gm, '')
    // HTML tags: <tag> -> ''
    .replace(/<[^>]*>/g, '')
    // Collapse consecutive newlines & spaces to a single space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Detects if a message is an automated greeting/bot message rather than a real agent response.
 */
export function isGreetingMessage(
  msg: { sender_type?: string; sender_id?: string | null; content?: string; metadata?: any } | null | undefined
): boolean {
  if (!msg) return false;
  if (msg.sender_type === 'ai') return true;
  if (msg.sender_type === 'visitor') return false;
  if (msg.metadata?.is_greeting || msg.metadata?.auto_greeting || msg.metadata?.is_bot) return true;

  const text = (msg.content || '').trim().toLowerCase();
  if (
    text.startsWith('hi there! thanks for reaching out') ||
    text.startsWith('hi there!') ||
    text.startsWith('thanks for reaching out') ||
    text.startsWith('welcome to') ||
    text.startsWith("we're here to help") ||
    text.includes('thanks for reaching out. how can i help you today')
  ) {
    return true;
  }

  // System-generated greeting inserted without a human agent id
  if (msg.sender_type === 'agent' && !msg.sender_id) {
    return true;
  }

  return false;
}

