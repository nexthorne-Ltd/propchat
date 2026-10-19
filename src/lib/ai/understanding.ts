/**
 * Reading a trader's message the way a support agent would, before any
 * search or model call.
 *
 * Customers almost never write the way the FAQ does. They type fast, skip
 * words, misspell ("pyout", "drwadown", "chalange"), mix Urdu, Roman Urdu and
 * English, use shorthand ("dd", "acc", "p1") and often vent before the point
 * ("bhai kya bakwas hai, 3 din se payout nahi aaya"). Embeddings and the
 * model rewrite handle much of that, but not all of it, and not when there is
 * no model or the rewrite is skipped. So every message is first normalised
 * here, with rules only:
 *
 *   - repeated letters collapsed ("plzzz", "kyaaa"), emoji and noise removed;
 *   - shorthand, misspellings and Roman Urdu words mapped to the help centre's
 *     own English terms (TERM_MAP, PHRASE_MAP);
 *   - remaining near-misses corrected against the prop-firm vocabulary
 *     (DOMAIN_TERMS, one or two edits, same first letter, long words only, so
 *     "rest" never becomes "reset");
 *   - the venting, greetings and filler taken out, leaving the request (`core`);
 *   - mood (frustrated, urgent) and the separate questions in it noted.
 *
 * The output feeds keyword search, the multi-query retrieval
 * (semantic-retrieval.ts), the sub-agent router and the agent prompt. It never
 * replaces the visitor's own words, which are always searched as well.
 * No server imports: the settings router tester runs it too.
 */

/** Whole phrases first: they change meaning as a unit. Shorthand and prop-firm terms. */
const PHRASE_MAP: [RegExp, string][] = [
  [/\bd\.?\s?d\b/g, 'drawdown'],
  [/\bdraw\s+down\b/g, 'drawdown'],
  [/\bpay\s+out\b/g, 'payout'],
  [/\bph(?:ase)?\s*-?\s*1\b|\bp1\b|\bstep\s*-?\s*1\b/g, 'phase 1'],
  [/\bph(?:ase)?\s*-?\s*2\b|\bp2\b|\bstep\s*-?\s*2\b/g, 'phase 2'],
  [/\bmt\s*-?\s*([45])\b/g, 'mt$1'],
  [/\bc\s*-?\s*trader\b/g, 'ctrader'],
  [/\bpromo\s*code\b/g, 'promo code'],
  [/\bprofit\s+tgt\b|\bprofit\s+trgt\b/g, 'profit target'],
  [/\bstop\s*loss\b|\bsl\b/g, 'stop loss'],
  [/\btake\s*profit\b|\btp\b/g, 'take profit'],
  [/\bud\s+gaya\b|\burr?\s+gaya\b|\buda\s+diya\b|\bblow\s*n?\b/g, 'breached'],
  [/\bbreach\s+ho\s+gaya\b|\bfail\s+ho\s+gaya\b/g, 'breached'],
  [/\bcharge\s+twice\b|\bdouble\s+charge\w*\b/g, 'charged twice'],
  [/\blog\s*in\b/g, 'login'],
];

/** Roman Urdu phrases, put into English. */
const LANGUAGE_PHRASES: [RegExp, string][] = [
  [/\babhi\s+tak\b|\bab\s+tak\b/g, 'still'],
  [/\bkitne\s+din\b|\bkitne\s+dino\b/g, 'how many days'],
  [/\bkab\s+tak\b/g, 'by when'],
  [/\bkis\s+tarah\b/g, 'how'],
  [/\bpaise\s+wapis\b|\bpaisay\s+wapis\b|\bpaise\s+wapas\b|\bmoney\s+back\b/g, 'refund'],
  [/\bdo\s+baar\b/g, 'twice'],
  [/\bnahi\s+mil(?:a|i|e|ega|egi|raha|rahi)\b|\bnai\s+mil\w*\b|\bnhi\s+mil\w*\b/g, 'not received'],
  [/\bnahi\s+aa?y(?:a|i|e)\b|\bnahi\s+aa?\s+rah(?:a|i)\b/g, 'not received'],
  [/\bkaam\s+nahi\s+kar\s+rah(?:a|i)\b|\bnahi\s+chal\s+rah(?:a|i)\b|\bnot\s+wrking\b/g, 'not working'],
];

