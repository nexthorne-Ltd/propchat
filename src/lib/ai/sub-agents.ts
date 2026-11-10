/**
 * The prop-firm bot as a team of specialists.
 *
 * One generalist prompt answered pricing, drawdown, payouts and login trouble
 * the same way, so its answers were as vague as its brief. Here a router
 * (`routeSubAgent`) reads each visitor message and hands it to one specialist:
 * each has its own brief (what to lead with, what to ask, when a person must
 * take over), the articles of its topic placed first, and the workspace's own
 * extra instructions for it (Settings → AI bot → Sub-agents).
 *
 * Every specialist still reads the whole help centre: a question that mixes
 * topics ("what does the 25k cost and what is its drawdown?") or a router that
 * guessed wrong still gets a correct answer. The router is rules only (no
 * model call, so no extra wait), and a follow-up with no topic of its own
 * ("aur 25k pe?") stays with the specialist of the previous messages.
 *
 * This file has no server imports: the settings page shows the same
 * definitions and runs the same router in its "Test the router" box.
 */
import { understandMessage } from './understanding';

export type SubAgentId =
  | 'greeting'
  | 'pricing_offers'
  | 'rules'
  | 'payouts'
  | 'account'
  | 'platform'
  | 'kyc'
  | 'affiliate'
  | 'trading_tools'
  | 'account_status'
  | 'kyc_status'
  | 'coupon_check'
  | 'order_lookup'
  | 'affiliate_stats'
  | 'refunds'
  | 'general'
  | 'human_handover';

/** How a specialist answers: instant templates, the model, or straight to the team. */
export type SubAgentEngine = 'template' | 'model' | 'team';

export interface SubAgentDefinition {
  id: SubAgentId;
  name: string;
  /** Lucide icon name, mapped in the settings page. */
  icon:
    | 'hand' | 'tag' | 'shield' | 'wallet' | 'user' | 'monitor' | 'id-card' | 'users' | 'help' | 'headset'
    | 'cpu' | 'activity' | 'badge-check' | 'ticket' | 'receipt' | 'trending-up' | 'rotate-ccw';
  engine: SubAgentEngine;
  /** One line for cards. */
  summary: string;
  /** What it covers. */
  handles: string[];
  /** Questions it is built for, as traders write them. */
  examples: string[];
  /** When it brings in a person. */
  handsOverWhen: string;
  /** Off sends its topic straight to the team. Greeting and handover cannot be turned off. */
  canDisable: boolean;
  /** Its brief, added to the shared agent prompt. Empty for non-model specialists. */
  brief: string;
  /** Matches the titles/sections of the articles this specialist reads first. */
  articleMatch: RegExp | null;
  /** Matches visitor messages on its topic; each match scores one point. */
  topic: RegExp[];
  /**
   * Reads the trader's record from the workspace's trader data endpoint
   * (src/lib/ai/trader-data/) when one is connected. needsIdentity: only
   * after the visitor proved their email in this conversation.
   */
  lookup?: { action: TraderLookupAction; needsIdentity: boolean };
}

/** What the trader data endpoint is asked for (docs/TRADER_DATA.md). */
export type TraderLookupAction = 'account_status' | 'kyc_status' | 'coupon_check' | 'order_status' | 'affiliate_stats';

/**
 * How Account info and Account status answer from the trader's record
 * (trader-data/prop-firm-supabase.ts: summary, accounts, recent_orders).
 * Traders ask "how many accounts do I have, which are live, why did this
 * one fail": the record has all of it, so the answer is the record itself,
 * laid out, not a promise that the team will look.
 */
const RECORD_ACCOUNTS_BRIEF = [
  'answer from it. Start with the totals from summary (how many accounts, how many in each status, how many still without credentials).',
  'Then one short line per account: login (or "pending" when not delivered), phase, status, balance, and whether credentials were delivered.',
  'For a Failed account give the exact reason from failed_reason: its title and its message as written (they hold the real figures, e.g. how much was lost on which day), the date it was recorded, then one line on the rule from the HELP CENTER behind it. Never replace it with a guess or a general list of breach causes. If it says "not recorded", say the reason is not on record and offer a review by the team.',
  'Questions about their numbers (balance, equity, profit, drawdown used, win rate, trades, best day, this week or month, a day\'s result, open trades) are answered from that account\'s dashboard, with its exact figures and the stats_updated_at time ("as of ..."). When they did not say which account, use the one the question fits, or ask which login when several do.',
  'For "I paid but got no account": check recent_orders. An order whose accounts say "no account created for this order yet" or "not delivered yet" is exactly that: say so with the order id and date, give the normal delivery time from the HELP CENTER, and hand over only if it is past that time.',
  'Do not hand over or promise a callback when the record already answers; never invent a timeframe.',
].join(' ');

