/**
 * Retrieval over a workspace's own help centre, with no model API involved.
 *
 * The previous answer engine scored articles with `content.includes(word)` over
 * every word in the customer's message. That has four failure modes, and all of
 * them were reachable with the questions customers actually ask:
 *
 *  - no word boundaries, so "art" matched "start" and "party";
 *  - no stop words, so "what does the" scored as heavily as "drawdown";
 *  - no inverse document frequency, so a term appearing in every article
 *    counted as much as the one term that distinguished the answer;
 *  - no length normalisation, so the longest article tended to win.
 *
 * This is BM25 over weighted fields, with a confidence gate and passage-level
 * answer extraction. It only speaks when the evidence is strong, and when it
 * speaks it quotes the part of the article that actually answers the question
 * rather than the article's first 220 characters.
 */

/* ── Tokenising ───────────────────────────────────────────────────────── */

/**
 * Words that carry no retrieval signal. Beyond the usual English stop words
 * this drops support-chat filler ("hi", "please", "could you"), which is most
 * of a typical first message and used to dominate the old score.
 */
const STOP_WORDS = new Set(
  (
    'a about above after again against all am an and any are as at be because been ' +
    'before being below between both but by can cannot could did do does doing dont ' +
    'down during each few for from further had has have having he her here hers him ' +
    'his how i if in into is it its itself just me more most my no nor not of off on ' +
    'once only or other our out over own same she should so some such than that the ' +
    'their them then there these they this those through to too under until up very ' +
    'was we were while who whom will with would you your ' +
    'hi hello hey thanks thank please kindly ok okay yes sure tell know want need ' +
    'get got give let make take also would like im ive dont doesnt isnt whats ' +
    'question questions ask asking wondering anyone someone guys team sir maam ' +
    'much many lot lots plenty enough every each per still back well way ways ' +
    'thing things stuff first second third next last new old good bad big small ' +
    'able possible actually really quite rather even ever never always often ' +
    'set put go going come coming happen happens happened use using used work ' +
    'works working keep keeping mean means doing done seems looks bro plz pls ' +
    // Uzbek (Latin) filler. Without these "qancha kerak" became query terms
    // that matched nothing and diluted the ones that did.
    'qancha qanday qanaqa nima necha nechta mumkin mumkinmi kerak kerakmi bormi ' +
    'uchun bilan va yoki men mening menga meni siz sizning bu shu u da ga ni mi ' +
    'qilsam qilish qila olamanmi bo bolsa boladi ladi ladimi ham salom rahmat iltimos ' +
    'qachon qayerda qaysi nega ishlatsam ishlatish ishlatishim olsam'
  ).split(' ')
);

/**
 * Short forms customers type that the documentation spells out. Without these
 * "max" is a different term from "maximum" — and because "max" happened to
 * appear in exactly one article's table header, its inverse document frequency
 * was enormous and that article won questions it had nothing to do with.
 */
const ABBREVIATIONS: Record<string, string> = {
  max: 'maximum',
  min: 'minimum',
  info: 'information',
  acct: 'account',
  faq: 'question',
  docs: 'documentation',
  doc: 'documentation',
  kyc: 'verification',
};

/**
 * Suffixes that turn a verb into a noun. "withdrawal" and "withdraw" have to
 * be one term or a question about withdrawing money misses nine articles about
 * withdrawals. Each rule keeps a minimum stem length so "total" does not
 * become "tot".
 */
const DERIVATIONAL: [string, number][] = [
  ['ations', 6], ['ation', 5], ['ements', 7], ['ement', 7], ['ments', 5],
  ['ment', 5], ['ances', 5], ['ance', 5], ['ences', 5], ['ence', 5],
  ['ities', 5], ['ity', 5], ['ness', 4], ['sion', 5], ['tion', 5],
  ['als', 6], ['al', 6],
];