/** One word at a time: prop-firm shorthand and misspellings. */
const TERM_MAP: Record<string, string> = {
  // Prop-firm shorthand and common misspellings
  dd: 'drawdown', drawdon: 'drawdown', drawdwn: 'drawdown', drowdown: 'drawdown', drawndown: 'drawdown',
  pyout: 'payout', payot: 'payout', paout: 'payout', payut: 'payout', payoutt: 'payout', payouts: 'payout',
  withdrawl: 'withdrawal', withdrawel: 'withdrawal', witdraw: 'withdraw', widraw: 'withdraw', withdrw: 'withdraw',
  acc: 'account', acct: 'account', accnt: 'account', acount: 'account', accout: 'account', akount: 'account', accs: 'accounts',
  chalenge: 'challenge', challange: 'challenge', chalange: 'challenge', chlng: 'challenge', challnge: 'challenge',
  phse: 'phase', fase: 'phase', evalution: 'evaluation', eval: 'evaluation',
  tgt: 'target', trgt: 'target', targt: 'target', prft: 'profit', profitt: 'profit',
  creds: 'credentials', cred: 'credentials', credntials: 'credentials', credentails: 'credentials',
  pwd: 'password', pasword: 'password', passwrd: 'password',
  verfication: 'verification', verifcation: 'verification', verifiction: 'verification',
  refnd: 'refund', refun: 'refund', rfnd: 'refund',
  cupon: 'coupon', coupen: 'coupon', copoun: 'coupon', coupn: 'coupon', promocode: 'promo code',
  discout: 'discount', discnt: 'discount', disc: 'discount',
  prise: 'price', prce: 'price', pric: 'price', prcie: 'price', prioce: 'price', priec: 'price',
  instnt: 'instant', instamt: 'instant', insant: 'instant',
  staus: 'status', stauts: 'status', satus: 'status', statsu: 'status', sttus: 'status',
  accoutn: 'account', accunt: 'account', acoount: 'account', accont: 'account',
  chek: 'check', chk: 'check', chck: 'check', ordr: 'order', oder: 'order',
  brech: 'breach', breech: 'breach', brach: 'breach',
  affilate: 'affiliate', afiliate: 'affiliate', comission: 'commission', commision: 'commission', refferal: 'referral', referal: 'referral',
  certficate: 'certificate', certifcate: 'certificate',
  lev: 'leverage', levrage: 'leverage',
  platfrom: 'platform', platfom: 'platform',
  rulez: 'rules', rulles: 'rules', ruls: 'rules',
  wekend: 'weekend', weeknd: 'weekend',
  scalpng: 'scalping',
};

/** Chat shorthand and Roman Urdu / Hindi words, put into English. */
const LANGUAGE_TERMS: Record<string, string> = {
  plz: 'please', pls: 'please', plzz: 'please', thx: 'thanks', thnx: 'thanks', ty: 'thanks',
  u: 'you', ur: 'your', r: 'are', y: 'why', wht: 'what', wat: 'what', hw: 'how', whn: 'when',
  kitna: 'how much', kitni: 'how much', kitne: 'how much', kitnay: 'how much',
  kab: 'when', kb: 'when',
  kese: 'how', kaise: 'how', kesay: 'how', kaisay: 'how', kaisa: 'how',
  kyun: 'why', kyu: 'why', kiun: 'why', kio: 'why',
  kahan: 'where', kidhar: 'where', kidhr: 'where', kaha: 'where',
  kya: 'what', kia: 'what',
  milega: 'get', milegi: 'get', milenge: 'get', milta: 'get', milti: 'get', mila: 'received', mili: 'received', mile: 'received',
  nahi: 'not', nahin: 'not', nai: 'not', nhi: 'not', ni: 'not',
  aaya: 'came', aya: 'came', aayi: 'came', ayi: 'came',
  paise: 'money', paisay: 'money', pese: 'money', paisa: 'money', raqam: 'amount', rqm: 'amount',
  nikalna: 'withdraw', nikalni: 'withdraw', nikalwana: 'withdraw', nikalwani: 'withdraw', nikaalna: 'withdraw',
  wapis: 'refund', wapas: 'refund',
  band: 'closed', bnd: 'closed',
  chahiye: 'want', chaiye: 'want', chahye: 'want', chahie: 'want',
  kharidna: 'buy', kharida: 'bought', kharidi: 'bought', lena: 'buy',
  din: 'days', dino: 'days', ghante: 'hours', ghanta: 'hour', hafta: 'week', hafte: 'weeks', mahina: 'month', mahine: 'months',
  jaldi: 'urgent', foran: 'urgent', fauran: 'urgent', turant: 'urgent',
  masla: 'problem', masala: 'problem', maslay: 'problems', madad: 'help',
  sahi: 'correct', galat: 'wrong', ghalat: 'wrong',
  kaam: 'work', chal: 'work',
  mera: 'my', meri: 'my', mere: 'my', mujhe: 'me', mjhe: 'me', apna: 'my', apni: 'my',
  hai: 'is', hain: 'are', tha: 'was', thi: 'was',
  aur: 'and', ya: 'or', lekin: 'but', magar: 'but',
  karna: 'do', karun: 'do', karoon: 'do', karen: 'do', karein: 'do', kar: 'do',
};

