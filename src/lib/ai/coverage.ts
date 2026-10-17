/**
 * Which specialist is missing knowledge: a checklist per sub-agent, checked
 * against the indexed help centre (Settings → AI bot → Knowledge sources).
 *
 * Each model specialist (sub-agents.ts) needs a few facts to answer most of
 * what traders ask it: Payouts needs the payout schedule, the profit split,
 * the minimum, the methods, the processing time and how to request one.
 * Every item is searched in the workspace's published articles and Bot
 * knowledge with the same keyword index the bot uses (retrieval.ts), in a
 * few wordings; it counts as covered when one wording finds an article the
 * bot's own confidence gate would answer from. The rest is listed as
 * missing, so a team knows which article to write before re-indexing.
 *
 * A keyword check by design: free, instant, and it needs no embeddings, so
 * it works on a help centre that has never been indexed. An article worded
 * very differently from every probe can show as missing; adding the term
 * the probe uses (a heading is enough) fixes it, and also helps the bot.
 * No server imports: the report is built from an index the caller loads.
 */
import { assess, search, type HelpIndex } from './retrieval';
import { SUB_AGENT_BY_ID, SUB_AGENTS, type SubAgentId } from './sub-agents';

export interface CoverageItem {
  id: string;
  /** What the help centre should say, as shown to the admin. */
  label: string;
  /** Wordings to search for; one confident match is enough. */
  probes: string[];
}

