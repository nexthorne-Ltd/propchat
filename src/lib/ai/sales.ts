/**
 * Sales mode: the bot as an honest sales guide for people who are not yet
 * customers, beside the support agent it already is.
 *
 * A prop firm's chat gets two kinds of visitor: traders with a problem on an
 * account they already own, and people deciding whether to buy a challenge.
 * The support prompt treated both the same, so a prospect asking "which plan
 * for me?" got a price list and nothing else, and nobody explained the model
 * or answered the doubts that stop people buying. Selling to someone whose
 * payout is late is worse, so the mode is decided per message:
 *
 * - The opening menu (openingMenu) asks which of the two they are, with
 *   quick-reply buttons, in the visitor's language like every other greeting.
 * - A problem (support topic, "not working", their own account) is support at
 *   once, and stays support. It becomes sales again only on a real buying
 *   signal, and the model is told to finish the problem first.
 * - Price, plans, "how does it work", "funded trader banna hai" is sales.
 * - Anything else carries on in the mode the chat was in, or is neutral
 *   (answered, never pitched).
 *
 * What keeps it honest is in the brief: no guarantees, the risk disclosure
 * once before checkout, only facts and offers from the help centre (figures
 * are still checked by unsupportedFigures, links by parseAgentReply), and
 * "don't buy now" to anyone spending their last savings or borrowed money.
 *
 * Pure and client-safe so it can be tested without a model.
 */

import { localized, type ReplyLanguage } from './intent';
import { OPENING_MENU, OPENING_MENU_QUESTION } from './opening-menu';
import type { SubAgentId } from './sub-agents';

/* ── Opening menu ─────────────────────────────────────────────────────── */

type MenuTexts = { greet: string; question: string; options: [string, string, string]; labels: [string, string, string] };

const MENU: Partial<Record<ReplyLanguage, MenuTexts>> & { en: MenuTexts } = {
  en: {
    greet: 'Hello',
    question: OPENING_MENU_QUESTION,
    options: OPENING_MENU.map((o) => o.value) as [string, string, string],
    labels: OPENING_MENU.map((o) => o.label) as [string, string, string],
  },
  roman_ur: {
    greet: 'Hello',
    question: 'Main aap ki kis cheez mein madad karun?',
    options: [
      'Funded trader banna hai / challenge ke baare mein janna hai',
      'Meri account, payout ya rules ka masla hai',
      'Kuch aur',
    ],
    labels: ['🚀 Funded trader banna hai', '🛠️ Account, payout ya rules ka masla', '💬 Kuch aur'],
  },
  ur: {
    greet: 'السلام علیکم',
    question: 'میں آپ کی کس چیز میں مدد کروں؟',
    options: ['فنڈڈ ٹریڈر بننا ہے / چیلنج کے بارے میں جاننا ہے', 'میرے اکاؤنٹ، پے آؤٹ یا رولز کا مسئلہ ہے', 'کچھ اور'],
    labels: ['🚀 فنڈڈ ٹریڈر بننا ہے', '🛠️ اکاؤنٹ، پے آؤٹ یا رولز کا مسئلہ', '💬 کچھ اور'],
  },
  hi: {
    greet: 'नमस्ते',
    question: 'मैं आपकी किस चीज़ में मदद करूँ?',
    options: ['फंडेड ट्रेडर बनना है / चैलेंज के बारे में जानना है', 'मेरे अकाउंट, पेआउट या रूल्स की समस्या है', 'कुछ और'],
    labels: ['🚀 फंडेड ट्रेडर बनना है', '🛠️ अकाउंट, पेआउट या रूल्स की समस्या', '💬 कुछ और'],
  },
  ar: {
    greet: 'مرحباً',
    question: 'كيف يمكنني مساعدتك اليوم؟',
    options: ['أريد أن أصبح متداولاً ممولاً / معرفة المزيد عن التحدي', 'لدي مشكلة في حسابي أو السحب أو القواعد', 'شيء آخر'],
    labels: ['🚀 أصبح متداولاً ممولاً', '🛠️ مشكلة في الحساب أو السحب أو القواعد', '💬 شيء آخر'],
  },
  es: {
    greet: 'Hola',
    question: '¿En qué te puedo ayudar hoy?',
    options: ['Quiero ser trader fondeado / saber más del challenge', 'Tengo un problema con mi cuenta, un pago o las reglas', 'Otra cosa'],
    labels: ['🚀 Ser trader fondeado', '🛠️ Problema con cuenta, pago o reglas', '💬 Otra cosa'],
  },
  fr: {
    greet: 'Bonjour',
    question: 'Comment puis-je vous aider aujourd’hui ?',
    options: ['Je veux devenir trader financé / en savoir plus sur le challenge', 'J’ai un problème de compte, de paiement ou de règles', 'Autre chose'],
    labels: ['🚀 Devenir trader financé', '🛠️ Problème de compte, paiement ou règles', '💬 Autre chose'],
  },
};