/** Words that carry only mood or politeness: dropped from `core`. */
const FILLER = new Set([
  'hi', 'hello', 'hey', 'hii', 'helo', 'salam', 'salaam', 'aoa', 'assalam', 'assalamualaikum', 'asalam', 'walaikum', 'alaikum', 'o',
  'bhai', 'bhae', 'bro', 'brother', 'yaar', 'yar', 'sir', 'madam', 'maam', 'dear', 'jani', 'boss', 'guys', 'team', 'admin', 'support',
  'please', 'kindly', 'thanks', 'thank', 'shukriya', 'ji', 'jee', 'g',
  'bakwas', 'bekar', 'bekaar', 'ghatiya', 'wtf', 'omg', 'ffs', 'damn', 'ridiculous', 'pathetic', 'useless', 'worst', 'terrible', 'disgusting', 'shameful', 'joke',
  'hello?', 'ok', 'okay', 'acha', 'accha', 'achha', 'hmm', 'umm', 'uh', 'so', 'like', 'just', 'actually', 'basically', 'literally', 'honestly',
  'is', 'are', 'was', 'the', 'a', 'an', 'do', 'me', 'ko', 'ka', 'ki', 'ke', 'se', 'ne', 'pe', 'par', 'mein', 'main', 'mai', 'to', 'tu', 'bhi', 'hi',
  'raha', 'rahi', 'rahe', 'gaya', 'gayi', 'gaye', 'hua', 'hui', 'hue', 'ho', 'hota', 'hoti', 'hoga', 'hogi', 'wala', 'wali', 'wale', 'diya', 'di', 'de',
]);

/** Terms the help centre uses: what a near-miss is corrected to. */
export const DOMAIN_TERMS = [
  'drawdown', 'withdrawal', 'withdraw', 'challenge', 'price', 'prices', 'pricing', 'verification', 'credentials', 'account', 'accounts', 'payout', 'profit',
  'target', 'evaluation', 'funded', 'leverage', 'consistency', 'platform', 'refund', 'coupon', 'discount', 'affiliate',
  'commission', 'referral', 'breach', 'breached', 'certificate', 'scaling', 'weekend', 'overnight', 'trading', 'server',
  'password', 'invoice', 'payment', 'purchase', 'subscription', 'cancel', 'cancellation', 'dashboard', 'metatrader',
  'ctrader', 'minimum', 'maximum', 'trailing', 'balance', 'equity', 'instant', 'spread', 'scalping', 'hedging',
  'martingale', 'copy', 'expert', 'advisor', 'restricted', 'country', 'countries', 'document', 'documents', 'passport',
  'agreement', 'contract', 'promotion', 'checkout', 'crypto', 'bitcoin', 'transfer', 'statement', 'violation', 'inactivity',
];

const ANGER = /\b(bakwas|bekaa?r|ghatiya|wtf|ffs|ridiculous|pathetic|useless|worst|terrible|disgusting|scam|fraud|cheat\w*|chor|loot|thieves|liars?|joke|shame\w*|frustrat\w*|angry|fed\s+up|tang\s+aa?\s+gaya|pagal)\b/i;
const URGENT = /\b(urgent\w*|asap|immediately|right\s+now|jaldi|foran|fauran|turant|emergency|today\s+itself|abhi\s+ke\s+abhi)\b/i;

export interface Understood {
  /** The whole message in the help centre's words (lower case). */
  normalized: string;
  /**
   * Only the shorthand and typos fixed ("pyout" → payout, "dd" → drawdown),
   * the Roman Urdu left as it is: for the sub-agent router, whose patterns
   * already read Roman Urdu and would misread its English ("kitna" is not a
   * price question).
   */
  domainFixed: string;
  /** The request alone: greetings, venting and filler removed. */
  core: string;
  /** The separate questions in it, each normalised and stripped. */
  parts: string[];
  /** Words that were corrected or translated, for logs and tests. */
  changed: { from: string; to: string }[];
  frustrated: boolean;
  urgent: boolean;
}

/** Optimal string alignment distance (Levenshtein plus adjacent swaps), capped. */
export function editDistance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let rowMin = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      rowMin = Math.min(rowMin, d[i][j]);
    }
    if (rowMin > cap) return cap + 1;
  }
  return d[a.length][b.length];
}

const DOMAIN_SET = new Set(DOMAIN_TERMS);