export const COVERAGE: Partial<Record<SubAgentId, CoverageItem[]>> = {
  pricing_offers: [
    { id: 'prices', label: 'Price of each account size', probes: ['challenge price account size', 'pricing plans cost', 'challenge fee'] },
    { id: 'types', label: 'Challenge types (1-step, 2-step, instant)', probes: ['one step two step challenge', 'instant funding account', 'challenge types'] },
    { id: 'payment_methods', label: 'Payment methods for buying', probes: ['payment methods', 'pay crypto card'] },
    { id: 'discounts', label: 'Discounts and coupon codes', probes: ['discount coupon code', 'promo code offer'] },
    { id: 'reset_price', label: 'Reset or retake price', probes: ['reset price', 'retake challenge'] },
  ],
  rules: [
    { id: 'daily_dd', label: 'Daily drawdown / daily loss limit', probes: ['daily drawdown', 'daily loss limit'] },
    { id: 'max_dd', label: 'Maximum (overall) drawdown', probes: ['maximum drawdown', 'overall loss limit', 'max drawdown'] },
    { id: 'target', label: 'Profit target per phase', probes: ['profit target', 'phase target'] },
    { id: 'days', label: 'Minimum trading days', probes: ['minimum trading days', 'trading days'] },
    { id: 'consistency', label: 'Consistency rule', probes: ['consistency rule'] },
    { id: 'weekend', label: 'Weekend and overnight holding', probes: ['weekend holding', 'overnight positions'] },
    { id: 'leverage', label: 'Leverage and lot size', probes: ['leverage', 'lot size'] },
  ],
  payouts: [
    { id: 'first', label: 'When the first payout can be requested', probes: ['first payout', 'payout eligibility', 'payout schedule'] },
    { id: 'split', label: 'Profit split', probes: ['profit split'] },
    { id: 'minimum', label: 'Minimum payout amount', probes: ['minimum payout', 'minimum withdrawal'] },
    { id: 'methods', label: 'Payout methods', probes: ['payout methods', 'withdrawal crypto bank'] },
    { id: 'processing', label: 'Payout processing time', probes: ['payout processing time', 'withdrawal processing'] },
    { id: 'request', label: 'How to request a payout', probes: ['request payout', 'how to withdraw'] },
  ],
  account: [
    { id: 'credentials', label: 'When and how credentials are sent', probes: ['account credentials', 'login details email'] },
    { id: 'upgrade', label: 'Upgrade to phase 2 / funded after passing', probes: ['phase 2 after passing', 'funded account upgrade', 'next phase'] },
    { id: 'reset', label: 'Account reset', probes: ['account reset', 'reset account'] },
  ],
  platform: [
    { id: 'platforms', label: 'Which trading platforms are offered', probes: ['trading platforms', 'mt5 ctrader platform', 'metatrader'] },
    { id: 'login', label: 'How to log in (server names)', probes: ['server name login', 'platform login'] },
    { id: 'errors', label: 'Fixing login errors', probes: ['invalid account error', 'login problem'] },
  ],
  kyc: [
    { id: 'documents', label: 'Documents needed for KYC', probes: ['kyc documents', 'verification documents'] },
    { id: 'review_time', label: 'How long verification takes', probes: ['verification time', 'kyc review time'] },
    { id: 'countries', label: 'Restricted countries', probes: ['restricted countries', 'countries allowed'] },
    { id: 'contract', label: 'Trader agreement / contract', probes: ['trader agreement', 'contract'] },
  ],
  affiliate: [
    { id: 'join', label: 'How to join the affiliate programme', probes: ['affiliate program', 'become affiliate partner'] },
    { id: 'commission', label: 'Affiliate commission rates', probes: ['affiliate commission', 'commission rate'] },
    { id: 'payout', label: 'How affiliates are paid', probes: ['affiliate payout', 'commission payout'] },
  ],
  trading_tools: [
    { id: 'ea', label: 'Expert advisors and bots', probes: ['expert advisor', 'ea bots', 'automated trading'] },
    { id: 'news', label: 'News trading', probes: ['news trading', 'high impact news'] },
    { id: 'copy', label: 'Copy trading', probes: ['copy trading', 'trade copier'] },
    { id: 'hedging', label: 'Hedging, martingale and grid', probes: ['hedging', 'martingale grid'] },
    { id: 'scalping', label: 'Scalping and HFT', probes: ['scalping', 'high frequency trading hft'] },
  ],
  account_status: [
    { id: 'breach', label: 'What counts as a breach (hard / soft)', probes: ['account breach', 'rule violation', 'hard breach'] },
    { id: 'inactivity', label: 'Inactivity rule', probes: ['inactivity'] },
    { id: 'status', label: 'Where traders see their account status', probes: ['account status dashboard', 'account dashboard'] },
  ],
  kyc_status: [
    { id: 'rejection', label: 'Why KYC is rejected and how to re-submit', probes: ['kyc rejected', 'verification rejected resubmit'] },
    { id: 'pending', label: 'What to do while verification is pending', probes: ['verification pending', 'kyc review time'] },
  ],
  coupon_check: [
    { id: 'codes', label: 'Current coupon codes', probes: ['coupon code', 'discount code'] },
    { id: 'terms', label: 'Coupon conditions (expiry, one per order)', probes: ['coupon expiry', 'coupon terms'] },
  ],
  order_lookup: [
    { id: 'delivery', label: 'When the account arrives after purchase', probes: ['account delivery after purchase', 'credentials after payment'] },
    { id: 'invoice', label: 'Invoices and receipts', probes: ['invoice', 'receipt'] },
  ],
  affiliate_stats: [
    { id: 'tracking', label: 'How referrals are tracked', probes: ['referral tracking', 'referral link cookie'] },
    { id: 'dashboard', label: 'Where affiliates see their numbers', probes: ['affiliate dashboard', 'referral stats'] },
  ],
  refunds: [
    { id: 'policy', label: 'Refund policy', probes: ['refund policy', 'refund'] },
    { id: 'cancel', label: 'Cancelling an order', probes: ['cancel order', 'cancellation'] },
    { id: 'chargeback', label: 'Double charges and chargebacks', probes: ['chargeback', 'charged twice dispute'] },
  ],
  general: [
    { id: 'about', label: 'About the company', probes: ['about us company', 'who we are'] },
    { id: 'contact', label: 'Contact and support hours', probes: ['contact support', 'support hours'] },
    { id: 'how', label: 'How it works / getting started', probes: ['how it works', 'getting started'] },
  ],
};

export interface CoverageItemResult {
  id: string;
  label: string;
  covered: boolean;
  /** The article that covers it, when one does. */
  article: string | null;
  /** How it was found: the same words, or the model reading the articles (different wording). */
  matchedBy?: 'words' | 'meaning';
}

/* ── The model as a second reader (coverage-judge.ts) ─────────────────── */

