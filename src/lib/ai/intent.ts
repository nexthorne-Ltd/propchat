/**
 * What the visitor wants, decided before anything is retrieved or answered.
 *
 * The assistant used to have seven intents whose model prompt and keyword
 * lists were written for one prop-trading workspace ("off_topic: unrelated to
 * trading"). Every other workspace inherited that view of the world, so an
 * order question in a shop was classed as off-topic, a refund-policy question
 * that mentioned "my" became an account escalation, and a visitor answering
 * "yes" to "shall I connect you?" was treated as small talk.
 *
 * There are now five intents, each with one way of being handled:
 *
 *   help_center_question  answered from the workspace's published articles,
 *                         with a citation, or not at all
 *   account_specific      about the visitor's own order/account/payment; the
 *                         articles cannot know it, so a person takes over
 *   small_talk            greetings, thanks, "how are you", goodbyes
 *   out_of_scope          a general question, not about this business (maths,
 *                         definitions, recipes); answered briefly by the model
 *                         when it is truly general, otherwise a person takes over
 *   wants_human           asked for a person, said yes to our offer of one,
 *                         or is angry with nothing to look up
 *
 * Rules decide the cases they can be certain about. A configured model decides
 * the rest, seeing the workspace's own help-centre topics so "in scope" means
 * this business rather than a hardcoded industry. Without a model, the rules
 * decide everything.
 */

import { chat, isConfigured, type ProviderConfig } from './provider';
import { wantsHuman } from './help-answer';
import { detectLanguage } from './translator';
import { JEV_THRESHOLDS, jevIntent, type JevIntentVerdict, type JevRuntime } from './jev';

export type VisitorIntent =
  | 'help_center_question'
  | 'account_specific'
  | 'small_talk'
  | 'out_of_scope'
  | 'wants_human';

export const VISITOR_INTENTS: readonly VisitorIntent[] = [
  'help_center_question',
  'account_specific',
  'small_talk',
  'out_of_scope',
  'wants_human',
];

export type SmallTalkKind = 'greeting' | 'thanks' | 'other';

export interface IntentClassificationResult {
  intent: VisitorIntent;
  confidence: number;
  /** Rules are deterministic; the model (or Jev) is only asked when rules are unsure. */
  source: 'rules' | 'model' | 'jev';
  /** Why this intent, in a few words. Shown to agents in handover notes. */
  reason: string;
  smallTalkKind?: SmallTalkKind;
  /** Frustration or accusation, whatever the intent; replies open with an apology. */
  isComplaint?: boolean;
  /** Time-critical ("today", "urgent", or Jev over JEV_THRESHOLDS.urgent): a handover goes in as urgent. */
  isUrgent?: boolean;
  /** Spam or a scam: answered with a template, no model, no handover. */
  isSpam?: boolean;
  accountNumber?: string | null;
  orderNumber?: string | null;
  email?: string | null;
  /** One English line for agents, when the model wrote one. */
  summary?: string | null;
  /** What Jev said, when it was asked (shadow or live); logged, never shown. */
  jev?: JevIntentRecord;
}

export interface JevIntentRecord {
  verdict: Omit<JevIntentVerdict, 'model'> | null;
  /** Jev's verdict decided the intent (live and confident enough). */
  used: boolean;
  error?: string;
}

/* ── Language ─────────────────────────────────────────────────────────── */

export type ReplyLanguage = 'en' | 'roman_ur' | 'ur' | 'hi' | 'ar' | 'es' | 'fr';

/** Words that are almost never English. One is enough. */
const ROMAN_URDU_STRONG =
  /\b(kya|kia|hai|hain|mujhe|mujhay|mera|meri|mere|kaise|kese|kaisay|shukriya|batao|bataen|bataein|chahiye|chahye|kitna|kitne|kitni|nahi|nahin|karwa|karwao|karein|kijiye|insaan|insan|kisi|koi|haan|theek|acha|accha|bohot|bahut|aap|apka|apki|hoga|hogi|raha|rahi|gaya|gayi|aya|aaya)\b/gi;
/** Words that also occur in English text; two are needed. */
const ROMAN_URDU_WEAK = /\b(main|mein|ap|tak|ji|jee|kab|baat|abhi|se|ka|ki|ke|ko|bhi|do)\b/gi;

/**
 * The language and script a reply must be written in. Roman Urdu mixed with
 * English counts as Roman Urdu: that is how the visitor writes, and answering
 * "mera order kahan hai" in formal English reads as a different conversation.
 */
export function replyLanguageOf(text: string): ReplyLanguage {
  const message = text || '';
  if (/[ऀ-ॿ]/.test(message)) return 'hi';
  if (/[؀-ۿ]/.test(message)) {
    return detectLanguage(message).code === 'ar' ? 'ar' : 'ur';
  }
  const detected = detectLanguage(message);
  if (detected.name === 'Urdu (Roman)' || detected.code === 'ur' || detected.code === 'hi') {
    return 'roman_ur';
  }
  if (detected.code === 'es' || detected.code === 'fr') return detected.code;
  const strong = message.match(ROMAN_URDU_STRONG)?.length ?? 0;
  const weak = message.match(ROMAN_URDU_WEAK)?.length ?? 0;
  if (strong >= 1 || weak >= 3) return 'roman_ur';
  return 'en';
}

export const LANGUAGE_LABEL: Record<ReplyLanguage, string> = {
  en: 'English',
  roman_ur: 'Roman Urdu (often mixed with English)',
  ur: 'Urdu',
  hi: 'Hindi',
  ar: 'Arabic',
  es: 'Spanish',
  fr: 'French',
};

/** Picks the template for a language, falling back to English. */
export function localized(lang: ReplyLanguage, texts: Partial<Record<ReplyLanguage, string>> & { en: string }): string {
  return texts[lang] ?? texts.en;
}

/* ── Names ────────────────────────────────────────────────────────────── */

const GREETING_OR_GENERIC_NAMES = new Set([
  'hi', 'hello', 'hey', 'hiya', 'heya', 'hola', 'bonjour', 'salut', 'ciao', 'namaste', 'hallo',
  'salam', 'salom', 'hlw', 'hlo', 'assalam', 'assalamu', 'aloha', 'yo', 'goodmorning',
  'goodafternoon', 'goodevening', 'guest', 'visitor', 'user', 'someone', 'anonymous', 'admin', 'test',
]);

/**
 * Strips display names that are greetings or generic placeholders so the bot
 * never addresses customers as "Hi Hi!" or "Hello Hey".
 */
export function cleanVisitorDisplayName(name?: string | null): string | null {
  if (!name) return null;
  const trimmed = name.trim();
  if (!trimmed) return null;
  const normalized = trimmed.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (GREETING_OR_GENERIC_NAMES.has(normalized)) return null;
  if (/^(hi+|hello+|hey+|yo+|salam|hola|salut|ciao|namaste|hlw|hlo|test)$/i.test(trimmed)) return null;
  return trimmed;
}