/** The domain term a long, unknown word is a typo of, if any. */
export function correctTerm(word: string): string | null {
  if (word.length < 6 || DOMAIN_SET.has(word) || /\d/.test(word)) return null;
  const allowed = word.length >= 8 ? 2 : 1;
  let best: string | null = null;
  let bestD = allowed + 1;
  for (const term of DOMAIN_TERMS) {
    if (term[0] !== word[0] || Math.abs(term.length - word.length) > allowed) continue;
    const dist = editDistance(word, term, allowed);
    if (dist < bestD) {
      best = term;
      bestD = dist;
    }
  }
  return bestD <= allowed ? best : null;
}

function clean(text: string): string {
  return (text || '')
    .toLowerCase()
    // Emoji and pictographs carry mood, not meaning.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ' ')
    // "plzzzz", "kyaaa", "hellooo": three or more of a letter become one.
    .replace(/([a-z])\1{2,}/g, '$1')
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}%$.,?!'@#\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Applies the domain maps, and with `language` the Roman Urdu ones too. */
function mapWords(text: string, changed: Understood['changed'], language: boolean): string {
  let t = text;
  for (const [re, to] of language ? [...PHRASE_MAP, ...LANGUAGE_PHRASES] : PHRASE_MAP) {
    t = t.replace(re, (m, ...groups) => {
      const out = to.replace(/\$(\d)/g, (_s, n) => String(groups[Number(n) - 1] ?? ''));
      if (m !== out) changed.push({ from: m, to: out });
      return out;
    });
  }
  return t
    .split(' ')
    .map((tok) => {
      const m = tok.match(/^([^\p{L}\p{N}]*)([\p{L}\p{N}'-]+)([^\p{L}\p{N}]*)$/u);
      if (!m) return tok;
      const [, pre, word, post] = m;
      const mapped = TERM_MAP[word] ?? (language ? LANGUAGE_TERMS[word] : undefined) ?? correctTerm(word);
      if (mapped && mapped !== word) {
        changed.push({ from: word, to: mapped });
        return `${pre}${mapped}${post}`;
      }
      return tok;
    })
    .join(' ');
}

function stripFiller(text: string): string {
  return text
    .split(' ')
    .filter((tok) => !FILLER.has(tok.replace(/[^\p{L}\p{N}']/gu, '')))
    .join(' ')
    .replace(/\s+([?.,!])/g, '$1')
    .replace(/^[\s,.!?-]+|[\s,.!?-]+$/g, '')
    .replace(/^(?:and|or|but|also|so|what)\s+(?=\S+\s+\S)/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Splits "price of 25k? aur drawdown kitna hai" into its questions. */
function splitQuestions(normalized: string): string[] {
  return normalized
    .split(/\?+|\n+|(?:^|\s)(?:and also|also|plus|and)\s+(?=(?:what|how|when|why|where|is|are|can|do|does|which|my)\b)/)
    .map((p) => stripFiller(p || ''))
    .filter((p) => p.split(' ').filter(Boolean).length >= 2);
}

export function understandMessage(text: string): Understood {
  const raw = text || '';
  const changed: Understood['changed'] = [];
  const cleaned = clean(raw);
  const normalized = mapWords(cleaned, changed, true).replace(/\s+/g, ' ').trim();
  const domainFixed = mapWords(cleaned, [], false).replace(/\s+/g, ' ').trim();
  const core = stripFiller(normalized);
  const parts = splitQuestions(normalized);
  const letters = raw.replace(/[^A-Za-z]/g, '');
  const shouting = letters.length >= 12 && letters === letters.toUpperCase();
  return {
    normalized,
    domainFixed,
    core: core || normalized,
    parts: parts.length > 1 ? parts.slice(0, 3) : [],
    changed,
    frustrated: ANGER.test(raw) || shouting || /[!?]{3,}/.test(raw),
    urgent: URGENT.test(raw),
  };
}

/**
 * The search queries a message stands for: the model's FAQ-style queries
 * (when there are any), the separate questions in it, the normalised request,
 * and the visitor's own words. Duplicates and near-empty ones are dropped.
 */
export function searchQueriesFor(message: string, modelQueries: string[] = [], max = 4): string[] {
  const u = understandMessage(message);
  const seen = new Set<string>();
  const out: string[] = [];
  const key = (q: string) => q.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  for (const q of [...modelQueries, ...u.parts, u.core, message.trim()]) {
    const k = key(q || '');
    if (k.split(' ').filter(Boolean).length < 1 || seen.has(k)) continue;
    seen.add(k);
    out.push(q.trim());
    if (out.length >= max) break;
  }
  return out;
}