/**
 * Firms word things their own way: one says "profit split", another "reward
 * share"; "How much does each account cost?" is the price list. The keyword
 * check misses those, and it also passes the wrong article when a long one
 * merely lists the words (on a real help centre, a pasted customer email
 * that named every topic "covered" the drawdown, refund and news items). An
 * embedding score alone is no better ("Minimum trading days" scored highest
 * against "What is the minimum hold time?"). So every item is put to the
 * model with every article's title and opening, in one call, and it names
 * the article that actually states the answer, or none. The keyword result
 * is only the fallback when there is no model.
 */
/**
 * How much of each article the model reads. A fact is often a few lines in
 * (a rules article lists drawdown after the intro); 100 articles at this
 * length is still well inside the model's context.
 */
export const EXCERPT_CHARS = 700;

export interface JudgeArticle {
  title: string;
  /** The opening of the article: enough to tell what it states. */
  excerpt: string;
}

export function coverageJudgePrompt(items: { key: string; label: string }[], articles: JudgeArticle[]): { system: string; user: string } {
  const system = [
    'You audit a prop-trading firm\'s help center. For each topic, name the article that actually states the answer to it, or 0 if none does.',
    'Firms use their own words: "reward" or "reward share" can mean payout or profit split, "program" can mean challenge or plan, "add-on" can be a paid extra. Judge by meaning.',
    'Be strict: an article only counts when it states the facts a trader would need for that topic (not when it merely mentions the word). A topic about one thing (e.g. minimum trading days) is not covered by an article about another (e.g. minimum hold time).',
    'Reply with JSON only: {"<topic key>": <article number or 0>, ...} covering every topic key.',
  ].join('\n');
  const user = [
    'ARTICLES:',
    ...articles.map((a, i) => `[${i + 1}] ${a.title.replace(/\s+/g, ' ').slice(0, 160)}: ${a.excerpt.replace(/\s+/g, ' ').slice(0, EXCERPT_CHARS)}`),
    '',
    'TOPICS:',
    ...items.map((t) => `${t.key}: ${t.label}`),
  ].join('\n');
  return { system, user };
}

/**
 * The model's verdict per topic key: an article number, or 0 for "none".
 * A key it left out, or answered with something else, is absent, and the
 * keyword result stands for it.
 */
export function parseJudgeAnswer(raw: string, keys: string[], articleCount: number): Map<string, number> {
  const out = new Map<string, number>();
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return out;
  try {
    const obj = JSON.parse(json) as Record<string, unknown>;
    for (const key of keys) {
      if (!(key in obj)) continue;
      const n = Number(obj[key]);
      if (Number.isInteger(n) && n >= 0 && n <= articleCount) out.set(key, n);
    }
  } catch {
    // Not JSON: the keyword result stands for every key.
  }
  return out;
}

export interface SpecialistCoverage {
  agent: SubAgentId;
  name: string;
  /** Switched off in Settings → AI bot → Sub-agents: its topic goes to the team, nothing to fill. */
  enabled: boolean;
  covered: number;
  total: number;
  items: CoverageItemResult[];
}

/**
 * Whether one wording finds an article that holds every one of its terms.
 * The answer gate alone is too kind here: a term no article contains is left
 * out of its coverage, so "consistency rule" would pass on any article that
 * says "rules". A probe is covered only when the help centre knows all its
 * words and one article contains them all.
 */
function findCovering(index: HelpIndex, probes: string[]): string | null {
  for (const probe of probes) {
    const hits = search(index, probe, { limit: 3 });
    const top = hits[0];
    if (!top || top.score < 1) continue;
    if (top.unknownRatio === 0 && top.coverage >= 0.99 && assess(hits, probe).confidence !== 'none') return top.article.title;
  }
  return null;
}

export function checkCoverage(index: HelpIndex, enabled: (id: SubAgentId) => boolean = () => true): SpecialistCoverage[] {
  return SUB_AGENTS.filter((a) => a.engine === 'model' && COVERAGE[a.id]?.length).map((a) => {
    const on = enabled(a.id);
    const items = (COVERAGE[a.id] || []).map((item) => {
      const article = on ? findCovering(index, item.probes) : null;
      return { id: item.id, label: item.label, covered: Boolean(article), article, ...(article ? { matchedBy: 'words' as const } : {}) };
    });
    return {
      agent: a.id,
      name: SUB_AGENT_BY_ID[a.id].name,
      enabled: on,
      covered: items.filter((i) => i.covered).length,
      total: items.length,
      items,
    };
  });
}