export const SUB_AGENTS: SubAgentDefinition[] = [
  {
    id: 'greeting',
    name: 'Greeting',
    icon: 'hand',
    engine: 'template',
    summary: 'Welcomes traders, answers thanks and goodbyes, and says what the bot can help with.',
    handles: ['Hi, salam, good morning', 'Thanks, ok, bye', '"Who are you?", "what can you do?"', 'Welcome back in an ongoing chat'],
    examples: ['salam', 'hi', 'thanks bro', 'aap kaun ho?'],
    handsOverWhen: 'Never. It answers instantly, without a model.',
    canDisable: false,
    brief: '',
    articleMatch: null,
    topic: [],
  },
  {
    id: 'pricing_offers',
    name: 'Pricing & offers',
    icon: 'tag',
    engine: 'model',
    summary: 'Challenge prices, account sizes, discounts and coupons, and which plan fits the trader.',
    handles: [
      'Price of each account size and challenge type (1-step, 2-step, instant)',
      'Current discounts, coupon codes and promotions',
      'Reset, retake and add-on prices',
      'Payment methods for buying a challenge',
      'Helping the trader choose a plan',
    ],
    examples: ['10k challenge kitne ka hai?', 'any discount code?', '2 step vs 1 step which is better', 'can I pay with crypto?'],
    handsOverWhen: 'A payment failed, was charged twice, or a coupon will not apply to their checkout.',
    canDisable: true,
    brief: [
      'You handle prices, plans and offers. Give the exact price for the size and type asked; if they did not say which, list the options briefly (size → price) and ask which they want.',
      'Mention a current offer or coupon only if the HELP CENTER states it, with its conditions and end date if given. Never invent a discount.',
      'Helping someone choose: ask at most one question (budget or experience), then recommend from the plan differences the HELP CENTER states.',
      'End with a short, friendly next step (where to buy) without pressure.',
    ].join('\n'),
    articleMatch: /\b(price|pricing|plans?|cost|fees?|challenge|account sizes?|offers?|discounts?|coupons?|promo|sale|payment methods?|checkout|buy|purchase|reset|retake|add-?ons?)\b/i,
    topic: [
      /\b(price|pricing|prices|cost|costs|fee|fees|how\s+much|kitne\s+ka|kitne\s+ki|kitni\s+ki|kitne\s+(?:paise|paisay|dollars?)|rate|rates|qeemat|keemat|paisay?\s+kitne)\b/i,
      /\b(discount|coupon|promo(?:\s*code)?|code|offer|offers|sale|deal|black\s*friday|off\b|cashback)\b/i,
      /\b(buy|purchase|order\s+a|kharid|lena\s+hai|checkout|payment\s+method|pay\s+with|crypto|card\s+se|jazzcash|easypaisa)\b/i,
      /\b(which\s+(?:plan|account|challenge)|best\s+(?:plan|account|challenge)|1[\s-]?step|2[\s-]?step|one[\s-]step|two[\s-]step|instant\s+(?:funding|account))\b/i,
    ],
  },
  {
    id: 'rules',
    name: 'Trading rules',
    icon: 'shield',
    engine: 'model',
    summary: 'Drawdown, profit targets, phases, trading days and what is allowed or forbidden.',
    handles: [
      'Daily and maximum drawdown (trailing or static, balance or equity)',
      'Profit targets per phase and how to pass',
      'Minimum/maximum trading days, consistency rule',
      'Weekend and overnight holding, lot size, leverage, stop loss (EAs, news and copy trading are Trading tools)',
      'What counts as a breach and what happens after',
    ],
    examples: ['dd kitna hai 10k pe', 'stop loss lagana zaroori hai?', 'weekend pe trade hold kar sakta hoon?', 'phase 2 target kya hai'],
    handsOverWhen: 'Almost never: rules are in the help center. A review of their own breach goes to the Account status specialist.',
    canDisable: true,
    brief: [
      'You handle the trading rules. State the rule with its exact number, then what it means in money for their account size when they gave one (show the sum).',
      'Say whether a limit is daily or overall, trailing or static, and measured on balance or equity, when the HELP CENTER says so.',
      'For "is X allowed?": answer yes/no first, then the condition or the reason.',
      'If they describe a situation ("I lost 600 today on 10k"), apply the rule to it and say plainly whether it breaks the rule.',
    ].join('\n'),
    articleMatch: /\b(rules?|drawdown|loss|targets?|phases?|evaluation|trading days|consistency|news|weekend|overnight|ea|expert advisors?|copy|hedg\w*|lots?|leverage|stop loss|breach|violations?|prohibited|allowed|strategies)\b/i,
    topic: [
      /\b(draw\s*-?down|\bdd\b|max(?:imum)?\s+loss|daily\s+loss|loss\s+limit|trailing|static)\b/i,
      /\b(profit\s+target|target|phase\s*[12]?|step\s*[12]|evaluation|verification\s+phase|pass(?:\s+kar)?|pass\s+ho)\b/i,
      /\b(trading\s+days?|min(?:imum)?\s+days|consistency|weekend|overnight|hold|lot\s*size|lots?|leverage|stop\s*loss|\bsl\b|tp\b)\b/i,
      /\b(rule|rules|allowed|not\s+allowed|forbidden|prohibited|kar\s+sakta|kar\s+sakte|ijazat|breach|violation|violate)\b/i,
    ],
  },
  {
    id: 'payouts',
    name: 'Payouts',
    icon: 'wallet',
    engine: 'model',
    summary: 'Payout eligibility, schedule, profit split, methods and fee refunds.',
    handles: [
      'When the first and later payouts can be requested',
      'Profit split and scaling',
      'Minimum payout, methods (bank, crypto, etc.) and processing time',
      'Refund of the challenge fee',
      'How to request a payout',
    ],
    examples: ['payout kab milega?', 'what is the profit split', 'first payout after how many days', 'fee refund hoti hai?'],
    handsOverWhen: 'The status of their own payout request, or a payout that is late, rejected or short.',
    canDisable: true,
    brief: [
      'You handle payouts. Lead with the direct answer (when / how much / how), with the exact figures and timeframes from the HELP CENTER.',
      'For "when will I get paid": explain the eligibility conditions and the processing time; you cannot see their request, so for the status of a specific payout say the team will check and hand over, asking for the account number and email if not given.',
      'Give the steps to request a payout when they ask how.',
    ].join('\n'),
    articleMatch: /\b(payouts?|withdraw\w*|profit split|split|scaling|refunds?|payments? to traders|rewards?)\b/i,
    topic: [
      /\b(payout|pay\s*out|withdraw\w*|withdrawal|nikal\w*|paisay?\s+(?:kab|kaise)|paise\s+(?:kab|kaise)|reward)\b/i,
      /\b(profit\s+split|split|scaling|scale\s+up)\b/i,
      /\b(fee\s+(?:refund\w*|wapis|back|return)|refund\w*\s+(?:of\s+)?(?:the\s+)?(?:challenge\s+)?fee|refundable\s+fee)\b/i,
    ],
  },
  {
    id: 'account',
    name: 'Account info',
    icon: 'user',
    engine: 'model',
    summary: "The trader's own account: credentials, upgrades, an account not showing. Explains, gathers details, brings in the team.",
    handles: [
      'Account "not showing" on the dashboard',
      'Credentials not received, login details, account upgrade to the next phase or funded',
      'Collecting account number and email so the team can act fast',
      'Anything about their own account with no narrower topic (status and breaches are Account status)',
    ],
    examples: ["I passed phase 1 but didn't get phase 2", 'credentials nahi mile', 'account dashboard pe show nahi ho raha', 'please check my account'],
    handsOverWhen: 'Anything that needs their records looked up or changed: missing credentials, upgrades, resets.',
    canDisable: true,
    brief: [
      'You handle questions about the trader\'s own account.',
      `With a TRADER RECORD: ${RECORD_ACCOUNTS_BRIEF}`,
      'Without one you cannot see their account. Help with what you can: the rule that usually causes their situation, the normal timeline (e.g. when phase 2 credentials are sent), and what they can check themselves.',
      'Then, if a person must look or act, say the team will check it and hand over. Ask for the account number (or login) and email in the same message if they have not given them; never ask twice.',
      'Without a record, never claim their account is fine, breached, upgraded or fixed: you cannot know.',
    ].join('\n'),
    articleMatch: /\b(accounts?|dashboard|credentials|login|upgrade|funded|phase|breach|reset|status)\b/i,
    lookup: { action: 'account_status', needsIdentity: true },
    topic: [
      /\b(my\s+account|mera\s+account|meri\s+account|mere\s+account|account\s+(?:show|nahi)|account\s+number|login\s+id)\b/i,
      /\b(credentials?|login\s+details|password\s+(?:nahi|not)|upgrade|next\s+phase|funded\s+account\s+(?:kab|when|not))\b/i,
    ],
  },
  {
    id: 'platform',
    name: 'Platform & technical',
    icon: 'monitor',
    engine: 'model',
    summary: 'MT4/MT5/cTrader and dashboard setup, servers, connection and how-to.',
    handles: [
      'Which platforms are offered and how to set them up',
      'Server names, connecting, "invalid account" errors',
      'Dashboard and charts how-to',
      'Step-by-step troubleshooting',
    ],
    examples: ['mt5 pe login kaise karun', 'server name kya hai', 'invalid account error', 'which platforms do you support'],
    handsOverWhen: 'Their login still fails after the troubleshooting steps, or the platform is down for them.',
    canDisable: true,
    brief: [
      'You handle platforms and technical help. Give numbered steps for setup or troubleshooting, using the platform and server names from the HELP CENTER.',
      'For an error, list the usual causes in order (wrong server, password, account type) and what to try.',
      'If it still does not work after the steps, hand over with what they tried.',
    ].join('\n'),
    articleMatch: /\b(platforms?|mt4|mt5|metatrader|ctrader|match-?trader|dxtrade|tradelocker|server|install|download|login|dashboard|technical|charts?)\b/i,
    topic: [
      /\b(mt4|mt5|metatrader|ctrader|match-?trader|dxtrade|tradelocker|platforms?|terminal|servers?|brokers?)\b/i,
      /\b(install|download|setup|set\s+up|connect|login\s+(?:kaise|how|nahi|not)|invalid\s+account|error|not\s+loading|crash\w*|chart|app)\b/i,
    ],
  },
  {
    id: 'kyc',
    name: 'KYC & verification',
    icon: 'id-card',
    engine: 'model',
    summary: 'Identity verification, documents, contracts and country eligibility.',
    handles: [
      'When KYC is required and which documents are accepted',
      'How long verification takes',
      'Trader contract / agreement',
      'Which countries are accepted',
    ],
    examples: ['kyc ke liye kya documents chahiye', 'how long does verification take', 'is Pakistan allowed?', 'contract kab milega'],
    handsOverWhen: 'Their KYC was rejected or is stuck, or a document question about their own case.',
    canDisable: true,
    brief: [
      'You handle KYC, verification and contracts. List exactly which documents are needed and when, from the HELP CENTER, and the usual review time.',
      'Country eligibility: answer only from the HELP CENTER; if a country is not mentioned, say so.',
      'A rejected or stuck verification needs the team: hand over and ask for account email.',
      'A verification or sign-up email that did not arrive is not KYC: give the email steps (spam, promotions, the address used, resend) and hand over only if it still has not come after that.',
    ].join('\n'),
    articleMatch: /\b(kyc|verification|verify|identity|documents?|passport|contract|agreement|countries|country|restricted)\b/i,
    topic: [
      /\b(kyc|verification|verify|verified|identity|id\s+card|cnic|passport|documents?|proof\s+of\s+address|selfie)\b/i,
      /\b(contract|agreement|country|countries|pakistan|india|allowed\s+in|restricted)\b/i,
    ],
  },
  {
    id: 'affiliate',
    name: 'Affiliate & partners',
    icon: 'users',
    engine: 'model',
    summary: 'Affiliate programme, referral links, commissions and partner payouts.',
    handles: ['How to join the affiliate programme', 'Commission rates and tiers', 'Referral links and tracking', 'Affiliate payouts'],
    examples: ['affiliate program hai?', 'what commission do affiliates get', 'referral link kahan milega'],
    handsOverWhen: 'A missing commission or a question about their own affiliate account.',
    canDisable: true,
    brief: [
      'You handle the affiliate and partner programme: how to join, commissions, tiers, links and affiliate payouts, all from the HELP CENTER.',
      'If the HELP CENTER says nothing about an affiliate programme, say so and offer to have the team follow up.',
    ].join('\n'),
    articleMatch: /\b(affiliates?|referrals?|partners?|commissions?|ib\b|introducing broker)\b/i,
    topic: [/\b(affiliate|referral|refer\s+a\s+friend|partner|commission|ib\b|introducing\s+broker|influencer)\b/i],
  },
  {
    id: 'trading_tools',
    name: 'Trading tools & strategies',
    icon: 'cpu',
    engine: 'model',
    summary: 'EAs and bots, news trading, copy trading, hedging, scalping, VPS: what is allowed and on what terms.',
    handles: [
      'Expert advisors, trading bots and algos: allowed or not, and which kinds',
      'News trading: the window around high-impact news and what happens to trades in it',
      'Copy trading, trade copiers and signal services',
      'Hedging, martingale, grid, scalping, HFT, arbitrage and VPS use',
    ],
    examples: ['can I trade news?', 'is EA allowed', 'copy trading allowed hai?', 'VPS use kar sakta hoon?', 'hedging allowed?'],
    handsOverWhen: 'Almost never: these rules are in the help center. A trader whose own account was breached for one goes to Account status.',
    canDisable: true,
    brief: [
      'You handle trading tools and strategies: EAs and bots, news trading, copy trading, hedging, martingale, grid, scalping, HFT, arbitrage and VPS.',
      'Answer yes / no / "only if" first, then the exact condition from the HELP CENTER (e.g. the minutes before and after news, which phases, what happens to a trade that breaks it).',
      'Separate what is allowed in the evaluation from what is allowed on a funded account when the HELP CENTER does.',
      'If the HELP CENTER does not mention a tool or strategy, say so plainly instead of guessing, and offer to have the team confirm.',
      'Never recommend a strategy or an EA, and never give signals.',
    ].join('\n'),
    articleMatch: /\b(ea|expert advisors?|bots?|algo\w*|news|copy\w*|hedg\w*|martingale|grid|scalp\w*|hft|arbitrage|vps|strateg\w*|prohibited|allowed)\b/i,
    topic: [
      /\b(ea|eas|expert\s+advisors?|bots?\s+trading|trading\s+bots?|algo\s*trading|algorithmic|automated\s+trading|robot)\b/i,
      /\b(news(?:\s+(?:trading|trade|events?))?|high[\s-]impact|nfp|fomc|cpi)\b/i,
      /\b(copy\s+trad\w*|trade\s+copier|copier|signal\s+(?:copy|service))\b/i,
      /\b(hedg\w*|martingale|grid|hft|high\s+frequency|scalp\w*|arbitrage|latency|reverse\s+trad\w*|vps)\b/i,
    ],
  },
  {
    id: 'account_status',
    name: 'Account status',
    icon: 'activity',
    engine: 'model',
    summary: "Whether the trader's account is active or breached, why it breached, and how much drawdown is left.",
    handles: [
      '"Is my account active?", "why was my account breached?"',
      'Hard and soft breaches, and which rule usually causes them',
      'How much drawdown or profit target is left, worked out from the numbers they give',
      'Collecting the login and email so the team can review the breach',
    ],
    examples: ['mera account breach kyun hua?', 'mera account active hai?', 'kitna drawdown bacha hai mere account mein', 'account status check karo'],
    handsOverWhen: 'A breach review, or a status only their records can show, or anything the trader record does not answer.',
    canDisable: true,
    brief: [
      "You handle the status of the trader's own account.",
      `With a TRADER RECORD: ${RECORD_ACCOUNTS_BRIEF}`,
      'Without one you cannot see their account. Explain what you can: the rules that usually cause a breach (daily loss, max loss, news window, consistency, inactivity), with the exact numbers from the HELP CENTER, and where they can see their status and history themselves.',
      "When they give figures (size, balance, equity, today's loss), work out what is left or whether a limit was crossed, showing the sum.",
      'For a breach review (they think the breach was wrong) or a status no record shows: say the team will check, ask for the account login and email in the same message if not given (never twice), and hand over.',
      'Without a record, never claim their account is active, breached or fine: you cannot know.',
    ].join('\n'),
    articleMatch: /\b(breach\w*|violations?|drawdown|loss|status|inactivity|consistency|dashboard|accounts?)\b/i,
    lookup: { action: 'account_status', needsIdentity: true },
    topic: [
      /\b(account\s+(?:status|active|breach\w*|band|closed|disabled|fail\w*|urr\w*|blow\w*|suspend\w*)|status\s+of\s+my\s+account|account\b.{0,20}\bstatus|status\b.{0,20}\baccount)\b/i,
      /\b(why\s+(?:was|is|did)\s+my|kyun\s+(?:breach|band|fail)|breached|blown|disabled|suspended|hard\s+breach|soft\s+breach)\b/i,
      /\b(?:(?:my|mera|meri|mere)\b.{0,30}\b(?:balance|equity|drawdown|dd)\b.{0,20}\b(?:kitna|kitni|how\s+much|left|bacha|bachi|remaining)|(?:kitna|kitni|how\s+much)\b.{0,30}\b(?:drawdown|dd|balance)\b.{0,20}\b(?:bacha|bachi|left|remaining))\b/i,
      // Their own dashboard numbers: "mera win rate", "my profit this week", "best day kab tha".
      /\b(?:my|mera|meri|mere)\b.{0,30}\b(?:win\s*rate|profit(?!\s*split)|p\s*&?\s*l|pnl|gain|trades|stats?|statistics|performance|equity|best\s+day|worst\s+day|open\s+trades?|drawdown)\b/i,
    ],
  },
  {
    id: 'kyc_status',
    name: 'KYC status',
    icon: 'badge-check',
    engine: 'model',
    summary: "Where the trader's own verification stands: pending, stuck or rejected, and what to fix.",
    handles: [
      'KYC pending for long, stuck or "still under review"',
      'Rejected verification and the usual reasons (blurry photo, expired ID, address mismatch)',
      'What to re-submit and how',
      'Collecting the account email so the team can check the case',
    ],
    examples: ['meri kyc reject ho gayi', 'kyc status kya hai', 'verification still pending', 'my documents were rejected'],
    handsOverWhen: 'Their case itself must be looked at: pending beyond the usual time, or rejected with no clear reason.',
    canDisable: true,
    brief: [
      "You handle the status of the trader's own KYC or verification. With a TRADER RECORD answer from it; without one you cannot see their case.",
      'First give what you can from the HELP CENTER: the usual review time, the common reasons for a rejection and how to re-submit correctly.',
      'If it is within the usual time, say so and when to expect an answer. If it is past that, or rejected with no clear reason, say the team will check, ask for the account email if not given (never twice), and hand over.',
      'Never say their verification is approved or rejected: you cannot know.',
    ].join('\n'),
    articleMatch: /\b(kyc|verification|verify|identity|documents?|rejected|pending|review)\b/i,
    lookup: { action: 'kyc_status', needsIdentity: true },
    topic: [
      /\b(kyc|verification|verify|documents?)\b.{0,40}\b(pending|stuck|reject\w*|declin\w*|fail\w*|status|approv\w*|nahi\s+hu\w*|nahi\s+ho\w*|kab\s+tak|still|abhi\s+tak|under\s+review|in\s+review)\b/i,
      /\b(my|mera|meri|mere)\s+(?:kyc|verification|documents?)\b/i,
    ],
  },
  {
    id: 'coupon_check',
    name: 'Coupon check',
    icon: 'ticket',
    engine: 'model',
    summary: 'A specific coupon code: whether it is current, its conditions, and why it will not apply at checkout.',
    handles: [
      '"Is code X valid?"',
      'A coupon that will not apply: expired, wrong plan, already used, case or spaces',
      'Which current codes the help center lists, with their conditions',
    ],
    examples: ['coupon code apply nahi ho raha', 'is this code valid', 'promo code not working', 'discount code invalid aa raha hai'],
    handsOverWhen: 'A code the help center does not list, or one that should work and still will not after the checks.',
    canDisable: true,
    brief: [
      'You handle a specific coupon or promo code. You cannot see the checkout or the list of live codes, only the HELP CENTER.',
      'If the code they name is in the HELP CENTER, give its discount, conditions (plans, sizes, dates, one use) and end date. If it is not there, say you cannot confirm it.',
      'For a code that will not apply, give the usual checks in order: typed exactly (no spaces, right case), still running, the plan or size it covers, already used, only one code per order.',
      'If it still fails after the checks, or they want a code confirmed that the HELP CENTER does not list, say the team will check, ask for the code and the plan they are buying if not given (never twice), and hand over.',
      'Never invent a code or a discount.',
    ].join('\n'),
    articleMatch: /\b(coupons?|promo\w*|discounts?|codes?|offers?|checkout)\b/i,
    lookup: { action: 'coupon_check', needsIdentity: false },
    topic: [
      /\b(coupon|promo\s*code|discount\s*code|code)\b.{0,40}\b(not\s+work\w*|nahi\s+(?:chal|lag|ho)\w*|kaam\s+nahi|work\s+nahi|invalid|expired?|valid|apply|error)\b/i,
      /\b(apply|valid|invalid|expired?)\b.{0,30}\b(coupon|code|promo)\b/i,
    ],
  },
  {
    id: 'order_lookup',
    name: 'Order lookup',
    icon: 'receipt',
    engine: 'model',
    summary: 'A purchase the trader made: paid but no account or email yet, order status, invoices.',
    handles: [
      '"I paid but did not get my account / credentials"',
      'Order status and how long delivery normally takes',
      'Invoices and receipts',
      'Collecting the order id, email and payment method so the team can find it',
    ],
    examples: ['payment kar di lekin account nahi mila', 'order status kya hai', 'my order id is 12345, where is my account', 'paise kat gaye account nahi aaya'],
    handsOverWhen: 'Past the normal delivery time, or the payment went through and nothing arrived, or anything the order record does not answer.',
    canDisable: true,
    brief: [
      "You handle the trader's own orders. With a TRADER RECORD answer from it: each order's status, plan, payment and whether its account was created and delivered. Without one you cannot see their orders or payments.",
      'First give what you can from the HELP CENTER: how long delivery normally takes for their payment method (card, crypto confirmations, bank), and what to check (spam folder, the email they bought with, the dashboard).',
      'If it is within the normal time, say so and when to expect it. If it is past that, or money left their account and nothing arrived, say the team will find it, ask for the order id (or payment reference), purchase email and payment method in one message if not given (never twice), and hand over.',
      'Never say an order went through, failed or will be refunded: you cannot know.',
    ].join('\n'),
    articleMatch: /\b(orders?|purchase|payment|checkout|invoice|receipt|delivery|credentials|crypto|card)\b/i,
    lookup: { action: 'order_status', needsIdentity: true },
    topic: [
      /\b(order\s*(?:id|number|no\.?|#|status)|my\s+order|mera\s+order|order\s+(?:kahan|where|not\s+received|nahi\s+mila|pending)|order\b.{0,25}\bstatus)\b/i,
      // An order id on its own ("o-2681 ka status"): the prop-firm backend's ids.
      /\b(?:o|ord)-[a-z0-9-]*\d/i,
      /\b(paid|payment\s+(?:kar\s+di|ki|done|made|ho\s+gayi|successful|kat\w*)|paise\s+kat\w*|paisay\s+kat\w*|amount\s+(?:deduct|kat)\w*|deducted)\b.{0,60}\b(account|credentials|challenge|email|nahi|not|no)\b/i,
      /\b(bought|purchased|kharida|kharidi|le\s+liya)\b.{0,50}\b(not|nahi|no|where|kahan|didn'?t)\b/i,
      /\b(invoice|receipt)\b/i,
    ],
  },
  {
    id: 'affiliate_stats',
    name: 'Affiliate stats',
    icon: 'trending-up',
    engine: 'model',
    summary: "An affiliate's own numbers: referrals, commission earned, missing or pending commission.",
    handles: [
      'Where affiliates see their referrals, clicks and commission',
      'A commission that is missing, pending or lower than expected',
      'When affiliate commission is paid out',
      'Collecting the affiliate email and the referred order so the team can trace it',
    ],
    examples: ['mera commission kitna hua', 'my referral stats', 'affiliate commission not credited', 'how many referrals do I have'],
    handsOverWhen: 'A missing commission or their own numbers that the affiliate record does not explain.',
    canDisable: true,
    brief: [
      "You handle an affiliate's own numbers. With a TRADER RECORD answer from it; without one you cannot see their affiliate account.",
      'First give what you can from the HELP CENTER: where they see referrals and commission (the affiliate dashboard), how a referral is tracked (link, code, cookie time), when commission is confirmed and paid.',
      'For a missing or wrong commission, list the usual causes (referral bought without the link or code, refund or chargeback, still in the pending period). If none fits, say the team will trace it, ask for the affiliate email and the referred order or buyer email if not given (never twice), and hand over.',
      'Never state their numbers: you cannot see them.',
    ].join('\n'),
    articleMatch: /\b(affiliates?|referrals?|commissions?|partners?|dashboard|tracking)\b/i,
    lookup: { action: 'affiliate_stats', needsIdentity: true },
    topic: [
      /\b(my|mera|meri|mere)\s+(?:affiliate|referrals?|commissions?|partner)\b/i,
      /\b(?:affiliate|referral|commission)\w*\b.{0,40}\b(stats?|statistics|dashboard|balance|earnings?|earned|kamaya|kamai|not\s+(?:credited|received|showing|paid)|nahi\s+(?:mila|mili|aaya|aayi)|missing|pending|how\s+many)\b/i,
      /\b(how\s+many|kitne)\s+(?:referrals|sign\s*-?ups)\b/i,
    ],
  },
  {
    id: 'refunds',
    name: 'Refunds & cancellations',
    icon: 'rotate-ccw',
    engine: 'model',
    summary: 'Refund policy for purchases, cancellations, double charges and chargebacks.',
    handles: [
      'Whether a challenge purchase can be refunded, and on what conditions',
      'Cancelling an order or a subscription',
      'Charged twice or a duplicate payment',
      'How long a refund takes to arrive (the challenge-fee refund with a payout is Payouts)',
    ],
    examples: ['refund chahiye', 'how do I cancel my order', 'I was charged twice', 'paise wapis kaise milenge'],
    handsOverWhen: 'Always for an actual refund or cancellation, after explaining the policy: only a person can approve one.',
    canDisable: true,
    brief: [
      'You handle refunds and cancellations of purchases. You cannot approve or start a refund: only the team can.',
      'First state the refund policy exactly as the HELP CENTER gives it (when a purchase is refundable, when not, e.g. after trading started, and how long a refund takes). If it says nothing, say so.',
      'A double charge is always worth checking: say the team will look at it.',
      'If they want a refund or cancellation, or were charged twice: say the team will review it, ask for the order id (or payment reference) and purchase email in one message if not given (never twice), and hand over.',
      'Never promise a refund or say one was approved. Never argue the policy: state it calmly.',
    ].join('\n'),
    articleMatch: /\b(refunds?|cancel\w*|chargebacks?|disputes?|terms|policy|money back)\b/i,
    topic: [
      /\b(refund\w*|money\s+back|wapis|wapas|return\s+my\s+money|chargeback|dispute)\b/i,
      /\b(cancel\w*|cancellation)\b/i,
      /\b(charged\s+twice|double\s+(?:charge\w*|payment|deduct\w*)|do\s+baar\s+(?:paise|payment)|duplicate\s+(?:charge|payment))\b/i,
    ],
  },
  {
    id: 'general',
    name: 'General & company',
    icon: 'help',
    engine: 'model',
    summary: 'Who the firm is, trust and legitimacy, contact and anything that fits no specialist.',
    handles: ['About the firm, "is this legit?"', 'Contact options and support hours', 'How prop trading with the firm works overall', 'General trading terms (no investment advice)', 'Anything else'],
    examples: ['is this firm legit?', 'how does it work?', 'what is a prop firm', 'office kahan hai'],
    handsOverWhen: 'Only if the question needs the firm\'s own facts that the help center does not have.',
    canDisable: true,
    brief: [
      'You handle general questions about the firm and how it works, and anything no other specialist covers.',
      '"Is it legit / a scam?": answer calmly with the facts the HELP CENTER gives (how long operating, payouts, regulation or company details if stated). Never claim anything it does not say.',
      'General trading terms may be explained briefly; never give investment advice or signals.',
    ].join('\n'),
    articleMatch: /\b(about|company|who we are|faq|getting started|how it works|contact|support)\b/i,
    topic: [/\b(legit|scam|fraud|trust|real\s+company|about\s+(?:you|the\s+company)|who\s+(?:are|owns)|how\s+(?:does\s+it|it)\s+works?|kaise\s+kaam|contact|email\s+address|office|support\s+hours)\b/i],
  },
  {
    id: 'human_handover',
    name: 'Human handover',
    icon: 'headset',
    engine: 'team',
    summary: 'Brings in a person when the trader asks for one or is fed up with the bot, with a summary for the agent.',
    handles: ['"I want to talk to a human / agent"', 'Frustration with the bot itself', 'A specialist that is switched off', 'Writes the handover note for your team'],
    examples: ['human se baat karwao', 'connect me to an agent', 'useless bot'],
    handsOverWhen: 'Always: that is its job. The bot stays off until the conversation is resolved when the trader asked for a person.',
    canDisable: false,
    brief: '',
    articleMatch: null,
    topic: [],
  },
];

export const SUB_AGENT_BY_ID = Object.fromEntries(SUB_AGENTS.map((a) => [a.id, a])) as Record<SubAgentId, SubAgentDefinition>;

export function isSubAgentId(value: unknown): value is SubAgentId {
  return typeof value === 'string' && value in SUB_AGENT_BY_ID;
}

/** Per-workspace switches and extra instructions: ai_settings.sub_agents. */
export type SubAgentSettings = Partial<Record<SubAgentId, { enabled?: boolean; instructions?: string | null }>>;

export function subAgentEnabled(settings: SubAgentSettings | null | undefined, id: SubAgentId): boolean {
  if (!SUB_AGENT_BY_ID[id].canDisable) return true;
  return settings?.[id]?.enabled !== false;
}

export const SUB_AGENT_INSTRUCTIONS_MAX = 2000;

/** Specialists the router can pick from the message itself. */
const TOPIC_AGENTS = SUB_AGENTS.filter((a) => a.topic.length > 0);

function scoreTopics(text: string): Map<SubAgentId, number> {
  const scores = new Map<SubAgentId, number>();
  for (const a of TOPIC_AGENTS) {
    const s = a.topic.filter((re) => re.test(text)).length;
    if (s > 0) scores.set(a.id, s);
  }
  return scores;
}

/**
 * Who wins a tie: the narrower topic. "Is Pakistan allowed?" is KYC, not a
 * trading rule; "fee refund?" is Payouts, not Refunds; "mera account breach
 * kyun hua" is Account status, not Rules; "coupon apply nahi ho raha" is
 * Coupon check, not Pricing; "is EA allowed" is Trading tools, not Rules;
 * "cancel my order" is Refunds, not Order lookup; "paid but account nahi
 * mila" is Order lookup, not Account.
 */
const TIE_ORDER: SubAgentId[] = [
  'kyc_status',
  'kyc',
  'coupon_check',
  'affiliate_stats',
  'affiliate',
  'account_status',
  'payouts',
  'refunds',
  'order_lookup',
  'account',
  'platform',
  'trading_tools',
  'pricing_offers',
  'rules',
  'general',
];

function best(scores: Map<SubAgentId, number>): SubAgentId | null {
  let top: SubAgentId | null = null;
  let topScore = 0;
  for (const id of TIE_ORDER) {
    const s = scores.get(id) ?? 0;
    if (s > topScore) {
      top = id;
      topScore = s;
    }
  }
  return top;
}

/** The message as typed plus its shorthand and typos fixed: each topic pattern still scores once. */
function readingOf(text: string): string {
  const fixed = understandMessage(text).domainFixed;
  return fixed && fixed !== text.toLowerCase() ? `${text}
${fixed}` : text;
}

export interface RouteInput {
  message: string;
  /** Oldest first; the latest visitor message may or may not be included. */
  recent?: { role: string; content: string }[];
  /** The intent classifier's verdict (intent.ts), when there is one. */
  intent?: string | null;
  /** The visitor explicitly asked for a person (asksForHuman). */
  asksForHuman?: boolean;
}

export interface RouteResult {
  agent: SubAgentId;
  /** Why, in a few words, for the handover note and the router tester. */
  reason: string;
  /**
   * How sure the rules are. 'sure': one topic won, or the intent decided
   * (greeting, a person, a follow-up). 'tie': several topics scored the same
   * and TIE_ORDER picked one. 'none': no topic at all, so General. A tie or
   * none is where a model may decide instead (router-assist.ts).
   */
  certainty?: 'sure' | 'tie' | 'none';
  /** For a tie, the specialists that scored the top score (the pick first). */
  candidates?: SubAgentId[];
  /** Who decided: the rules, or Jev / the model when the rules were unsure. */
  decidedBy?: 'rules' | 'jev' | 'model';
}

/** The top-scoring specialists, in TIE_ORDER: one when a topic clearly won. */
function leaders(scores: Map<SubAgentId, number>): SubAgentId[] {
  const top = Math.max(0, ...scores.values());
  return top > 0 ? TIE_ORDER.filter((id) => (scores.get(id) ?? 0) === top) : [];
}

/**
 * Which specialist answers. Order: a request for a person, small talk, the
 * topic of the message itself (most matching patterns wins; "my account" with
 * no other topic goes to Account), the topic of the previous messages for a
 * follow-up, then General.
 */
export function routeSubAgent(input: RouteInput): RouteResult {
  const text = (input.message || '').trim();
  // asksForHuman false means the caller decided a wants_human verdict was anger alone.
  if (input.asksForHuman || (input.intent === 'wants_human' && input.asksForHuman === undefined)) {
    return { agent: 'human_handover', reason: 'Asked for a person' };
  }
  if (input.intent === 'small_talk') return { agent: 'greeting', reason: 'Greeting or small talk' };

  // A question about their own account that names a topic ("my payout is
  // late") goes to that topic's specialist, which knows the rules and hands
  // over for the lookup; with no topic of its own it is the Account specialist's.
  // Scored on the words as typed and as normalised (understanding.ts), so
  // "pyout kab ayga" or "mera acc ud gaya" finds its topic.
  const scores = scoreTopics(readingOf(text));
  const own = best(scores);
  if (own) {
    const tied = leaders(scores);
    return {
      agent: own,
      reason: `Message is about ${SUB_AGENT_BY_ID[own].name.toLowerCase()}`,
      certainty: tied.length > 1 ? 'tie' : 'sure',
      ...(tied.length > 1 ? { candidates: tied } : {}),
    };
  }
  if (input.intent === 'account_specific') return { agent: 'account', reason: "About the trader's own account" };

  // A follow-up ("aur 25k pe?", "and for phase 2?") keeps the topic of the last few messages.
  const earlier = (input.recent || [])
    .filter((m) => m.content && m.content.trim() !== text)
    .slice(-4)
    .map((m) => m.content)
    .join('\n');
  const previous = earlier ? best(scoreTopics(readingOf(earlier))) : null;
  if (previous) return { agent: previous, reason: `Follow-up on ${SUB_AGENT_BY_ID[previous].name.toLowerCase()}` };

  return { agent: 'general', reason: 'No specific topic', certainty: 'none' };
}

/** Greeting with what the bot can help with: the Greeting specialist's welcome. */
export function propFirmWelcome(lang: string, brand: string, name?: string | null): string {
  const who = name ? ` ${name}` : '';
  if (lang === 'roman_ur') {
    return `Assalam o Alaikum${who}! 👋 ${brand} mein khush aamdeed. Main challenge prices aur offers, trading rules, payouts, aapke account, platform setup aur KYC mein madad kar sakta hoon. Bataiye kya jaanna chahte hain?`;
  }
  return `Hi${who}! 👋 Welcome to ${brand}. I can help with challenge prices and offers, trading rules, payouts, your account, platform setup and KYC. What would you like to know?`;
}
