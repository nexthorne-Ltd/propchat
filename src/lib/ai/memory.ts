/**
 * Conversation Memory & Context Retention
 *
 * Human support agents naturally remember facts the customer stated earlier in the chat
 * (name, email, account size, phase, platform, order id, topic) and do not annoy the customer
 * by asking for details they already gave.
 *
 * They also use natural micro-acknowledgments ("Got it,", "Acha samajh gaya,", "Sure thing,")
 * to pace the conversation naturally instead of robotically dumping documentation.
 */

import type { ReplyLanguage } from './intent';

export interface ExtractedMemory {
  visitorName?: string | null;
  visitorEmail?: string | null;
  accountSize?: string | null;
  planOrPhase?: string | null;
  platform?: string | null;
  orderOrAccountId?: string | null;
  topic?: string | null;
  userSentiments?: string[];
  keyFacts?: string[];
}

const ACCOUNT_SIZE_REGEX = /\b(5k|10k|15k|25k|50k|100k|200k|300k|400k|500k|\$?[5-9]000|\$?[1-5]00,000|\$?[1-5]00000)\b/i;
const PLAN_PHASE_REGEX = /\b(1-step|2-step|one\s*step|two\s*step|instant(?:\s*funding)?|phase\s*[12]|step\s*[12]|evaluation|verification|funded\s*account|live\s*account|master\s*account)\b/i;
const PLATFORM_REGEX = /\b(mt4|mt5|metatrader\s*[45]|ctrader|dxtrade|tradelocker)\b/i;
const EMAIL_REGEX = /\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b/;
const ORDER_ID_REGEX = /\b(?:order|account|login|ticket|id)[:\s#]*([a-zA-Z0-9_-]{4,16})\b/i;

// Name self-introductions in English & Roman Urdu
const NAME_INTRO_REGEX = /\b(?:my name is|i am|i'm|this is|mera naam|naam hai)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/i;

/**
 * Extracts remembered facts across conversation turns and visitor profile.
 */
export function extractConversationMemory(
  messages: Array<{ role?: string; sender_type?: string; content?: string | null }>,
  visitorInfo?: { name?: string | null; email?: string | null } | null
): ExtractedMemory {
  const memory: ExtractedMemory = {
    visitorName: visitorInfo?.name || null,
    visitorEmail: visitorInfo?.email || null,
    keyFacts: [],
  };

  // Traverse messages chronologically
  for (const m of messages) {
    const text = typeof m.content === 'string' ? m.content.trim() : '';
    if (!text) continue;

    const isUser = m.role === 'user' || m.sender_type === 'visitor';

    if (isUser) {
      // Name detection if not already present
      if (!memory.visitorName) {
        const nameMatch = text.match(NAME_INTRO_REGEX);
        if (nameMatch && nameMatch[1]) {
          let cand = nameMatch[1].trim();
          // Strip Roman Urdu / English trailing particles like "hai", "hoon", "here", "aur", "and"
          cand = cand.replace(/\s+(?:hai|hoon|hu|here|aur|and)$/i, '').trim();
          if (!/^(hello|hi|hey|please|help|sir|madam|admin|agent|support|hai|hoon)$/i.test(cand)) {
            memory.visitorName = cand;
          }
        }
      }

      // Email detection
      if (!memory.visitorEmail) {
        const emailMatch = text.match(EMAIL_REGEX);
        if (emailMatch && emailMatch[1]) {
          memory.visitorEmail = emailMatch[1].toLowerCase();
        }
      }

      // Account size
      if (!memory.accountSize) {
        const sizeMatch = text.match(ACCOUNT_SIZE_REGEX);
        if (sizeMatch && sizeMatch[1]) {
          memory.accountSize = sizeMatch[1].toUpperCase();
        }
      }

      // Plan or phase
      if (!memory.planOrPhase) {
        const planMatch = text.match(PLAN_PHASE_REGEX);
        if (planMatch && planMatch[1]) {
          memory.planOrPhase = planMatch[1].toLowerCase();
        }
      }

      // Platform
      if (!memory.platform) {
        const platMatch = text.match(PLATFORM_REGEX);
        if (platMatch && platMatch[1]) {
          memory.platform = platMatch[1].toUpperCase();
        }
      }

      // Order or account ID
      if (!memory.orderOrAccountId) {
        const orderMatch = text.match(ORDER_ID_REGEX);
        if (orderMatch && orderMatch[1]) {
          memory.orderOrAccountId = orderMatch[1];
        }
      }

      // Topic detection
      if (!memory.topic) {
        if (/\b(payout|withdrawal|profit\s*split|paisay)\b/i.test(text)) {
          memory.topic = 'Payouts & Withdrawals';
        } else if (/\b(drawdown|loss\s*limit|daily\s*loss|dd|breach)\b/i.test(text)) {
          memory.topic = 'Drawdown Rules & Limits';
        } else if (/\b(news|weekend|ea|bot|copy\s*trad|hedg|scalp)\b/i.test(text)) {
          memory.topic = 'Trading Rules & Restrictions';
        } else if (/\b(kyc|document|passport|id\s*card|contract)\b/i.test(text)) {
          memory.topic = 'KYC & Verification';
        } else if (/\b(reset|retry|retake|refund|fee)\b/i.test(text)) {
          memory.topic = 'Account Reset / Refund';
        }
      }
    }
  }

  return memory;
}

/**
 * Formats extracted memory into a system prompt block.
 */
export function formatMemoryForPrompt(memory: ExtractedMemory): string | null {
  const lines: string[] = [];

  if (memory.visitorName) {
    lines.push(`- Customer name: "${memory.visitorName}" (address them naturally by first name when helpful)`);
  }
  if (memory.visitorEmail) {
    lines.push(`- Customer email: ${memory.visitorEmail}`);
  }
  if (memory.accountSize) {
    lines.push(`- Stated account size: ${memory.accountSize}`);
  }
  if (memory.planOrPhase) {
    lines.push(`- Stated plan/phase: ${memory.planOrPhase}`);
  }
  if (memory.platform) {
    lines.push(`- Stated platform: ${memory.platform}`);
  }
  if (memory.orderOrAccountId) {
    lines.push(`- Stated order/account identifier: ${memory.orderOrAccountId}`);
  }
  if (memory.topic) {
    lines.push(`- Current topic: ${memory.topic}`);
  }

  if (lines.length === 0) return null;

  return [
    '# CONVERSATION MEMORY & KNOWN DETAILS (CRITICAL)',
    ...lines,
    '* RETENTION RULE: The customer already provided these details earlier. NEVER ask them to repeat any of this information. Tailor your answer directly to their stated account, platform, or situation.',
  ].join('\n');
}

/**
 * Guidelines for realistic human Micro-Acknowledgments and Conversational Pacing.
 */
export function getMicroAcknowledgmentGuideline(lang: ReplyLanguage): string {
  if (lang === 'roman_ur') {
    return `# MICRO-ACKNOWLEDGMENTS & HUMAN TONE (ROMAN URDU)
- Shuru mein hamesha ek chota, natural human acknowledgment dein jese ek real friendly agent chat karta hai:
  * General sawal: "Acha samajh gaya,", "Ji bilkul,", "Theek hai,", "Haanji,"
  * Agar customer pareshan ya confused ho: "Pareshan na hon, mein check kar leta hoon,", "Fikr na karein, let's sort this out,", "Samajh sakta hoon,"
- Kabhi robotic formalities na use karein: "Dear customer", "Greetings", "As an AI language model", "Mohtaram saarim" bilkul mana hain.
- Sidha aur dostana andaaz mein 2-3 short sentences mein jawab dein.`;
  }

  if (lang === 'ur') {
    return `# MICRO-ACKNOWLEDGMENTS & HUMAN TONE (URDU)
- جواب کے آغاز میں دوستانہ اور فطری انداز اپنائیں (مثلاً: "جی بالکل،"، "سمجھ گیا،"، "پریشان نہ ہوں، میں دیکھتا ہوں")۔
- غیر ضروری رسمی یا روبوٹک الفاظ (جیسے "محترم صارف"، "بطور اے آئی") ہرگز استعمال نہ کریں۔`;
  }

  return `# MICRO-ACKNOWLEDGMENTS & HUMAN TONE (ENGLISH)
- Begin responses naturally with a brief, warm human micro-acknowledgment fitting the situation:
  * General inquiries: "Got it,", "Understood,", "Sure thing,", "I see,"
  * Issues, delays, or frustration: "Oh, sorry to hear that!", "No worries at all, let's get this sorted,", "I completely understand your concern,"
- Strictly NEVER use robotic platitudes like:
  * "Dear valued customer", "Greetings!", "As an AI language model...", "I hope this email/message finds you well", "Thank you for reaching out to us today. I would be more than delighted to assist you with your query."
- Keep sentences concise, punchy and warm, exactly like an experienced live chat agent on WhatsApp or Intercom.`;
}