function stem(word: string): string {
  const expanded = ABBREVIATIONS[word] || word;
  let w = expanded;

  // Inflection first: plurals and verb endings.
  if (w.length > 4) {
    if (w.endsWith('ies') && w.length > 5) w = `${w.slice(0, -3)}y`;
    else if (w.endsWith('sses')) w = w.slice(0, -2);
    else if (w.endsWith('es') && w.length > 5) w = w.slice(0, -2);
    else if (w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    else if (w.endsWith('ing') && w.length > 6) w = w.slice(0, -3);
    else if (w.endsWith('ed') && w.length > 5) w = w.slice(0, -2);
  }

  // Then derivation, guarded so the stem stays a real word-length token.
  for (const [suffix, minRemainder] of DERIVATIONAL) {
    if (w.endsWith(suffix) && w.length - suffix.length >= minRemainder) {
      return w.slice(0, -suffix.length);
    }
  }
  return w;
}

/**
 * Words customers use interchangeably, mapped onto one term.
 *
 * Purely lexical matching cannot know that "payout" and "withdrawal" are the
 * same thing, and a customer who says "payout" gets nothing. These are generic
 * support-vocabulary pairs, not one company's jargon; anything specific to a
 * particular help centre is picked up from that help centre by
 * `expandFromCorpus`.
 */
const SYNONYM_GROUPS: string[][] = [
  ['withdrawal', 'withdraw', 'payout', 'cashout', 'disburse', 'disbursement'],
  ['refund', 'reimburse', 'rebate', 'refunded'],
  ['fee', 'charge', 'cost', 'price', 'pricing'],
  ['signup', 'register', 'registration', 'enroll'],
  ['login', 'signin', 'logon'],
  ['cancel', 'terminate', 'cancellation'],
  ['delete', 'remove', 'erase', 'wipe'],
  ['limit', 'cap', 'ceiling', 'threshold'],
  // "How long does it take" and "how soon does it arrive" are one question.
  ['duration', 'long', 'soon', 'quick', 'fast', 'speed', 'timeframe', 'wait'],
  ['allow', 'allowed', 'permit', 'permitted'],
  ['require', 'required', 'mandatory', 'forced', 'obliged', 'compulsory'],
  ['profit', 'earn', 'earning', 'gain', 'payoff'],
  ['loss', 'lose', 'losing', 'lost', 'blow', 'blown', 'bust', 'busted'],
  ['percentage', 'percent', 'share', 'split', 'portion', 'cut'],
  ['start', 'begin', 'commence'],
  ['finish', 'complete', 'pass', 'clear'],
  ['verify', 'verification', 'kyc'],
  ['support', 'help', 'assistance'],
  ['year', 'yearly', 'annual', 'annually'],
  // Trading shorthand. Help centres write "Expert Advisors (EAs)"; customers
  // type "ea" or "bot", and neither matched the other.
  ['bot', 'bots', 'ea', 'eas', 'robot', 'algo', 'automated', 'automation'],
  ['account', 'acc', 'acct'],
];

/**
 * Arabic and Uzbek (Latin) trading terms, rewritten to the English words the
 * help centre uses.
 *
 * The tokeniser keeps only a–z and digits, so an Arabic question lost every
 * word and matched nothing. The assistant normally translates a non-English
 * question before searching; this is what still finds the article when that
 * call is unavailable. Specific phrases come before the single words they
 * contain ("سحب الأرباح" is a withdrawal, "الحد الأقصى للسحب" is a drawdown).
 * Arabic has no \b in JS regex, so those patterns match on the phrase alone.
 */
const FOREIGN_TERMS: [RegExp, string][] = [
  // Arabic
  [/(?:الحد الأقصى |الحد الاقصى )?(?:للخسارة|الخسارة) اليومية|السحب اليومي|الحد اليومي|خسارة يومية/g, ' daily drawdown '],
  [/الحد الأقصى للخسارة|الحد الاقصى للخسارة|الخسارة الإجمالية|الخسارة الاجمالية|أقصى خسارة|الحد الأقصى للسحب/g, ' maximum loss drawdown '],
  [/تقسيم الأرباح|تقسيم الارباح|نسبة الأرباح|نسبة الارباح|حصة الأرباح/g, ' profit split '],
  [/سحب الأرباح|سحب الارباح|السحب|سحب|المدفوعات|الدفعات/g, ' withdrawal '],
  [/الرافعة المالية|الرافعة/g, ' leverage '],
  [/حجم اللوت|اللوت/g, ' lot size '],
  [/الأخبار|الاخبار|أخبار|اخبار/g, ' news '],
  [/عطلة نهاية الأسبوع|نهاية الأسبوع|نهاية الاسبوع|الويكند/g, ' weekend holding '],
  [/التداول الآلي|تداول آلي|روبوت|اكسبيرت|إكسبرت|نسخ الصفقات/g, ' bot '],
  [/وقف الخسارة/g, ' stoploss '],
  [/أيام الربح|ايام الربح|الأيام الرابحة/g, ' profitable day '],
  [/أيام التداول|ايام التداول/g, ' trading day '],
  [/عدة صفقات|صفقتين|نفس الوقت/g, ' concurrent layer trade '],
  [/مدة الاحتفاظ|الاحتفاظ بالصفقة/g, ' minimum holding time '],
  [/قاعدة الاتساق|الاتساق/g, ' consistency '],
  [/التحقق|التوثيق|توثيق/g, ' verification '],
  [/استرداد|استرجاع الرسوم/g, ' refund '],
  [/الرسوم|رسوم/g, ' fee '],
  [/المنصة|منصة|منصات/g, ' platform '],
  [/إغلاق الحساب|اغلاق الحساب|فشل الحساب|خرق القواعد/g, ' fail account rule '],
  [/الحساب|حساب|حسابي/g, ' account '],
  [/الأرباح|الارباح|الربح|ربح/g, ' profit '],
  [/الخسارة|خسارة/g, ' loss '],
  [/قواعد|القواعد|قاعدة/g, ' rule '],
  // Uzbek (Latin). ‘ ’ ʻ ' all appear as the o‘/g‘ apostrophe.
  [/\bkunlik\s+(?:zarar|limit|yo[‘’ʻ']?qotish)\w*/g, ' daily drawdown '],
  [/\b(?:maksimal|umumiy)\s+(?:zarar|yo[‘’ʻ']?qotish)\w*/g, ' maximum loss drawdown '],
  [/\bfoyda\s+(?:taqsimoti|ulushi)\b/g, ' profit split '],
  [/\bpul\s+yechish\b|\byechib\s+olish\b|\byechish\w*|\bto[‘’ʻ']?lov\w*/g, ' withdrawal '],
  [/\bfoydali\s+kun\w*/g, ' profitable day '],
  [/\bsavdo\s+kun\w*/g, ' trading day '],
  [/\bbir\s+vaqtda\b|\bbir\s+nechta\s+savdo\w*/g, ' concurrent layer trade '],
  [/\byangilik\w*/g, ' news '],
  [/\bdam\s+olish\s+kun\w*|\bhafta\s+oxiri\w*/g, ' weekend holding '],
  [/\bavtomatik\s+savdo\w*|\brobot\w*|\bekspert\w*/g, ' bot '],
  [/\blot\s+hajmi\w*/g, ' lot size '],
  [/\bleverij\w*|\bkredit\s+yelkasi\b/g, ' leverage '],
  [/\bverifikatsiya\w*/g, ' verification '],
  [/\bplatforma\w*/g, ' platform '],
  [/\bqoidabuzarlik\w*|\bqoida\w*/g, ' rule '],
  [/\byopildi\b|\byonib\s+ketdi\b/g, ' fail account '],
  [/\bhisob\w*/g, ' account '],
  [/\bfoyda\w*/g, ' profit '],
  [/\bzarar\w*/g, ' loss '],
  [/\bsavdo\w*/g, ' trade '],
];

/**
 * Multi-word expressions rewritten to the single word the documentation uses.
 * Applied to the raw text before tokenising, so "a limit per day" and "a daily
 * limit" become the same query.
 */
const PHRASE_REWRITES: [RegExp, string][] = [
  [/\b(?:per|each|every|a)\s+day\b/g, ' daily '],
  [/\b(?:per|each|every|a)\s+week\b/g, ' weekly '],
  [/\b(?:per|each|every|a)\s+month\b/g, ' monthly '],
  [/\b(?:per|each|every|a)\s+year\b/g, ' yearly '],
  [/\bhow\s+(?:long|soon)\b/g, ' duration '],
  [/\btakes?\s+(?:so\s+)?long\b/g, ' duration '],
  [/\bsign\s+up\b/g, ' signup '],
  [/\b(?:log|sign)\s+in\b/g, ' login '],
  [/\bstop[\s-]?loss\b/g, ' stoploss '],
  [/\bmoney\s+back\b/g, ' refund '],
  [/\bmax(?:imum)?\s*dd\b|\bmdd\b/g, ' maximum drawdown '],
  [/\bdd\b/g, ' drawdown '],
  [/\bsl\b/g, ' stoploss '],
  [/\bhft\b/g, ' high frequency bot '],
  [/\bexpert\s+advisors?\b/g, ' bot '],
  // "2 trades at the same time" is what trade layering rules describe as
  // concurrent trades.
  [/\bat\s+(?:the\s+)?same\s+time\b|\btogether\b|\bsimultaneous\w*|\bmultiple\s+trades?\b/g, ' concurrent layer trade '],
  ...FOREIGN_TERMS,
];

/** word → the term the whole group is indexed under. */
const SYNONYMS: Record<string, string> = Object.fromEntries(
  SYNONYM_GROUPS.flatMap((group) => group.map((word) => [word, group[0]]))
);

/** Splits text into stemmed content terms, dropping stop words and noise. */
export function tokenize(text: string): string[] {
  if (!text) return [];
  let normalised = text.toLowerCase();
  for (const [pattern, replacement] of PHRASE_REWRITES) {
    normalised = normalised.replace(pattern, replacement);
  }
  return normalised
    // Keep digits: "step 2" and "phase 1" are meaningful in this domain.
    .replace(/[^a-z0-9\s]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w))
    // Mapped before stemming so the group's canonical form gets stemmed, and
    // again after so inflected words ("passing") reach their group too.
    .map((w) => SYNONYMS[w] || w)
    .map(stem)
    .map((w) => SYNONYMS[w] || w);
}

/** Adjacent term pairs, so "daily drawdown" beats "daily" plus "drawdown". */
function bigrams(terms: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < terms.length - 1; i++) out.push(`${terms[i]} ${terms[i + 1]}`);
  return out;
}

/* ── Index ────────────────────────────────────────────────────────────── */

export interface RetrievableArticle {
  id: string;
  title: string;
  slug?: string | null;
  summary?: string | null;
  content: string;
  category?: string | null;
  section_id?: string | null;
  sectionName?: string | null;
}

interface IndexedDoc {
  article: RetrievableArticle;
  /** Title terms on their own — see the title boost in `search`. */
  titleTerms: Set<string>;
  titlePhrases: Set<string>;
  /** Weighted term frequency: a title hit counts for more than a body hit. */
  tf: Map<string, number>;
  /** Weighted length, for BM25's length normalisation. */
  length: number;
  /** Bigrams present anywhere in the document. */
  phrases: Set<string>;
  /** Distinct terms, for query-coverage checks. */
  terms: Set<string>;
}

export interface HelpIndex {
  docs: IndexedDoc[];
  /** term → number of documents containing it. */
  df: Map<string, number>;
  avgLength: number;
}

/**
 * A term is discriminative when it is not spread across most of the corpus.
 * Question words and house vocabulary ("account" in a help centre entirely
 * about accounts) fail this and are excluded from the confidence gates,
 * though they still contribute their small share to the ranking score.
 */
function isDiscriminative(index: HelpIndex, term: string): boolean {
  const df = index.df.get(term) || 0;
  return df > 0 && df <= Math.max(1, Math.ceil(index.docs.length * 0.35));
}

/** How much a hit is worth depending on where in the article it appears. */
const FIELD_WEIGHTS = { title: 4, summary: 2.5, section: 2, heading: 2, body: 1 };

function addField(
  tf: Map<string, number>,
  phrases: Set<string>,
  text: string,
  weight: number
): number {
  const terms = tokenize(text);
  for (const t of terms) tf.set(t, (tf.get(t) || 0) + weight);
  for (const b of bigrams(terms)) phrases.add(b);
  return terms.length * weight;
}

/** Lines that start with '#' — they describe what a section of the body covers. */
function headingText(content: string): string {
  return (content || '')
    .split('\n')
    .filter((l) => /^\s*#{1,6}\s/.test(l))
    .join(' ');
}

export function buildIndex(articles: RetrievableArticle[]): HelpIndex {
  const docs: IndexedDoc[] = articles.map((article) => {
    const tf = new Map<string, number>();
    const phrases = new Set<string>();
    let length = 0;

    length += addField(tf, phrases, article.title || '', FIELD_WEIGHTS.title);
    length += addField(tf, phrases, article.summary || '', FIELD_WEIGHTS.summary);
    length += addField(
      tf,
      phrases,
      `${article.sectionName || ''} ${article.category || ''}`,
      FIELD_WEIGHTS.section
    );
    length += addField(tf, phrases, headingText(article.content), FIELD_WEIGHTS.heading);
    length += addField(tf, phrases, article.content || '', FIELD_WEIGHTS.body);

    const titleTerms = tokenize(article.title || '');
    return {
      article,
      titleTerms: new Set(titleTerms),
      titlePhrases: new Set(bigrams(titleTerms)),
      tf,
      phrases,
      length,
      terms: new Set(tf.keys()),
    };
  });

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of doc.terms) df.set(term, (df.get(term) || 0) + 1);
  }

  const avgLength =
    docs.length > 0 ? docs.reduce((n, d) => n + d.length, 0) / docs.length : 1;

  return { docs, df, avgLength };
}

/* ── Scoring ──────────────────────────────────────────────────────────── */

const K1 = 1.4;
const B = 0.72;
/** Weight of an exact title match, tuned against a real help centre. */
const TITLE_BOOST = 4.5;

function idf(index: HelpIndex, term: string): number {
  const n = index.docs.length;
  const d = index.df.get(term) || 0;
  // Standard BM25 idf, floored at zero so a term present in every document
  // contributes nothing rather than pulling scores negative.
  return Math.max(0, Math.log(1 + (n - d + 0.5) / (d + 0.5)));
}

export interface Hit {
  article: RetrievableArticle;
  score: number;
  /**
   * Share of the query's *known* content terms this article contains, 0–1.
   * Terms the corpus has never seen are excluded: an article cannot be
   * penalised for not containing a word that appears in no article at all.
   */
  coverage: number;
  /** Share of query terms absent from the entire corpus, 0–1. */
  unknownRatio: number;
  /** How much of the question the article's own title accounts for, 0–1. */
  titleCoverage: number;
  /** Query terms the article does contain. */
  matched: string[];
  /** How many query terms the confidence gates are judged on. */
  gateTermCount: number;
  /** How many of those terms actually separate articles from one another. */
  distinctiveCount: number;
}

export interface SearchOptions {
  /**
   * Earlier visitor messages, most recent first. Their terms are folded in at
   * a decaying weight so a follow-up like "and how long does that take?"
   * still resolves against the topic already under discussion.
   */
  history?: string[];
  limit?: number;
}

export function search(
  index: HelpIndex,
  query: string,
  options: SearchOptions = {}
): Hit[] {
  const queryTerms = tokenize(query);
  if (queryTerms.length === 0 || index.docs.length === 0) return [];

  // Terms from the question itself carry full weight; context terms decay, so
  // they can break a tie but never outvote what was actually just asked.
  const weights = new Map<string, number>();
  for (const t of queryTerms) weights.set(t, (weights.get(t) || 0) + 1);

  // Context is a tie-breaker, not a vote. Asked "are you open on saturday?"
  // right after "i forgot my password", the history terms outweighed the two
  // words actually asked and the password article answered the opening-hours
  // question. Capping the total context weight below the question's own keeps
  // the last thing said the thing being answered.
  const questionWeight = queryTerms.length;
  const contextBudget = questionWeight * 0.35;
  const contextTerms = new Map<string, number>();

  (options.history || []).slice(0, 3).forEach((msg, i) => {
    const decay = 1 / (i + 1);
    for (const t of tokenize(msg)) {
      contextTerms.set(t, (contextTerms.get(t) || 0) + decay);
    }
  });

  const contextTotal = Array.from(contextTerms.values()).reduce((a, b) => a + b, 0);
  const scale = contextTotal > contextBudget ? contextBudget / contextTotal : 1;
  for (const [t, w] of contextTerms) {
    weights.set(t, (weights.get(t) || 0) + w * scale);
  }

  const queryPhrases = bigrams(queryTerms);
  const distinctQueryTerms = Array.from(new Set(queryTerms));

  // Split the question into words the documentation uses and words it has
  // never used. Only the first group can tell articles apart; the second says
  // something about whether the question belongs here at all.
  const knownTerms = distinctQueryTerms.filter((t) => (index.df.get(t) || 0) > 0);
  const unknownRatio = distinctQueryTerms.length
    ? 1 - knownTerms.length / distinctQueryTerms.length
    : 0;

  // Two different term sets, because the two gates ask different questions.
  //
  // Coverage asks "does this article talk about what was asked?", so it uses
  // every term the corpus knows — including the house vocabulary. Title match
  // asks "is this article *about* the question?", which only the distinctive
  // terms can answer; letting common words count there is how a question about
  // profit was answered by an article about withdrawal limits.
  //
  // Below two distinctive terms there is nothing to discriminate with, so the
  // title gate widens to the known terms rather than resting on one word.
  const discriminative = knownTerms.filter((t) => isDiscriminative(index, t));
  const titleGateTerms = discriminative.length >= 2 ? discriminative : knownTerms;
  const effectiveTerms = knownTerms;

  const hits: Hit[] = index.docs.map((doc) => {
    let score = 0;

    for (const [term, weight] of weights) {
      const f = doc.tf.get(term) || 0;
      if (f === 0) continue;
      const norm = f * (K1 + 1);
      const denom = f + K1 * (1 - B + (B * doc.length) / (index.avgLength || 1));
      score += weight * idf(index, term) * (norm / denom);
    }

    // An exact two-word phrase is much stronger evidence than the two words
    // appearing anywhere in a long article.
    for (const p of queryPhrases) {
      if (doc.phrases.has(p)) score += 1.6;
    }

    // Titles in a help centre are written as the questions customers ask, so a
    // title that accounts for the whole question is the strongest signal there
    // is. BM25 alone flattened this: a passing mention deep in a long article
    // could outweigh an exact title match, which is how a leverage article came
    // to answer a question about daily drawdown.
    const titleHits = titleGateTerms.filter((t) => doc.titleTerms.has(t)).length;
    const titleCoverage = titleGateTerms.length ? titleHits / titleGateTerms.length : 0;
    score += TITLE_BOOST * titleCoverage;
    for (const p of queryPhrases) {
      if (doc.titlePhrases.has(p)) score += 1.2;
    }

    const matched = effectiveTerms.filter((t) => doc.terms.has(t));
    const coverage = effectiveTerms.length ? matched.length / effectiveTerms.length : 0;

    return {
      article: doc.article,
      score,
      coverage,
      unknownRatio,
      titleCoverage,
      matched,
      gateTermCount: effectiveTerms.length,
      distinctiveCount: discriminative.length,
    };
  });

  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, options.limit ?? 5);
}

/* ── Confidence ───────────────────────────────────────────────────────── */

export type Confidence = 'high' | 'medium' | 'none';

export interface Assessment {
  confidence: Confidence;
  hit: Hit | null;
  /** Why the gate decided what it did — surfaced in diagnostics and tests. */
  reason: string;
  /** How far ahead of the runner-up the winner is, 0–1. */
  margin: number;
}

/**
 * Decides whether the top hit is good enough to answer with.
 *
 * Three independent gates, all of which must pass. Coverage is the one that
 * stops the old "one word in common is enough" behaviour: a question can only
 * be answered by an article that contains most of what was actually asked.
 */
export function assess(hits: Hit[], query: string): Assessment {
  if (hits.length === 0) {
    // Either the question was pure greeting or filler, or there is nothing to
    // search. Both mean the same thing here: say nothing.
    const hasTerms = tokenize(query).length > 0;
    return {
      confidence: 'none',
      hit: null,
      reason: hasTerms ? 'no articles indexed' : 'greeting or filler, no question asked',
      margin: 0,
    };
  }

  const top = hits[0];
  const runnerUp = hits[1]?.score ?? 0;
  const margin = top.score > 0 ? (top.score - runnerUp) / top.score : 0;

  const terms = Array.from(new Set(tokenize(query)));
  if (terms.length === 0) {
    return { confidence: 'none', hit: null, reason: 'question has no content words', margin };
  }

  // With no distinctive vocabulary to go on, only a commanding lead counts as
  // understanding rather than coincidence. A close race decided by one ordinary
  // word is the failure mode this whole gate exists to prevent.
  if (top.distinctiveCount <= 1 && terms.length >= 3 && margin < 0.35) {
    return {
      confidence: 'none',
      hit: top,
      reason: `too little distinctive vocabulary and no clear winner (${Math.round(margin * 100)}% ahead)`,
      margin,
    };
  }

  const knownCount = Math.max(1, top.gateTermCount);
  // A one- or two-word question has to match completely; there is nothing else
  // to go on, and a partial match there is a guess.
  const requiredCoverage = knownCount <= 2 ? 1 : knownCount <= 4 ? 0.6 : 0.5;

  if (top.score < 1.2) {
    return { confidence: 'none', hit: top, reason: `score ${top.score.toFixed(2)} below floor`, margin };
  }
  if (top.coverage < requiredCoverage) {
    return {
      confidence: 'none',
      hit: top,
      reason: `coverage ${(top.coverage * 100).toFixed(0)}% below ${(requiredCoverage * 100).toFixed(0)}% for a ${knownCount}-term question`,
      margin,
    };
  }

  // A title that accounts for the whole question is decisive on its own, even
  // when a second article scores close behind: the two are usually neighbours
  // on the same topic and the titled one is the answer.
  if (top.titleCoverage >= 0.99 && top.score >= 4) {
    return { confidence: 'high', hit: top, reason: 'question matches the article title', margin };
  }

  if (top.score >= 4 && top.coverage >= 0.7 && margin >= 0.12) {
    return { confidence: 'high', hit: top, reason: 'strong single match', margin };
  }

  // Two unrelated articles scoring alike means the question is ambiguous —
  // answering with one of them at random is how a bot loses trust.
  if (margin < 0.05 && top.titleCoverage < 0.5) {
    return { confidence: 'none', hit: top, reason: `ambiguous: top two within ${(margin * 100).toFixed(0)}%`, margin };
  }
  return { confidence: 'medium', hit: top, reason: 'partial match', margin };
}

/* ── Passage extraction ───────────────────────────────────────────────── */

/**
 * Splits markdown into answerable blocks: a paragraph, or a heading with the
 * list or paragraph that follows it. Lists stay whole — half a list of account
 * types is not an answer.
 */
export function splitBlocks(content: string): string[] {
  const lines = (content || '').replace(/\r\n/g, '\n').split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) blocks.push(text);
    current = [];
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // A heading starts a new block and stays attached to what follows it.
    if (/^\s*#{1,6}\s/.test(line) && current.length) flush();
    current.push(line);
  }
  flush();

  // Glue a lone heading onto the block after it.
  const merged: string[] = [];
  for (const b of blocks) {
    const isBareHeading = /^\s*#{1,6}\s/.test(b) && b.split('\n').length === 1;
    if (isBareHeading && merged.length >= 0) {
      merged.push(b);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && /^\s*#{1,6}\s/.test(prev) && prev.split('\n').length === 1) {
      merged[merged.length - 1] = `${prev}\n${b}`;
    } else {
      merged.push(b);
    }
  }
  return merged;
}

/** Strips markdown syntax so a passage reads as plain chat text. */
export function toPlainText(markdown: string): string {
  return markdown
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/(^|\W)\*(?!\s)(.+?)(?<!\s)\*(?=\W|$)/g, '$1$2')
    .replace(/`{1,3}([^`]+)`{1,3}/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s*[-*+]\s+/gm, '• ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * The part of the article that answers the question.
 *
 * Scored with the same terms as the article itself, so the passage returned is
 * the one the article won on — not whatever happened to be at the top of it,
 * which is what the old excerpt did.
 */
export function extractPassage(
  content: string,
  query: string,
  options: { maxChars?: number; history?: string[] } = {}
): string {
  const maxChars = options.maxChars ?? 600;
  const blocks = splitBlocks(content);
  if (blocks.length === 0) return '';
  if (blocks.length === 1) return toPlainText(blocks[0]).slice(0, maxChars);

  const weights = new Map<string, number>();
  for (const t of tokenize(query)) weights.set(t, (weights.get(t) || 0) + 1);
  for (const msg of (options.history || []).slice(0, 2)) {
    for (const t of tokenize(msg)) weights.set(t, (weights.get(t) || 0) + 0.3);
  }

  const scored = blocks.map((block, i) => {
    const terms = tokenize(block);
    const seen = new Set(terms);
    let score = 0;
    for (const [term, w] of weights) if (seen.has(term)) score += w;
    // Prefer the block that answers over one that merely restates the title.
    const density = terms.length ? score / Math.sqrt(terms.length) : 0;
    return { block, i, score, density };
  });

  const best = [...scored].sort((a, b) => b.density - a.density || b.score - a.score)[0];
  if (!best || best.score === 0) {
    // Nothing matched a specific block; the opening of the article is the
    // honest fallback, but say the whole first block rather than cut mid-word.
    return toPlainText(blocks.slice(0, 2).join('\n\n')).slice(0, maxChars);
  }

  // Carry the following block too when the winner is short — a heading plus a
  // one-line intro on its own is rarely the answer.
  const parts = [best.block];
  const next = scored[best.i + 1];
  if (next && toPlainText(best.block).length < 180) parts.push(next.block);

  const text = toPlainText(parts.join('\n\n'));
  if (text.length <= maxChars) return text;

  // Trim on a sentence or list boundary rather than mid-word.
  const cut = text.slice(0, maxChars);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return stop > maxChars * 0.5 ? cut.slice(0, stop + 1).trim() : `${cut.trim()}…`;
}