/* ── Rules ────────────────────────────────────────────────────────────── */

const GREETING =
  /^(hi+|hello+|hey+|hiya|heya|hola|bonjour|salut|ciao|namaste|hlw|hlo|hallo|aloha|yo|good\s+(?:morning|afternoon|evening|day)|as-?salam\w*\s*(?:o|u|-)?\s*alaik\w*|assalam\w*|aoa|salaam\s*walekum|salam|salaam)$/i;

const THANKS =
  /^(thanks+|thank\s*(?:you|u)(?:\s+so\s+much|\s+very\s+much)?|thx|ty|ok|okay|okk+|got\s*it|shukriya|bohot\s+shukriya|bahut\s+shukriya|jazakallah(?:\s+khair)?|theek\s+hai|understood|alright|all\s+good|perfect|cool|great|nice|noted|k|kk|done|thanks\s+a\s+lot|much\s+appreciated|yes|yeah|yep|yup|sure|no|nope|nah|haan|han|ji|jee|nahi|nahin)$/i;

const OTHER_SMALL_TALK =
  /^(how\s+are\s+you(?:\s+doing)?|how\s+r\s+u|how'?s\s+it\s+going|what'?s\s+up|sup|(?:aap|ap|tum|app)?\s*(?:kaise|kese|kaisay|kesay|kaisy|kesy)\s+(?:ho|hain|hen|hai|he)(?:\s+(?:aap|ap|tum|bhai|sir|ji))?|(?:kya|kia|kiya)\s+(?:haal|hal|hall)\s*(?:hai|he|hain|chaal)?|(?:aur\s+)?(?:sunao|sunaen|sunaiye)|sab\s+(?:theek|thik|khair)(?:\s+(?:hai|he))?|who\s+are\s+you|are\s+you\s+(?:a\s+)?(?:bot|robot|human|real|ai)|bye|goodbye|good\s*night|see\s+you|see\s+ya|allah\s+hafiz|khuda\s+hafiz|take\s+care|lol|haha+|hehe+|hmm+|nice\s+to\s+meet\s+you|what'?s\s+your\s+name|what\s+is\s+your\s+name|what\s+can\s+you\s+do|how\s+can\s+you\s+help(?:\s+me)?|can\s+you\s+help(?:\s+me)?|i\s+need\s+(?:some\s+)?help|need\s+help|help\s+me|who\s+(?:made|built|created)\s+you|are\s+you\s+there|is\s+anyone\s+there|anyone\s+there|aap\s+kaun\s+(?:ho|hain)|tum\s+kaun\s+ho|ap\s+kon\s+ho|aap\s+kya\s+kar\s+sakte\s+(?:ho|hain)|(?:mujhe\s+)?(?:madad|help)\s+(?:chahiye|chahye|chaiye)|koi\s+hai)$/i;

/** "bhai", "bro", "ji" after "shukriya" or "thanks" change nothing. */
const TRAILING_ADDRESS = /(?:[\s,]+(?:bhai|bro|brother|sir|ji|jee|dear|yaar|yar|man|buddy|team))+$/i;

/** Leading pleasantries, so "hi, where is my order?" is judged on the question. */
const LEADING_PLEASANTRY =
  /^(?:hi+|hello+|hey+|salam|salaam|assalam\w*(?:\s*(?:o|u)?\s*alaik\w*)?|aoa|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|ok|okay|dear|sir|madam|bhai|team)\b[\s,!.:;-]*/i;

/** A yes to "shall I connect you with a team member?". */
const AFFIRMATIVE =
  /^(?:yes|yeah|yea|yep|yup|sure|ok(?:ay)?|please|pls|plz|y|haan|han|ji|jee|ji\s+haan|haan\s+ji|zaroor|zarur|bilkul|theek\s+hai|go\s+ahead|please\s+do|do\s+it|connect\s+me|yes\s+connect\s+me)(?:[\s,!.]+(?:please|pls|plz|ji|jee|sure|kar\s+do|kardo|karo|karwa\s+do|thanks|thank\s+you))*$/i;

/**
 * Our own offers of a person, in every language we send them in. Kept next to
 * the templates in anthropic.ts that produce them; a test checks each one.
 */
export const HANDOFF_OFFER =
  /connect you with (?:a|our) (?:team member|support team)|team member se connect kar doon|support team ke member se connect|ٹیم کے ممبر سے منسلک کر دوں|سپورٹ ٹیم کے ممبر سے منسلک|أصلك بأحد أعضاء فريق الدعم|comunique con (?:un miembro de )?nuestro equipo|mette en contact avec (?:un membre de )?notre équipe|सहायता टीम के किसी सदस्य से जोड़ दूँ/i;

/** Asking for a person in Roman Urdu or mixed English, which `wantsHuman` does not know. */
const HUMAN_REQUEST_ROMAN_UR =
  /\b(?:(?:kisi\s+)?(?:insaan|insan|banday|bande|banda|agent|representative|staff|admin|support(?:\s+team)?|team|manager)\s+(?:se|say|sy)\s+(?:baat|rabta|contact)|(?:insaan|insan|human|agent|representative|real\s+person)\s+(?:chahiye|chahye|chaiye)|kisi\s+se\s+baat\s+(?:karwa|karwao|karao|krwa|kara)\w*)\b/i;

export function asksForHuman(message: string): boolean {
  return wantsHuman(message) || HUMAN_REQUEST_ROMAN_UR.test(message);
}

const OUT_OF_SCOPE =
  /\b(recipes?|bake|baking|biryani|pizza|cake|cookies?|weather|forecast|mausam|joke|jokes|lateefa|poem|poetry|shayari|song\s+lyrics|lyrics|essay|homework|assignment|calculus|algebra|equation|capital\s+of|president\s+of|prime\s+minister|who\s+won|world\s+cup|cricket\s+score|football\s+score|match\s+score|movie\s+recommendations?|horoscope|zodiac|write\s+(?:me\s+)?(?:an?\s+)?(?:essay|poem|story|song|python|code|script|program|cover\s+letter)|meaning\s+of\s+life|tell\s+me\s+a\s+story)\b/i;
const ARITHMETIC = /^\s*(?:what(?:'s|\s+is)\s+)?\d+(?:\.\d+)?\s*[-+*/x×]\s*\d+(?:\.\d+)?\s*\??\s*$/i;

const COMPLAINT =
  /\b(scam|scammers?|fraud|thie(?:f|ves)|cheat(?:ing|ed)?|terrible|worst|disgusted|unacceptable|ridiculous|angry|furious|disappointed|frustrat(?:ing|ed|ion)|bakwaas|bakwas|chor|dhoka|loot\s+liya|waste\s+of\s+(?:money|time)|very\s+bad|awful|horrible|pathetic|useless|unfair|file\s+a\s+complaint|sue\s+you|legal\s+action|report\s+you|stop\s+giving\s+me\s+bot\s+answers|you\s+are\s+not\s+helping|useless\s+bot|stupid\s+bot|doesn'?t\s+make\s+sense|not\s+helpful|didn'?t\s+help|worst\s+support|fucking|shit|bullshit|idiot)\b/i;

/*
 * Spam needs two separate signals: one alone ("click here", a short link, a
 * price per day) turns up in real customer messages too. Two together ("Earn
 * $5000 daily, click here") are an advert, which gets a template and no model.
 */
const SPAM_SIGNALS = [
  /\b(?:earn|make|win|get)\s+(?:up\s+to\s+)?(?:\$|rs\.?\s?|pkr\s?|usd\s?)?\d[\d,.]*k?\s*(?:\$|usd|dollars?|rs|rupees|pkr)?\s*(?:daily|a\s+day|per\s+day|every\s+day|weekly|a\s+week|per\s+week|monthly|a\s+month|per\s+month)\b/i,
  /\bclick\s+(?:here|on\s+(?:the|this)\s+link|the\s+link|this\s+link|below)\b/i,
  /\b(?:free\s+(?:money|bitcoin|crypto|iphone|gift\s*cards?)|crypto\s+giveaway|double\s+your\s+(?:money|bitcoin|investment)|guaranteed\s+(?:profit|returns|income)|work\s+from\s+home\s+and\s+earn|limited\s+time\s+offer|act\s+now|you(?:'ve|\s+have)\s+won|you\s+have\s+been\s+selected)\b/i,
  /\b(?:bit\.ly|tinyurl\.com|goo\.gl|t\.me)\/\S+/i,
  /\b(?:casino|viagra|forex\s+signals|betting\s+tips|buy\s+followers|seo\s+services|onlyfans)\b/i,
];

export function looksLikeSpam(text: string): boolean {
  return SPAM_SIGNALS.filter((re) => re.test(text)).length >= 2;
}

// "abhi tak" is "not yet", not "right now".
const URGENT =
  /\b(?:urgent(?:ly)?|asap|immediately|right\s+now|right\s+away|today|emergency|abhi(?!\s+tak)|foran|fauran|jaldi|aaj\s+hi)\b/i;

export const NOT_HELPFUL =
  /\b(?:didn'?t\s+help|doesn'?t\s+help|not\s+helpful|did\s+not\s+help|does\s+not\s+help|that\s+didn'?t\s+answer|not\s+what\s+i\s+asked|you\s+already\s+said\s+that|repeated\s+the\s+same|nahi\s+hua|ye\s+nahi\s+pucha|samajh\s+nahi\s+aya)\b/i;

const EMAIL = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
const ACCOUNT_NUMBER =
  /\b(?:account|acct|acc|login|mt4|mt5|user\s*id|customer\s*id)\s*(?:#|no\.?|num(?:ber)?)?\s*[:=]?\s*#?\s*([A-Z0-9-]*\d[A-Z0-9-]{3,})\b/i;
const ORDER_NUMBER =
  /\b(?:order|ord|booking|invoice|tracking|shipment|parcel|transaction|txn|ticket|ref(?:erence)?)\s*(?:#|no\.?|num(?:ber)?|id)?\s*[:=]?\s*#?\s*([A-Z0-9-]*\d[A-Z0-9-]{3,})\b/i;
const BARE_REFERENCE = /(?:^|\s)#\s?([A-Z0-9-]*\d[A-Z0-9-]{3,})\b/i;

/** The visitor talking about themselves. */
const PERSONAL =
  /\b(my|mine|i|i'm|im|i've|ive|i'd|me|mera|meri|mere|mujhe|maine|main\s+ne|hamara|hamari|humara|humari)\b/i;

/** Things a business keeps a record of for each customer. */
const RECORD =
  /\b(orders?|account|acct|payments?|paid|pay|refund(?:ed)?|invoices?|bills?|billing|subscriptions?|plan|deliver(?:y|ed)|parcel|package|shipment|shipping|tracking|payout|withdrawal|withdraw|deposit|balance|charge|charged|card|login|log\s+in|logged|sign\s+in|password|booking|reservation|email|profile|wallet|transaction|purchase|item|items|product|money|paisay|paise)\b/i;

/** Something has gone wrong with that record. */
const PROBLEM =
  /\b(not\s+working|doesn'?t\s+work|didn'?t\s+(?:get|receive|arrive|work|come)|haven'?t\s+(?:received|got|gotten)|never\s+(?:arrived|received|got|came)|not\s+(?:received|arrived|delivered|showing|updating|syncing|loading|refunded|credited)|missing|stuck|pending|delayed|late|failed|declined|rejected|blocked|banned|locked|suspended|hacked|charged\s+twice|double\s+charged|twice|wrong|damaged|broken|error|can'?t|cannot|unable\s+to|still\s+waiting|nahi\s+(?:mila|mili|aya|aaya|ayi|hua|hui|ho\s+raha|chal\s+raha|ho\s+rahi)|nahin\s+(?:mila|aya)|abhi\s+tak|band\s+ho\s+gaya|block\s+ho\s+gaya|kat\s+gaye|cut\s+gaye)\b/i;

/** The visitor wants something done to, or found out about, their record. */
const STATUS_OR_ACTION =
  /\b(where\s+is|where'?s|when\s+will|when\s+do\s+i\s+get|status\s+of|track|cancel|change|update|modify|delete|close|kab\s+(?:milega|milegi|aye\s*ga|ayega|aaye\s*ga|aayega|hoga|hogi|aye\s*gi)|kahan\s+hai|kidhar\s+hai|cancel\s+kar|change\s+kar)\b/i;

/** A general how-to or policy question, even when phrased with "my". */
const HOW_TO =
  /^(?:how\s+(?:do|can|to|does|long|much)|what\s+(?:is|are|'s)|what's|is\s+(?:there|it)|are\s+there|do\s+you|does|can\s+(?:i|we|you)|which|kaise|kese|kya\s+(?:aap|ap|main|mein)|kitna|kitne|kitni)\b/i;

function extractReferences(text: string) {
  const email = text.match(EMAIL)?.[0] ?? null;
  const orderNumber = text.match(ORDER_NUMBER)?.[1] ?? null;
  const accountNumber =
    text.match(ACCOUNT_NUMBER)?.[1] ?? (!orderNumber ? text.match(BARE_REFERENCE)?.[1] ?? null : null);
  return { email, orderNumber, accountNumber };
}

/** Removes trailing punctuation and leading pleasantries ("hi, ", "thanks! "). */
function core(text: string): string {
  let s = text.trim().replace(/[\s!.,?؟]+$/u, '');
  for (let i = 0; i < 3; i++) {
    const stripped = s.replace(LEADING_PLEASANTRY, '').trim();
    if (stripped === s) break;
    s = stripped.replace(/[\s!.,?؟]+$/u, '');
  }
  return s;
}

const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji}\s\p{P}]+$/u;

function smallTalkKindOf(text: string): SmallTalkKind | null {
  const whole = text.trim().replace(/[\s!.,?؟]+$/u, '').replace(TRAILING_ADDRESS, '');
  if (!whole) return 'greeting';

  // Pure emoji messages require zero model tokens
  if (EMOJI_ONLY.test(whole) && !/[\p{L}\p{N}]/u.test(whole)) {
    if (/[👍🙏🤝👌✅🙌]/u.test(whole)) return 'thanks';
    if (/[👋😊🙂❤️😀🎉]/u.test(whole)) return 'greeting';
    return 'greeting';
  }

  if (GREETING.test(whole)) return 'greeting';
  if (THANKS.test(whole)) return 'thanks';
  if (OTHER_SMALL_TALK.test(whole)) return 'other';
  const rest = core(whole);
  if (!rest) return /^(thanks|thank|ok)/i.test(whole) ? 'thanks' : 'greeting';
  if (OTHER_SMALL_TALK.test(rest)) return 'other';
  if (GREETING.test(rest)) return 'greeting';
  if (THANKS.test(rest)) return 'thanks';
  return null;
}

function lastAssistantMessage(recent: { role: string; content: string }[]): string | null {
  for (let i = recent.length - 1; i >= 0; i--) {
    if (recent[i].role === 'assistant') return recent[i].content;
  }
  return null;
}

/** Fed up with the bot itself: a person is what they want, whatever the mode. */
export const BOT_FRUSTRATION =
  /\b(?:stop\s+giving\s+me\s+bot\s+answers|you\s+are\s+not\s+helping|useless\s+bot|stupid\s+bot|dumb\s+bot|doesn'?t\s+make\s+sense|not\s+helpful|didn'?t\s+help|stop\s+repeating|already\s+told\s+you|hate\s+this\s+bot|worst\s+bot)\b/i;

/**
 * The reason on a `wants_human` verdict that came from anger alone, not from
 * asking for a person. Agent mode answers these (with an apology) instead of
 * handing over, unless BOT_FRUSTRATION also matches.
 */
export const FRUSTRATION_REASON = 'Customer showed frustration or anger. Handing over to human.';

export interface RuleVerdict extends IntentClassificationResult {
  /** True when no model could reasonably disagree. */
  certain: boolean;
}

/**
 * Deterministic classification. Order matters: each step only runs when the
 * ones before it found nothing, and the most specific signals come first.
 */
export function classifyByRules(
  message: string,
  recentMessages: { role: string; content: string }[] = []
): RuleVerdict {
  const text = (message || '').trim();
  const refs = extractReferences(text);
  const isComplaint = COMPLAINT.test(text);
  const base = { source: 'rules' as const, isComplaint, isUrgent: URGENT.test(text), ...refs };

  if (looksLikeSpam(text)) {
    return { ...base, intent: 'out_of_scope', isSpam: true, confidence: 0.95, certain: true, reason: 'Looks like spam or an advert' };
  }

  // "yes" to our own offer of a person is a request for one, not small talk.
  const previous = lastAssistantMessage(recentMessages);
  if (previous && HANDOFF_OFFER.test(previous) && AFFIRMATIVE.test(text.replace(/[\s!.,?]+$/, ''))) {
    return { ...base, intent: 'wants_human', confidence: 0.97, certain: true, reason: 'Accepted the offer to talk to a team member' };
  }

  // Before the human check: "are you a human?" is a question about the bot.
  const kind = smallTalkKindOf(text);
  if (kind) {
    return { ...base, intent: 'small_talk', smallTalkKind: kind, confidence: 0.97, certain: true, reason: `Small talk (${kind})` };
  }

  if (asksForHuman(text)) {
    return { ...base, intent: 'wants_human', confidence: 0.96, certain: true, reason: 'Asked to talk to a person' };
  }

  const body = core(text);
  const hasReference = Boolean(refs.orderNumber || refs.accountNumber);
  const personal = PERSONAL.test(body);
  const record = RECORD.test(body);
  const problem = PROBLEM.test(body);
  const statusOrAction = STATUS_OR_ACTION.test(body);
  const howTo = HOW_TO.test(body);

  if (hasReference && (record || problem || statusOrAction || isComplaint)) {
    return {
      ...base,
      intent: 'account_specific',
      confidence: 0.95,
      certain: true,
      reason: `About their own ${refs.orderNumber ? 'order' : 'account'} (${refs.orderNumber || refs.accountNumber})`,
    };
  }
  if (personal && record && (problem || (statusOrAction && !howTo))) {
    return { ...base, intent: 'account_specific', confidence: 0.85, certain: false, reason: 'About their own order, account or payment' };
  }

  if (OUT_OF_SCOPE.test(body) || ARITHMETIC.test(body)) {
    return { ...base, intent: 'out_of_scope', confidence: 0.85, certain: false, reason: 'Unrelated to this business' };
  }

  if (BOT_FRUSTRATION.test(text) || (isComplaint && !howTo && !/\?/.test(text))) {
    return { ...base, intent: 'wants_human', confidence: 0.95, certain: true, reason: FRUSTRATION_REASON };
  }

  return { ...base, intent: 'help_center_question', confidence: 0.7, certain: false, reason: 'General question for the help center' };
}

/** Kept for callers that want the rules alone. */
export function classifyVisitorIntentFast(text: string): IntentClassificationResult {
  return classifyByRules(text);
}

/* ── Model ────────────────────────────────────────────────────────────── */

function classifierPrompt(workspaceName: string, topics: string[]): string {
  return [
    `You route customer messages for the support chat of "${workspaceName}".`,
    topics.length
      ? `Its help center covers: ${topics.slice(0, 25).join('; ')}.`
      : 'Its help center topics are unknown; assume it covers the products, services, policies, pricing and how-to questions of this business.',
    '',
    'Classify the LATEST customer message into exactly one intent:',
    `- help_center_question: a general question a ${workspaceName} help article could answer (products, pricing, policies, shipping, refunds rules, how-to, features, hours), even if the help center turns out not to cover it.`,
    "- account_specific: about the customer's OWN order, account, payment, booking, delivery or subscription (status, a problem with it, or asking to change/cancel it). Needs someone who can look up their records.",
    '- small_talk: greetings, thanks, acknowledgements, "how are you", goodbyes, questions about the bot itself.',
    `- out_of_scope: a general or universal question not about ${workspaceName} itself (general knowledge, definitions, maths, advice, recipes, weather, homework, trivia, writing poems or code, other companies).`,
    '- wants_human: asks for a person/agent/representative, accepts an offer to be connected, or is complaining angrily with no question to answer.',
    '',
    'Messages may be English, Roman Urdu, or a mix; judge the meaning, not the language. A greeting followed by a question is the question.',
    '',
    'Reply with JSON only:',
    '{"intent": "...", "confidence": 0.0-1.0, "summary": "one short English line describing what the customer wants"}',
  ].join('\n');
}

/**
 * Classifies a visitor message. Rules answer when they are certain; otherwise
 * a configured model decides with the workspace's topics in view. Any model
 * failure falls back to the rules' verdict.
 *
 * With Jev (src/lib/ai/jev.ts) in 'live' mode, a confident Jev decides first
 * and the model is not asked; below the confidence bar, or on any Jev
 * failure, the usual path runs. In 'shadow' mode Jev runs beside the model and
 * its verdict only rides along in `jev` for the log. Jev's call is shorter
 * than the model's, so shadow mode adds no waiting.
 */
export async function classifyVisitorIntent({
  message,
  recentMessages = [],
  providerConfig,
  workspaceName = 'our platform',
  topics = [],
  jev = null,
}: {
  message: string;
  recentMessages?: { role: string; content: string }[];
  providerConfig?: ProviderConfig | null;
  workspaceName?: string;
  /** Section names and article titles, so scope means this business. */
  topics?: string[];
  jev?: JevRuntime | null;
}): Promise<IntentClassificationResult> {
  const rules = classifyByRules(message, recentMessages);
  const { certain, ...ruleResult } = rules;
  if (certain) return ruleResult;

  const jevOn = Boolean(jev && jev.settings.intent);
  const jevCall = jevOn
    ? jevIntent(jev!, { message, recent: recentMessages, workspaceName, topics }).then(
        (verdict) => ({ verdict, error: undefined as string | undefined }),
        (err: unknown) => ({ verdict: null, error: String((err as Error)?.message || err).slice(0, 200) })
      )
    : null;
  const record = (got: { verdict: JevIntentVerdict | null; error?: string }, used: boolean): JevIntentRecord => {
    const verdict = got.verdict ? (({ model: _model, ...rest }) => rest)(got.verdict) : null;
    return got.error ? { verdict, used, error: got.error } : { verdict, used };
  };

  if (jevOn && jev!.settings.mode === 'live') {
    const got = await jevCall!;
    const v = got.verdict;
    // The yes/no answers count on their own bar, whoever picks the intent.
    // Very upset reads as a complaint, which hands over at once.
    const flags = (r: IntentClassificationResult) => ({
      isComplaint: Boolean(r.isComplaint) || (v ? v.veryUpset >= JEV_THRESHOLDS.veryUpset : false),
      isUrgent: Boolean(r.isUrgent) || (v ? v.urgent >= JEV_THRESHOLDS.urgent : false),
    });
    if (v && v.spam >= JEV_THRESHOLDS.spam) {
      return {
        ...ruleResult,
        intent: 'out_of_scope',
        source: 'jev',
        confidence: v.spam,
        reason: 'Jev: spam or an advert',
        isSpam: true,
        summary: null,
        jev: record(got, true),
      };
    }
    if (v && v.wantsHuman >= JEV_THRESHOLDS.wantsHuman) {
      return {
        ...ruleResult,
        ...flags(ruleResult),
        intent: 'wants_human',
        source: 'jev',
        confidence: v.wantsHuman,
        reason: 'Jev: asks for a person',
        smallTalkKind: undefined,
        summary: null,
        jev: record(got, true),
      };
    }
    if (v && VISITOR_INTENTS.includes(v.intent) && v.confidence >= jev!.settings.minConfidence) {
      return {
        ...ruleResult,
        ...flags(ruleResult),
        intent: v.intent,
        source: 'jev',
        confidence: v.confidence,
        reason: v.intent === ruleResult.intent ? ruleResult.reason : `Jev: ${v.intent.replace(/_/g, ' ')}`,
        smallTalkKind: v.intent === 'small_talk' ? ruleResult.smallTalkKind ?? 'other' : undefined,
        summary: null,
        jev: record(got, true),
      };
    }
    // Not confident enough (or failed): the usual path decides, Jev's verdict is logged.
    const fallback = await classifyWithModel();
    return { ...fallback, ...flags(fallback), jev: record(got, false) };
  }

  const decided = await classifyWithModel();
  return jevCall ? { ...decided, jev: record(await jevCall, false) } : decided;

  function classifyWithModel(): Promise<IntentClassificationResult> {
    return classifyWithProvider({ message, recentMessages, providerConfig, workspaceName, topics }, ruleResult);
  }
}

/** The generative model's verdict; the rules' verdict on no model or any failure. */
async function classifyWithProvider(
  {
    message,
    recentMessages,
    providerConfig,
    workspaceName,
    topics,
  }: {
    message: string;
    recentMessages: { role: string; content: string }[];
    providerConfig?: ProviderConfig | null;
    workspaceName: string;
    topics: string[];
  },
  ruleResult: IntentClassificationResult
): Promise<IntentClassificationResult> {
  if (!isConfigured(providerConfig)) return ruleResult;
  try {
    const history = recentMessages
      .slice(-5, -1)
      .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content}`)
      .join('\n');
    const res = await chat(providerConfig!, {
      system: classifierPrompt(workspaceName, topics),
      messages: [
        {
          role: 'user',
          content: history
            ? `Earlier in the conversation:\n${history}\n\nLatest customer message: ${message.trim()}`
            : `Latest customer message: ${message.trim()}`,
        },
      ],
      maxTokens: 160,
      temperature: 0,
      reasoning: 'fast',
      timeoutMs: 6000,
    });

    const text = res.text || '';
    const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (!VISITOR_INTENTS.includes(parsed.intent)) return ruleResult;

    const intent = parsed.intent as VisitorIntent;
    return {
      ...ruleResult,
      intent,
      source: 'model',
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.8,
      reason:
        intent === ruleResult.intent
          ? ruleResult.reason
          : `Model: ${String(parsed.summary || intent).slice(0, 120)}`,
      smallTalkKind: intent === 'small_talk' ? ruleResult.smallTalkKind ?? 'other' : undefined,
      summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : null,
    };
  } catch (err) {
    console.warn('[Intent] Model classification failed, using rules:', (err as Error)?.message);
    return ruleResult;
  }
}

/* ── Replies that need no retrieval ───────────────────────────────────── */

/**
 * Formats a localized expected reply time message for handovers.
 */
export function getExpectedReplyTimeNotice(lang: ReplyLanguage): string {
  return localized(lang, {
    en: 'A team member will reply right here, usually within 10–15 minutes.',
    roman_ur: 'Hamari team aam tor par 10 se 15 minute mein yahin reply karegi.',
    ur: 'ہماری ٹیم عام طور پر 10 سے 15 منٹ میں یہیں جواب دے گی۔',
    hi: 'हमारी टीम आमतौर पर 10 से 15 मिनट में यहीं जवाब देगी।',
    ar: 'سيرد عليك أحد أعضاء الفريق هنا، عادة خلال 10 إلى 15 دقيقة.',
    es: 'Un miembro del equipo te responderá aquí, normalmente en 10-15 minutos.',
    fr: "Un membre de l'équipe vous répondra ici, généralement sous 10 à 15 minutes.",
  });
}

const HOW_ARE_YOU =
  /\b(?:how\s+are\s+you|how\s+r\s+u|how'?s\s+it\s+going|kaise|kese|kaisay|kesay|kaisy|kesy|(?:kya|kia|kiya)\s+(?:haal|hal|hall)|sunao|sab\s+(?:theek|thik|khair))\b/i;
const GOODBYE = /\b(?:bye|goodbye|good\s*night|see\s+(?:you|ya)|allah\s+hafiz|khuda\s+hafiz|take\s+care)\b/i;

export function smallTalkReply(
  kind: SmallTalkKind,
  lang: ReplyLanguage,
  brand: string,
  name?: string | null,
  cannedSettings?: { cannedGreeting?: string | null; greetingMessage?: string | null; cannedThanks?: string | null } | null,
  /** The visitor's words, so "how are you" and "bye" get their own answers. */
  message?: string
): string {
  const n = name ? ` ${name}` : '';
  if (kind === 'thanks') {
    if (cannedSettings?.cannedThanks?.trim()) {
      return cannedSettings.cannedThanks.trim();
    }
    return localized(lang, {
      en: "You're welcome! Anything else I can help with?",
      roman_ur: 'Koi baat nahi! Aur kisi cheez mein madad chahiye?',
      ur: 'کوئی بات نہیں! کسی اور چیز میں مدد چاہیے؟',
      hi: 'आपका स्वागत है! क्या मैं और कुछ मदद कर सकता हूँ?',
      ar: 'على الرحب والسعة! هل هناك شيء آخر يمكنني مساعدتك به؟',
      es: '¡De nada! ¿Puedo ayudarte con algo más?',
      fr: 'Avec plaisir ! Puis-je vous aider pour autre chose ?',
    });
  }
  if (kind === 'other' && message && HOW_ARE_YOU.test(message)) {
    return localized(lang, {
      en: `I'm doing well, thanks for asking! How can I help you with ${brand} today?`,
      roman_ur: `Main theek hoon, poochne ka shukriya! ${brand} ke baare mein aapki kya madad kar sakta hoon?`,
      ur: `میں ٹھیک ہوں، پوچھنے کا شکریہ! ${brand} کے بارے میں آپ کی کیا مدد کر سکتا ہوں؟`,
      hi: `मैं ठीक हूँ, पूछने के लिए धन्यवाद! ${brand} के बारे में मैं आपकी क्या मदद कर सकता हूँ?`,
      ar: `أنا بخير، شكراً لسؤالك! كيف يمكنني مساعدتك بخصوص ${brand}؟`,
      es: `¡Muy bien, gracias por preguntar! ¿En qué te puedo ayudar con ${brand}?`,
      fr: `Je vais bien, merci ! Comment puis-je vous aider avec ${brand} ?`,
    });
  }
  if (kind === 'other' && message && GOODBYE.test(message)) {
    return localized(lang, {
      en: 'Goodbye! Feel free to message us any time.',
      roman_ur: 'Allah Hafiz! Jab bhi zaroorat ho, message kar dijiye ga.',
      ur: 'اللہ حافظ! جب بھی ضرورت ہو، پیغام بھیج دیجیے گا۔',
      hi: 'अलविदा! जब भी ज़रूरत हो, संदेश भेज दीजिए।',
      ar: 'مع السلامة! راسلنا في أي وقت.',
      es: '¡Hasta luego! Escríbenos cuando quieras.',
      fr: "Au revoir ! N'hésitez pas à nous écrire.",
    });
  }
  if (kind === 'other') {
    return localized(lang, {
      en: `I'm the ${brand} assistant, here to help with questions about ${brand}. What can I help you with?`,
      roman_ur: `Main ${brand} ka assistant hoon. ${brand} ke baare mein aapki kya madad kar sakta hoon?`,
      ur: `میں ${brand} کا اسسٹنٹ ہوں۔ ${brand} کے بارے میں آپ کی کیا مدد کر سکتا ہوں؟`,
      ar: `أنا مساعد ${brand}. كيف يمكنني مساعدتك بخصوص ${brand}؟`,
      es: `Soy el asistente de ${brand}. ¿En qué te puedo ayudar?`,
      fr: `Je suis l'assistant de ${brand}. Comment puis-je vous aider ?`,
    });
  }
  if (cannedSettings?.cannedGreeting?.trim()) {
    return cannedSettings.cannedGreeting.trim();
  }
  if (cannedSettings?.greetingMessage?.trim()) {
    return cannedSettings.greetingMessage.trim();
  }
  return localized(lang, {
    en: `Hello${n}! Welcome to ${brand}. How can I help you today?`,
    roman_ur: `Salam${n}! ${brand} mein khushamdeed. Main aaj aap ki kya madad kar sakta hoon?`,
    ur: `السلام علیکم${n}! ${brand} میں خوش آمدید۔ میں آج آپ کی کیا مدد کر سکتا ہوں؟`,
    hi: `नमस्ते${n}! ${brand} में आपका स्वागत है। मैं आज आपकी क्या मदद कर सकता हूँ?`,
    ar: `مرحباً${n}! أهلاً بك في ${brand}. كيف يمكنني مساعدتك اليوم؟`,
    es: `¡Hola${n}! Bienvenido a ${brand}. ¿En qué te puedo ayudar hoy?`,
    fr: `Bonjour${n} ! Bienvenue chez ${brand}. Comment puis-je vous aider ?`,
  });
}

export function wantsHumanReply(lang: ReplyLanguage, alreadyWithHuman: boolean): string {
  if (alreadyWithHuman) {
    return localized(lang, {
      en: "I've let the team member on this conversation know you're waiting. They'll reply here.",
      roman_ur: 'Maine is conversation par maujood team member ko bata diya hai. Woh yahin reply karenge.',
      ur: 'میں نے اس گفتگو پر موجود ٹیم ممبر کو بتا دیا ہے۔ وہ یہیں جواب دیں گے۔',
    });
  }
  const notice = getExpectedReplyTimeNotice(lang);
  return localized(lang, {
    en: `I've passed this conversation to our support team. ${notice}`,
    roman_ur: `Maine aapki conversation hamari support team ko de di hai. ${notice}`,
    ur: `میں نے آپ کی گفتگو ہماری سپورٹ ٹیم کو منتقل کر دی ہے۔ ${notice}`,
    hi: `मैंने आपकी बातचीत हमारी सहायता टीम को सौंप दी है। ${notice}`,
    ar: `لقد حوّلت محادثتك إلى فريق الدعم. ${notice}`,
    es: `He pasado tu conversación a nuestro equipo de soporte. ${notice}`,
    fr: `J'ai transmis votre conversation à notre équipe d'assistance. ${notice}`,
  });
}

export function outOfScopeReply(lang: ReplyLanguage, brand: string): string {
  return localized(lang, {
    en: `I can only help with questions about ${brand}, so I've passed your message to our team in case they can help.`,
    roman_ur: `Main sirf ${brand} ke sawalaat mein madad kar sakta hoon, is liye maine aapka message hamari team ko bhej diya hai.`,
    ur: `میں صرف ${brand} کے سوالات میں مدد کر سکتا ہوں، اس لیے میں نے آپ کا پیغام ہماری ٹیم کو بھیج دیا ہے۔`,
    ar: `يمكنني المساعدة فقط في الأسئلة المتعلقة بـ ${brand}، لذا أرسلت رسالتك إلى فريقنا.`,
    es: `Solo puedo ayudar con preguntas sobre ${brand}, así que pasé tu mensaje a nuestro equipo.`,
    fr: `Je ne peux répondre qu'aux questions sur ${brand}, j'ai donc transmis votre message à notre équipe.`,
  });
}

/**
 * The help centre has nothing that fits, so the question has gone to a person.
 * Visitors read the earlier "shall I connect you?" offer as the bot giving up
 * and left without saying yes; the team now gets the question straight away
 * and the bot stays on for the next one.
 */
export function noAnswerHandoverReply(lang: ReplyLanguage): string {
  const notice = getExpectedReplyTimeNotice(lang);
  return localized(lang, {
    en: `I couldn't find the exact answer to this, and I'd rather not guess, so I've passed your question to our team. ${notice}`,
    roman_ur: `Mujhe is ka sahi jawab nahi mila aur main andaza nahi lagana chahta, is liye maine aapka sawal hamari team ko bhej diya hai. ${notice}`,
    ur: `مجھے اس کا درست جواب نہیں ملا اور میں اندازہ نہیں لگانا چاہتا، اس لیے میں نے آپ کا سوال ہماری ٹیم کو بھیج دیا ہے۔ ${notice}`,
    hi: `मुझे इसका सही जवाब नहीं मिला और मैं अनुमान नहीं लगाना चाहता, इसलिए मैंने आपका सवाल हमारी टीम को भेज दिया है। ${notice}`,
    ar: `لم أجد إجابة دقيقة لهذا ولا أريد التخمين، لذا أرسلت سؤالك إلى فريقنا. ${notice}`,
    es: `No encontré la respuesta exacta y prefiero no adivinar, así que pasé tu pregunta a nuestro equipo. ${notice}`,
    fr: `Je n'ai pas trouvé la réponse exacte et je préfère ne pas deviner, j'ai donc transmis votre question à notre équipe. ${notice}`,
  });
}

/* ── Carrying on after a person ───────────────────────────────────────── */

/** "Any update?", "still waiting", "koi update?". */
export const UPDATE_REQUEST =
  /(?:^\s*(?:update|updates|status)\s*\??\s*$)|\b(?:any\s+(?:update|updates|news|progress)|what'?s\s+the\s+(?:status|update)|status\s+update|still\s+waiting|update\s+(?:please|pls|plz)|is\s+it\s+(?:done|fixed|sorted)\s+yet|koi\s+(?:update|khabar|jawab)|kya\s+bana|kuch\s+hua|abhi\s+tak\s+kuch)\b/i;

/** A person told the visitor they would come back to them. */
export const PROMISED_FOLLOW_UP =
  /\b(?:i'?ll|i\s+will|we'?ll|we\s+will)\s+(?:update|get\s+back|let\s+you\s+know|follow\s+up|check|look\s+into|keep\s+you\s+posted|inform|confirm)|\b(?:forwarded|escalated|raised\s+(?:it|this|a\s+ticket)|passed\s+(?:it|this|your\s+\w+)\s+(?:on|to)|checking\s+with|looking\s+into|investigating|get\s+back\s+to\s+you|update\s+you|keep\s+you\s+posted|waiting\s+(?:on|for)\s+(?:the|our)\s+\w+\s+team)\b|\b(?:update\s+kar(?:en|oon|unga|ungi|enge)|bata\s+(?:denge|doon|dunga|dungi)|check\s+kar\s+(?:ke|rahe|raha|rahi))\b/i;

/**
 * The visitor asks for news on something a person promised to come back
 * about. The bot cannot know whether the news has come, so it must not say it
 * has: it says there is none yet and makes sure the team sees the question.
 */
export function pendingUpdateReply(lang: ReplyLanguage): string {
  return localized(lang, {
    en: "I don't have a new update on this yet. Our team is still on it, and I've let them know you're waiting. They'll update you here as soon as they have news.",
    roman_ur: 'Abhi tak is par koi naya update nahi aaya. Hamari team is par kaam kar rahi hai, aur maine unhein bata diya hai ke aap intezar kar rahe hain. Jaise hi koi khabar hogi, woh yahin update karenge.',
    ur: 'ابھی تک اس پر کوئی نئی اپڈیٹ نہیں آئی۔ ہماری ٹیم اس پر کام کر رہی ہے، اور میں نے انہیں بتا دیا ہے کہ آپ انتظار کر رہے ہیں۔ جیسے ہی کوئی خبر ہوگی، وہ یہیں اپڈیٹ کریں گے۔',
    hi: 'अभी तक इस पर कोई नया अपडेट नहीं आया है। हमारी टीम इस पर काम कर रही है, और मैंने उन्हें बता दिया है कि आप इंतज़ार कर रहे हैं। जैसे ही कोई खबर होगी, वे यहीं अपडेट करेंगे।',
    ar: 'لا يوجد تحديث جديد بعد. فريقنا لا يزال يعمل على ذلك، وقد أخبرتهم أنك تنتظر. سيحدّثونك هنا فور توفر أي جديد.',
    es: 'Todavía no hay novedades. Nuestro equipo sigue trabajando en ello y les he avisado de que estás esperando. Te escribirán aquí en cuanto sepan algo.',
    fr: "Il n'y a pas encore de nouvelle mise à jour. Notre équipe s'en occupe toujours et je les ai prévenus que vous attendez. Ils vous répondront ici dès qu'ils auront du nouveau.",
  });
}

/** A greeting in a conversation that is already going: no second welcome. */
export function welcomeBackReply(lang: ReplyLanguage): string {
  return localized(lang, {
    en: 'Hi again! What else can I help you with?',
    roman_ur: 'Salam dobara! Aur kis cheez mein madad kar sakta hoon?',
    ur: 'دوبارہ خوش آمدید! میں اور کس چیز میں مدد کر سکتا ہوں؟',
    hi: 'फिर से नमस्ते! मैं और किस चीज़ में मदद कर सकता हूँ?',
    ar: 'مرحباً مجدداً! بماذا يمكنني مساعدتك أيضاً؟',
    es: '¡Hola de nuevo! ¿En qué más te puedo ayudar?',
    fr: 'Re-bonjour ! En quoi puis-je encore vous aider ?',
  });
}

/** "Are you open?", "what are your timings", "auqat kya hain". */
export const BUSINESS_HOURS_QUESTION =
  /\b(?:(?:opening|business|working|office|support)\s+(?:hours|timings?|times?)|are\s+you\s+(?:open|available|online)(?:\s+(?:now|today|right\s+now))?|when\s+(?:do|are|does)\s+(?:you|your\s+team|the\s+team)\s+(?:open|close|available|online)|what\s+(?:are\s+)?(?:your\s+)?(?:timings?|hours)|timings?\s+(?:kya|kia)|auqat|kab\s+(?:khulte|khulta|band\s+hot[ae]|available)|team\s+kab\s+(?:online|available))\b/i;

/** Answers an opening-hours question from the workspace's own calendar. */
export function businessHoursReply(lang: ReplyLanguage, status: { isOpen: boolean; scheduleSummary: string }): string {
  if (status.isOpen) {
    return localized(lang, {
      en: `Yes, our team is available right now. Our hours are ${status.scheduleSummary}.`,
      roman_ur: `Ji haan, hamari team abhi available hai. Hamare auqat ${status.scheduleSummary} hain.`,
      ur: `جی ہاں، ہماری ٹیم ابھی دستیاب ہے۔ ہمارے اوقات ${status.scheduleSummary} ہیں۔`,
      hi: `जी हाँ, हमारी टीम अभी उपलब्ध है। हमारा समय ${status.scheduleSummary} है।`,
      ar: `نعم، فريقنا متاح الآن. ساعات العمل لدينا: ${status.scheduleSummary}.`,
      es: `Sí, nuestro equipo está disponible ahora. Nuestro horario es ${status.scheduleSummary}.`,
      fr: `Oui, notre équipe est disponible en ce moment. Nos horaires : ${status.scheduleSummary}.`,
    });
  }
  return localized(lang, {
    en: `Our team is away right now. Our hours are ${status.scheduleSummary}. You can still leave your question here and we'll reply when we're back.`,
    roman_ur: `Hamari team is waqt offline hai. Hamare auqat ${status.scheduleSummary} hain. Aap apna sawal yahin chhor dein, hum wapis aa kar jawab denge.`,
    ur: `ہماری ٹیم اس وقت دستیاب نہیں ہے۔ ہمارے اوقات ${status.scheduleSummary} ہیں۔ آپ اپنا سوال یہیں چھوڑ دیں، ہم واپس آ کر جواب دیں گے۔`,
    hi: `हमारी टीम अभी उपलब्ध नहीं है। हमारा समय ${status.scheduleSummary} है। आप अपना सवाल यहीं छोड़ दें, हम वापस आकर जवाब देंगे।`,
    ar: `فريقنا غير متاح الآن. ساعات العمل لدينا: ${status.scheduleSummary}. يمكنك ترك سؤالك هنا وسنرد عند عودتنا.`,
    es: `Nuestro equipo no está disponible ahora. Nuestro horario es ${status.scheduleSummary}. Deja tu pregunta aquí y te responderemos al volver.`,
    fr: `Notre équipe est absente pour le moment. Nos horaires : ${status.scheduleSummary}. Laissez votre question ici, nous vous répondrons à notre retour.`,
  });
}

export function accountSpecificReply(lang: ReplyLanguage, intent: IntentClassificationResult): string {
  const notice = getExpectedReplyTimeNotice(lang);
  const ref = intent.orderNumber || intent.accountNumber;
  const apology = intent.isComplaint ? complaintApology(lang) + ' ' : '';
  if (ref && intent.email) {
    return (
      apology +
      localized(lang, {
        en: `Thanks, I've noted #${ref} for our team to check. ${notice}`,
        roman_ur: `Shukriya, maine #${ref} team ke liye note kar liya hai. ${notice}`,
        ur: `شکریہ، میں نے #${ref} ٹیم کے لیے درج کر لیا ہے۔ ${notice}`,
      })
    );
  }
  const missing = [
    !ref ? localized(lang, { en: 'order or account number', roman_ur: 'order ya account number', ur: 'آرڈر یا اکاؤنٹ نمبر' }) : null,
    !intent.email ? localized(lang, { en: 'email address', roman_ur: 'email', ur: 'ای میل' }) : null,
  ]
    .filter(Boolean)
    .join(localized(lang, { en: ' and ', roman_ur: ' aur ', ur: ' اور ' }));
  return (
    apology +
    localized(lang, {
      en: `I can't see your account details, so I've passed this to our team. To speed things up, please share your ${missing}. ${notice}`,
      roman_ur: `Main aapke account ki details nahi dekh sakta, is liye maine yeh team ko de diya hai. Jaldi madad ke liye apna ${missing} share kar dein. ${notice}`,
      ur: `میں آپ کے اکاؤنٹ کی تفصیلات نہیں دیکھ سکتا، اس لیے یہ ٹیم کو بھیج دیا ہے۔ براہ کرم اپنا ${missing} بتا دیں۔ ${notice}`,
    })
  );
}

export function complaintApology(lang: ReplyLanguage): string {
  return localized(lang, {
    en: "I'm sorry for the trouble.",
    roman_ur: 'Is pareshani ke liye hum maazrat khwah hain.',
    ur: 'اس پریشانی کے لیے ہم معذرت خواہ ہیں۔',
    ar: 'نعتذر عن هذا الإزعاج.',
    es: 'Lamentamos las molestias.',
    fr: 'Nous sommes désolés pour ce désagrément.',
  });
}

/* ── Handover summary ─────────────────────────────────────────────────── */

const INTENT_LABEL: Record<VisitorIntent, string> = {
  help_center_question: 'Help-center question',
  account_specific: 'Account / order issue',
  small_talk: 'Small talk',
  out_of_scope: 'Out of scope',
  wants_human: 'Asked for a human',
};

/**
 * The internal note an agent reads when the bot hands over. Deterministic, so
 * it costs no model call and is the same every time for the same input: what
 * kind of request, why the bot stopped, what the visitor said, and anything
 * they already gave us.
 */
export function buildHandoverSummary({
  intent,
  message,
  recentMessages = [],
  lang,
}: {
  intent: IntentClassificationResult;
  message: string;
  recentMessages?: { role: string; content: string }[];
  lang: ReplyLanguage;
}): string {
  const clip = (s: string, n: number) => {
    const one = s.replace(/\s+/g, ' ').trim();
    return one.length > n ? `${one.slice(0, n - 1)}…` : one;
  };
  const earlier = recentMessages
    .filter((m) => m.role === 'user' && m.content.trim() && m.content.trim() !== message.trim())
    .slice(-2)
    .map((m) => `"${clip(m.content, 120)}"`);

  const lines = [
    `🤖 Bot handover: ${INTENT_LABEL[intent.intent]}`,
    `Why: ${intent.reason}`,
    `Visitor said: "${clip(message, 240)}"`,
  ];
  if (intent.summary) lines.push(`Summary: ${clip(intent.summary, 200)}`);
  if (earlier.length) lines.push(`Earlier: ${earlier.join(' / ')}`);
  const refs = [
    intent.orderNumber ? `order ${intent.orderNumber}` : null,
    intent.accountNumber ? `account ${intent.accountNumber}` : null,
    intent.email ? `email ${intent.email}` : null,
  ].filter(Boolean);
  if (refs.length) lines.push(`Given: ${refs.join(', ')}`);
  if (intent.isComplaint) lines.push('Tone: frustrated / complaint');
  if (lang !== 'en') lines.push(`Language: ${LANGUAGE_LABEL[lang]}`);
  return lines.join('\n');
}
