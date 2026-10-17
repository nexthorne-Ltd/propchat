/**
 * Reading what the visitor typed during a trader lookup: an email to verify,
 * the 6-digit code sent to it, and the ids worth passing to the endpoint as
 * hints. Pure functions, no server imports, so the tests run them directly.
 *
 * Hints are only hints: the endpoint receives the verified email and must
 * check that an account number or order id belongs to it (docs/TRADER_DATA.md).
 */
import type { ReplyLanguage } from '@/lib/ai/intent';

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,24}/i;

export function extractEmail(text: string): string | null {
  const m = (text || '').match(EMAIL);
  return m ? m[0].toLowerCase().replace(/\.+$/, '') : null;
}

/**
 * The code, when the message is essentially just the code ("482913",
 * "code: 482 913", "ye raha 482913"). A six-digit number inside a longer
 * question ("my login is 482913, why breached?") is not taken for a code.
 */
export function extractCode(text: string): string | null {
  const t = (text || '').trim();
  if (t.length > 40) return null;
  const m = t.match(/(?:^|\D)(\d{3})[\s-]?(\d{3})(?:\D|$)/);
  if (!m) return null;
  const rest = t.replace(m[0], ' ').replace(/[^a-z]/gi, ' ').trim();
  // At most a few words around it: "code", "ye raha", "here it is".
  if (rest.split(/\s+/).filter(Boolean).length > 4) return null;
  return `${m[1]}${m[2]}`;
}

export interface LookupHints {
  account_login?: string;
  order_id?: string;
  coupon_code?: string;
}

/** Common words that follow "code" without being one ("code apply nahi"). */
const NOT_A_CODE = /^(apply|applied|not|nahi|nai|kaam|work|works|working|valid|invalid|expired|error|kya|hai|is|the|for|kaise|code|coupon|promo|discount|chal|lag|raha|rahi)$/i;

export function extractHints(...texts: (string | null | undefined)[]): LookupHints {
  const hints: LookupHints = {};
  for (const raw of texts) {
    const text = raw || '';
    if (!hints.order_id) {
      // "order id O-2681", or the id on its own anywhere ("staus check kr
      // dein o-2681"): the prop-firm backend's ids are o-1234 / ord-….
      const named = text.match(/\b(?:order|invoice|payment)\s*(?:id|number|no\.?|#|ref(?:erence)?)?\s*[:#]?\s*([A-Z0-9][A-Z0-9-]{3,39})\b/i);
      const bare = text.match(/\b((?:o|ord|order)-[a-z0-9-]*\d[a-z0-9-]*)\b/i);
      const id = named && /\d/.test(named[1]) ? named[1] : bare?.[1];
      if (id) hints.order_id = id;
    }
    if (!hints.account_login) {
      const m = text.match(/\b(?:login|account|acc|mt[45])\s*(?:id|no\.?|number|#)?\s*(?:is|hai|:|#)?\s*(\d{5,12})\b/i);
      if (m) hints.account_login = m[1];
    }
    if (!hints.coupon_code) {
      const candidates = [
        text.match(/\b(?:code|coupon|promo)\s*[:"'“]?\s*([A-Za-z0-9_-]{3,24})\b/i)?.[1],
        text.match(/\b([A-Z][A-Z0-9_-]{2,23}\d[A-Z0-9_-]*|[A-Z0-9_-]*\d[A-Z0-9_-]*[A-Z][A-Z0-9_-]*)\b/)?.[1],
      ];
      // A code has a digit or capitals; "code apply nahi" names no code.
      const code = candidates.find(
        (c) => c && c.length >= 3 && !NOT_A_CODE.test(c) && (/\d/.test(c) || c === c.toUpperCase())
      );
      if (code) hints.coupon_code = code;
    }
  }
  return hints;
}

/* ── What the bot says while verifying (fixed text, no model) ─────────── */

type Lang = 'en' | 'roman_ur';
const pick = (lang: ReplyLanguage): Lang => (lang === 'roman_ur' ? 'roman_ur' : 'en');

export function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  if (!domain) return email;
  const shown = user.length <= 2 ? user[0] ?? '' : `${user.slice(0, 2)}`;
  return `${shown}${'•'.repeat(Math.max(2, Math.min(6, user.length - shown.length)))}@${domain}`;
}

export const verificationText = {
  askEmail(lang: ReplyLanguage): string {
    return pick(lang) === 'roman_ur'
      ? 'Aapka record check karne ke liye pehle confirm karna hai ke account aapka hi hai. Apni account wali email likh dein, main us par 6-digit code bhejunga.'
      : "To check your record I first need to confirm the account is yours. Please type the email on your account and I'll send a 6-digit code to it.";
  },
  askEmailOnly(lang: ReplyLanguage): string {
    return pick(lang) === 'roman_ur'
      ? 'Main aapka record abhi check karta hoon. Apni account wali email likh dein (jis email se account bana hai).'
      : "I'll check your record right away. Please type the email your account is registered with.";
  },
  codeSent(lang: ReplyLanguage, email: string): string {
    return pick(lang) === 'roman_ur'
      ? `Maine ${maskEmail(email)} par 6-digit code bhej diya hai. Code yahan chat mein likh dein (10 minute tak chalega). Email na mile to spam folder dekh lein.`
      : `I've sent a 6-digit code to ${maskEmail(email)}. Type it here in the chat (it works for 10 minutes). If you can't find it, check your spam folder.`;
  },
  wrongCode(lang: ReplyLanguage, left: number): string {
    return pick(lang) === 'roman_ur'
      ? `Ye code sahi nahi hai. Dobara check kar ke likh dein (${left} koshish baqi).`
      : `That code isn't right. Please check it and try again (${left} ${left === 1 ? 'try' : 'tries'} left).`;
  },
  expired(lang: ReplyLanguage): string {
    return pick(lang) === 'roman_ur'
      ? 'Ye code expire ho gaya hai. Apni email dobara likh dein, main naya code bhej deta hoon.'
      : 'That code has expired. Type your email again and I will send a new one.';
  },
  waitBeforeResend(lang: ReplyLanguage, seconds: number): string {
    return pick(lang) === 'roman_ur'
      ? `Code abhi bheja hai. Thori der (${seconds} second) mein email check karein; na aaye to phir email likh dein.`
      : `A code was just sent. Give it ${seconds} seconds to arrive; if it still has not, type your email again.`;
  },
};

/** Too many codes or wrong tries: a person takes over (fixed text). */
export function verificationLockedText(lang: ReplyLanguage): string {
  return pick(lang) === 'roman_ur'
    ? 'Security ki wajah se main abhi aur codes nahi bhej sakta. Hamari team aapki madad karegi.'
    : "For security I can't send more codes right now. Our team will help you from here.";
}