export type MenuChoice = 1 | 2 | 3;

/**
 * The first reply to a greeting in a new chat: the question, the three
 * options numbered (so typing "1" works too) and the same options as buttons.
 * A button sends its option's full line, which menuChoice recognises in every
 * language. `intro` is the workspace's own canned greeting, used in place of
 * "Hello! How can I help you today?" when it has one.
 */
export function openingMenu(
  lang: ReplyLanguage,
  name?: string | null,
  intro?: string | null
): { text: string; quickReplies: Array<{ label: string; value: string }> } {
  const m = MENU[lang] ?? MENU.en;
  const who = name?.trim() ? ` ${name.trim()}` : '';
  const head = intro?.trim() || `${m.greet}${who}! 👋 ${m.question}`;
  return {
    text: `${head}\n1. ${m.options[0]}\n2. ${m.options[1]}\n3. ${m.options[2]}`,
    quickReplies: m.options.map((value, i) => ({ label: m.labels[i], value })),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

const OPTION_LINES: Array<[string, MenuChoice]> = Object.values(MENU).flatMap((m) =>
  m ? ([...m.options.map((o, i) => [norm(o), i + 1]), ...m.labels.map((l, i) => [norm(l), i + 1])] as Array<[string, MenuChoice]>) : []
);

const FIRST_OPTIONS = Object.values(MENU).map((m) => (m ? `\n1. ${m.options[0]}` : '')).filter(Boolean);

/** The bot's message is the opening menu (any language, any intro). */
export function isOpeningMenu(content: string | null | undefined): boolean {
  return Boolean(content) && FIRST_OPTIONS.some((line) => content!.includes(line));
}

/**
 * Which menu option the visitor picked: a button (its option line or label,
 * in any language), or a bare "1", "2" or "3" typed right after the menu.
 */
export function menuChoice(message: string, recent: { role: string; content: string }[] = []): MenuChoice | null {
  const text = norm(message);
  if (!text) return null;
  const hit = OPTION_LINES.find(([line]) => line === text);
  if (hit) return hit[1];
  const digit = message.trim().match(/^(?:option\s*)?([123])\s*[.)]?$/i)?.[1];
  if (!digit) return null;
  const lastBot = [...recent].reverse().find((m) => m.role === 'assistant');
  return isOpeningMenu(lastBot?.content) ? (Number(digit) as MenuChoice) : null;
}

/** "Something else": ask what they need, without a model. */
export function somethingElseReply(lang: ReplyLanguage): string {
  return localized(lang, {
    en: 'Sure! Tell me what you need help with and I will take it from there.',
    roman_ur: 'Zaroor! Bataiye kis cheez mein madad chahiye, main dekh leta hoon.',
    ur: 'ضرور! بتائیے کس چیز میں مدد چاہیے، میں دیکھ لیتا ہوں۔',
    hi: 'ज़रूर! बताइए किस चीज़ में मदद चाहिए, मैं देख लेता हूँ।',
    ar: 'بالتأكيد! أخبرني بما تحتاج إليه وسأساعدك.',
    es: '¡Claro! Cuéntame en qué necesitas ayuda.',
    fr: 'Bien sûr ! Dites-moi de quoi vous avez besoin.',
  });
}

/* ── Which mode this message is in ────────────────────────────────────── */

export type ChatMode = 'sales' | 'support' | 'neutral';

/** Specialists whose topic is a problem with something the trader already has. */
const SUPPORT_AGENTS = new Set<SubAgentId>([
  'account',
  'account_status',
  'kyc_status',
  'order_lookup',
  'refunds',
  'platform',
  'affiliate_stats',
  'coupon_check',
  'human_handover',
]);

/** Something is wrong: English, Roman Urdu and the usual shorthand. */
const PROBLEM =
  /\b(not\s+(?:work\w*|receiv\w*|show\w*|load\w*|arriv\w*|credited|paid)|didn'?t\s+(?:get|receive|work)|doesn'?t\s+work|isn'?t\s+working|can'?t\s+(?:log\s*in|login|access|withdraw)|unable|issue|problem|error|stuck|failed|breach(?:ed)?|blown?|deducted|charged\s+twice|late|delay\w*|pending\s+(?:payout|kyc|withdrawal)|rejected|declined|masl[ae]|mas'?ala|nahi?\s+(?:mila|aya|aaya|ayi|aayi|chal|ho\s+raha|ho\s+rahi|khul)|kaam\s+nahi|band\s+ho\s+gaya|ud\s+gaya|urr?\s+gaya|wapis\s+nahi)\b/i;

/** Wants to buy, or to understand the offer before buying. */
const SALES_SIGNAL =
  /\b(funded\s+trader\s+ban\w*|become\s+(?:a\s+)?funded|get\s+funded|how\s+(?:does\s+(?:it|this)|do\s+you)\s+work|kaise\s+kaam\s+kart[ai]|kaise\s+(?:join|start)|want\s+to\s+(?:join|start|buy|try)|(?:challenge|account|plan)\s+(?:lena|leni|kharid\w*|buy)|which\s+(?:plan|account|challenge)|best\s+(?:plan|account|challenge)\s+for\s+me|is\s+it\s+(?:worth|legit)|scam|too\s+expensive|mehnga|cheaper|i'?ll\s+think|soch\s+(?:ke|kar)\s+bata\w*)\b/i;

/** Says they already bought or hold an account: a customer, not a lead. */
const ALREADY_CUSTOMER =
  /\b(i\s+(?:already\s+)?(?:bought|purchased|paid\s+for|have\s+(?:a|an|my)\s+(?:\d+k\s+)?(?:account|challenge))|my\s+(?:\d+k\s+)?(?:account|challenge|funded\s+account)|(?:account|challenge)\s+(?:le\s+liya|kharid\s+liya|khareed\s+liya)|mera\s+(?:\d+k\s+)?(?:account|challenge)|maine\s+(?:account|challenge)\s+(?:liya|kharida|khareeda))\b/i;

/** Spending money they cannot afford to lose. */
const AFFORDABILITY_RISK =
  /\b(last\s+(?:of\s+my\s+)?savings|all\s+my\s+savings|only\s+savings|borrow\w*|loan|credit\s+card\s+debt|qarz|qarza|karz|udhaa?r|aakhri\s+(?:paise|paisay|bachat)|sari\s+bachat|bachat\s+ke\s+(?:paise|paisay)|ghar\s+ke\s+paise)\b/i;

export function affordabilityRisk(message: string): boolean {
  return AFFORDABILITY_RISK.test(message);
}

export function soundsLikeCustomer(texts: string[]): boolean {
  return texts.some((t) => ALREADY_CUSTOMER.test(t));
}

export interface ModeInput {
  message: string;
  /** Oldest first; may include the latest message. */
  recent?: { role: string; content: string }[];
  /** The specialist the router picked for this message. */
  agent: SubAgentId;
  /** The intent classifier's verdict. */
  intent?: string | null;
}

export interface ModeResult {
  mode: ChatMode;
  reason: string;
  /** The visitor picked this from the opening menu. */
  choice: MenuChoice | null;
  /** They came with a problem earlier in this chat. */
  hadProblem: boolean;
  /** They said they already bought or hold an account. */
  isCustomer: boolean;
}

function signalOf(text: string, agent: SubAgentId | null, intent?: string | null): ChatMode | null {
  if (intent === 'account_specific' || (agent && SUPPORT_AGENTS.has(agent)) || PROBLEM.test(text)) return 'support';
  if (agent === 'pricing_offers' || SALES_SIGNAL.test(text)) return 'sales';
  return null;
}

/**
 * Sales or support for this message. A problem wins at once; a buying signal
 * after a problem is sales, flagged so the model finishes the problem first;
 * otherwise the chat keeps the mode its last clear message set.
 */
export function decideChatMode(input: ModeInput): ModeResult {
  const recent = (input.recent || []).filter((m) => m.content?.trim());
  const visitorEarlier = recent.filter((m) => m.role === 'user' && m.content.trim() !== input.message.trim());
  const choice = menuChoice(input.message, recent);
  let hadProblem = false;
  let prior: ChatMode | null = null;
  recent.forEach((m, i) => {
    if (m.role !== 'user' || m.content.trim() === input.message.trim()) return;
    const picked = menuChoice(m.content, recent.slice(0, i));
    const s = picked === 2 ? 'support' : picked === 1 ? 'sales' : signalOf(m.content, null);
    if (s === 'support') hadProblem = true;
    if (s) prior = s;
  });
  const isCustomer = soundsLikeCustomer([input.message, ...visitorEarlier.map((m) => m.content)]);
  const base = { choice, hadProblem, isCustomer };

  if (choice === 2) return { ...base, mode: 'support', reason: 'Picked the support option' };
  if (choice === 1) return { ...base, mode: 'sales', reason: 'Picked the funded-trader option' };
  if (choice === 3) return { ...base, mode: 'neutral', reason: 'Picked something else' };

  const now = signalOf(input.message, input.agent, input.intent);
  if (now === 'support') return { ...base, mode: 'support', reason: 'Raised a problem' };
  if (now === 'sales') return { ...base, mode: 'sales', reason: hadProblem ? 'Buying signal after a problem' : 'Asked about buying' };
  if (prior) return { ...base, mode: prior, reason: `Carries on in ${prior}` };
  return { ...base, mode: 'neutral', reason: 'No sales or support signal' };
}

/* ── What the model is told ───────────────────────────────────────────── */

/**
 * The Sales specialist's brief, and the extra lines for any specialist that
 * answers in sales mode (a rules question from a prospect is answered by the
 * Rules specialist, with these rules on top).
 */
export const SALES_RULES = [
  'You are talking to a prospect who is deciding whether to buy a challenge. Help them decide honestly; you are a guide, not a closer.',
  'HOW TO WORK:',
  '1. Understand first, one question at a time: their trading experience, what they want (get funded, or practise under real rules), and a budget they are comfortable with. Skip anything they already told you. Never ask more than one question in a reply.',
  '2. Explain the model simply when they do not know it: they pay a one-time evaluation fee, trade by the rules, and if they pass they get a funded account and a share of the profit. Say clearly that passing is not guaranteed.',
  '3. Once you know enough, recommend ONE plan that fits them and say why in one sentence. Never push the biggest plan by default; a beginner or a small budget gets a smaller size.',
  '4. Use only real value points from the HELP CENTER: larger capital, risk limited to the fee, the profit split, clear rules, the payout schedule. Never invent numbers, rules, discounts, payout proof or trader results.',
  '5. Doubts ("is it a scam", "too expensive", "rules too strict", "I failed before", "I\'ll think about it", "another firm is cheaper"): acknowledge, answer with facts from the HELP CENTER, then ask whether that cleared it. Never run down another firm.',
  '6. Close with ONE clear next step: the checkout or sign-up link for the plan you recommended, only if that link is in the HELP CENTER. If they are not ready, do not push: give the pricing or rules link if there is one and say they can come back any time.',
  'PERSUASION: give value first, move in small steps, use urgency or a discount ONLY when the HELP CENTER states a real current offer (with its end date if given).',
  'HARD RULES:',
  '- Never guarantee profit, passing or payouts. Never say "easy money", "risk-free" or "sure pass".',
  '- Before you give a checkout link, say once, plainly (skip it if you already said it in this chat): trading carries risk, many traders do not pass, and the fee is non-refundable except as the refund policy says.',
  '- A fact that is not in the HELP CENTER: say plainly it is not listed and give the closest thing it does say; never make it up. Hand over ([HANDOVER: what they asked]) only if they cannot decide or buy without that exact fact.',
  '- No trading signals and no personal financial advice.',
  '- Never ask for passwords or card details. Payment happens only on the official checkout page.',
  '- If they say no, not now, or stop: respect it, thank them warmly and end; do not try again.',
  '- If they become angry, or raise a payout or KYC dispute: stop selling and help with substance first. Hand over, with [HANDOVER: a two-line summary of what they want], only when a person must check or decide something.',
  'STYLE: short messages, one question at a time, no hype, no pressure, no exclamation-mark selling.',
].join('\n');

export function salesModeSituation(r: ModeResult, message: string): string[] {
  return [
    `SALES MODE. Follow these rules for this reply, on top of everything above:\n${SALES_RULES}`,
    r.choice === 1
      ? 'They just picked "become a funded trader" from the menu: welcome that in one line and ask your first understanding question.'
      : null,
    r.hadProblem
      ? 'They came to this chat with a problem earlier. If it is not clearly solved, finish that first and do not sell until it is.'
      : null,
    r.isCustomer
      ? 'They already bought or hold an account: they are a customer. Do not re-sell the plan they have; only answer about a different plan or an add-on if they ask.'
      : null,
    affordabilityRisk(message)
      ? 'They said this money is their last savings or borrowed. Advise them clearly and kindly NOT to buy now: the fee can be lost. Do not give a checkout link.'
      : null,
  ].filter((s): s is string => Boolean(s));
}

export const SUPPORT_MODE_SITUATION =
  'SUPPORT MODE: the customer has a problem or a question about something they already have. Solve it. Do not sell, recommend plans, mention offers or give checkout links in this reply.';

export const SUPPORT_CHOICE_SITUATION =
  'They just picked "I have an issue with my account, payout or rules" from the menu without saying what it is. Ask in one short question what the problem is (and their account number if it is about their own account).';

/** Lines for the prompt's RIGHT NOW section in this mode. Neutral adds nothing. */
export function modeSituation(r: ModeResult, message: string, salesEnabled: boolean): string[] {
  if (r.mode === 'support') return [SUPPORT_MODE_SITUATION, r.choice === 2 ? SUPPORT_CHOICE_SITUATION : null].filter((s): s is string => Boolean(s));
  if (r.mode === 'sales' && salesEnabled) return salesModeSituation(r, message);
  if (r.mode === 'sales') return [SUPPORT_MODE_SITUATION];
  return [];
}
