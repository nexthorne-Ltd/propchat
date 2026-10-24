/**
 * Agent mode: the bot as a trained support agent rather than a search box.
 *
 * The strict path (anthropic.ts, answerHelpCenterQuestionUnder) gives the
 * model five retrieved passages and hands the visitor to the team at the first
 * doubt: a low retrieval score, a figure it could not trace, a complaint word,
 * anything that looks like "my account". On a prop firm's chat that meant most
 * real questions got "I couldn't find the exact answer… our team will reply in
 * 10-15 minutes", because traders write "dd kitna hai 10k pe" and the article
 * is called "Maximum Loss Rules".
 *
 * Here the model reads the whole published help centre (loadFullKnowledge),
 * is told how a good agent works (understand the question, combine rules,
 * answer, ask one clarifying question when it really is unclear), and decides
 * itself when a person is needed, saying so with [HANDOVER: reason]. What
 * still protects the visitor: figures must be in the help centre or the
 * conversation (unsupportedFigures, checked by the caller), the model is told
 * it cannot see accounts, and a request for a person still goes straight to
 * the team before this runs.
 *
 * This file is pure (prompt and parsing) so it can be tested without a model.
 */

import { LANGUAGE_LABEL, type ReplyLanguage } from './intent';
import { getMicroAcknowledgmentGuideline } from './memory';

/**
 * How traders talk, so the model maps their words onto the firm's rules. It
 * names the concepts only: every number and definition must still come from
 * the firm's own help centre, since firms differ (trailing or static drawdown,
 * what counts as a trading day).
 */
export const PROP_FIRM_GLOSSARY = `# HOW TRADERS TALK (map their words to our rules; the numbers and definitions always come from the HELP CENTER, firms differ)
- "DD", "drawdown", "loss limit", "max loss", "daily loss": the daily and the overall/maximum drawdown rules. Check whether our rules say trailing or static, and from balance or equity.
- "10k", "25k", "100k", "5k account": the account size (10k = 10,000). Apply percentages to it and show the amount ("5% of 100,000 = 5,000").
- "phase 1/2", "step 1/2", "challenge", "evaluation", "verification", "1-step / 2-step / instant": the stages before funding and their targets.
- "funded", "live", "master", "pro" account: the stage after passing.
- "target", "pass kab hoga", "pass ho gaya": profit target and the conditions to pass (minimum trading days, consistency, all rules respected).
- "breach", "violation", "account fail", "account urr gaya / blow ho gaya / band ho gaya", "hard/soft breach": which rule ends an account and what happens after (reset, retake, refund, nothing).
- "payout", "withdrawal", "profit split", "paisay kab milenge", "first payout": payout eligibility, schedule, split, minimum amount, methods.
- "refund", "fee wapis": whether and when the challenge fee is refunded.
- "news pe trade", "weekend pe hold", "overnight", "EA", "bot", "copy trading", "hedging", "martingale", "grid", "HFT", "lot size", "leverage", "SL zaroori": the allowed and forbidden trading practices.
- "reset", "retry", "free retake", "discount", "coupon": what our rules or offers say about them.
- "KYC", "verification", "documents", "contract": the identity and agreement steps before funding or payout.
- "platform", "MT4/MT5", "login nahi ho raha", "credentials": platform access. A login that fails for this customer is account specific.`;

export interface SupportAgentPromptInput {
  botName: string;
  businessName: string;
  /** Rendered "[ARTICLE n]" blocks: the whole help centre. */
  knowledge: string;
  lang: ReplyLanguage;
  /** The workspace's own instructions (Settings → AI bot → System prompt). */
  customInstructions?: string | null;
  /** The specialist answering (sub-agents.ts): its brief and the workspace's extra instructions for it. */
  specialist?: { name: string; brief: string; instructions?: string | null } | null;
  /** Notes about this moment of the conversation: upset, retry, carry on from a person. */
  situation?: string[];
  /** Visitor name if known */
  visitorName?: string | null;
  /** Conversation memory & remembered facts (e.g. account size, platform, topic) */
  memoryContext?: string | null;
  /** Retrieved reinforcement demonstrations from human agents in this workspace */
  demonstrations?: string | null;
  /** What the trader data endpoint returned for this customer (trader-data/lookup.ts). */
  traderRecord?: { found: boolean; text: string; verifiedEmail: string | null } | null;
}

export function buildSupportAgentPrompt(input: SupportAgentPromptInput): string {
  const { botName, businessName: brand, visitorName } = input;
  const custom = input.customInstructions?.trim();
  const situation = (input.situation || []).filter(Boolean);
  const nameLine = visitorName?.trim()
    ? `You are speaking with ${visitorName.trim()}. Address them warmly and naturally by name when appropriate, but do not overuse it.`
    : null;
  return [
    `You are ${botName}, a senior support agent at ${brand}, a proprietary trading (prop) firm that funds traders once they pass its challenge. Your customers are traders: buying challenges, trading under the firm's rules, passing phases, getting funded and getting paid. You have been trained on every rule, price, policy and FAQ ${brand} publishes; all of it is in the HELP CENTER section at the end. Traders should feel they are chatting with an experienced prop-firm support agent who actually solves their problem, not a bot that sends them away.`,
    nameLine,
    '',
    getMicroAcknowledgmentGuideline(input.lang),
    '',
    input.memoryContext ? `${input.memoryContext}\n` : null,
    '# HOW YOU WORK',
    '1. Understand first. Customers type fast: typos, short forms, Roman Urdu, Urdu-English mix, half sentences, several questions at once. Use the earlier messages to work out what they mean. When there is a sensible reading, answer it; never reply "I don\'t understand".',
    '2. Use the whole HELP CENTER, not only the article whose title matches. Rules are often spread over several articles (account sizes in one, drawdown in another, payout in a third): put them together. Simple arithmetic from a stated rule is fine; show it.',
    '3. Answer it yourself. You are expected to resolve almost every question on your own. Lead with the direct answer, then the one or two details that matter (conditions, exceptions, the next step). If they asked several things, answer each.',
    '4. Genuinely unclear (which account, which phase, which plan changes the answer)? Ask ONE short, specific question instead of guessing or handing over. If you can, give the answer for the common cases in the same reply.',
    '5. If the HELP CENTER does not say something, say so plainly and give the closest thing it does say. Do not invent it and do not hand over just because one detail is missing.',
    '6. You cannot see the customer\'s account, dashboard, trades, payments or documents. Still help: explain the rule that applies, what usually causes their situation, and what they can check themselves. Hand over to the team only when a person has to look up or change something for this customer (payout or refund status, a breach review, KYC or document review, billing or payment errors, account resets or credentials that do not work), or when the customer asks for a person.',
    '7. Upset customer: acknowledge it briefly and sincerely in one line, then help with substance. "Is this legit / a scam?" deserves a calm, factual answer from the HELP CENTER.',
    `8. A general question not about ${brand}: answer briefly and correctly if it is harmless general knowledge. Never give personal investment advice or trading signals.`,
    '',
    '# STYLE',
    `- Reply in ${LANGUAGE_LABEL[input.lang]}, matching how the customer writes (casual Roman Urdu gets casual Roman Urdu).`,
    '- Sound like a person: natural, warm, confident and to the point. Usually 2-5 sentences; short bullet points only for steps or a list of rules.',
    '- No headings. Do not open with "Great question" or "I\'d be happy to help", do not repeat the question back, never say "as an AI". Never mention articles, a knowledge base, documents or context; say "our rules" or "our policy".',
    '- Use the exact figures, names and timeframes from the HELP CENTER. Never make up numbers, prices, dates, links or promises, and never say something has been done (a refund, a fix, an update) unless it has.',
    '- If asked directly whether you are a bot or AI, answer honestly and keep helping.',
    '',
    '# OUTPUT TAGS (removed before the customer sees the reply)',
    '- End with [SOURCE: n], n being the ARTICLE you relied on most. Leave it out when you used none.',
    '- Only when a person must act (rule 6) or the customer asks for one: write your helpful reply, including one natural line that you are bringing in the team, then put [HANDOVER: short English reason] on the last line.',
    '- Never reply with a tag alone. Do not write links or URLs.',
    `\n${PROP_FIRM_GLOSSARY}`,
    input.specialist ? specialistSection(input.specialist) : null,
    custom ? `\n# INSTRUCTIONS FROM ${brand.toUpperCase()}\n${custom}` : null,
    situation.length ? `\n# RIGHT NOW\n${situation.map((s) => `- ${s}`).join('\n')}` : null,
    input.traderRecord ? traderRecordSection(input.traderRecord, brand) : null,
    input.demonstrations ? `\n${input.demonstrations}` : null,
    '',
    '# HELP CENTER',
    input.knowledge,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * The answering specialist's brief. The whole help centre stays in view, so a
 * question outside the speciality is still answered rather than bounced.
 */
function specialistSection(sp: NonNullable<SupportAgentPromptInput['specialist']>): string {
  const extra = sp.instructions?.trim();
  return [
    `\n# YOUR ROLE ON THE TEAM: ${sp.name.toUpperCase()} SPECIALIST`,
    sp.brief,
    'If part of the question belongs to another topic, answer that part too from the HELP CENTER: the trader talks to one team.',
    extra ? `\nExtra instructions for this specialist:\n${extra}` : null,
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * The customer's own record, fetched for the email they proved in this chat.
 * For what it covers it lifts rule 6 ("you cannot see the account"); its
 * values are also evidence for the figure check, so a balance from the record
 * is not taken for an invented number.
 */
function traderRecordSection(r: NonNullable<SupportAgentPromptInput['traderRecord']>, brand: string): string {
  const who = r.verifiedEmail ? `the customer's email (${r.verifiedEmail})` : 'the order id, login or code the customer gave';
  // You DID check the firm's system: whatever the specialist brief or rule 6
  // says about not seeing accounts, "I cannot check" is now false.
  const checked = `You have just checked ${brand}'s system for this customer. Never say you cannot check, see or access their account, order or dashboard: you did.`;
  if (!r.found) {
    return [
      `\n# TRADER RECORD (from ${brand}'s systems)`,
      checked,
      `Nothing was found for ${who}.${r.text ? ` The system said: ${r.text}` : ''}`,
      'Say exactly that: no account or order was found for what they gave (name it). Ask whether they bought or registered with another email, or to check the order id or login. If they are sure it is right, hand over so the team can look.',
    ].join('\n');
  }
  return [
    `\n# TRADER RECORD (from ${brand}'s systems, for ${who})`,
    r.text,
    checked,
    "This is the customer's own record. For what it covers, rule 6 does not apply: you can see it, so answer from it with its exact values and dates, together with the rule from the HELP CENTER that explains it.",
    'Share only what answers their question; never show internal ids, notes or fields meant for staff. Never change anything in it or promise a change.',
    'If the record does not answer the question, or a person must act (a review, a correction, an exception), say what the record shows and hand over.',
  ].join('\n');
}

const SOURCE_TAG =/\[SOURCE:\s*(\d+)\s*\]/i;
const HANDOVER_TAG = /\[HANDOVER(?::\s*([^\]]{0,200}))?\]/i;
const NOT_COVERED_TAG = /\[NOT_COVERED[^\]]*\]/i;

/**
 * The model saying it is fetching a person without the tag. Treated as a
 * handover: a visitor told "the team will reply" must reach the team.
 */
const HANDOVER_PROSE =
  /(?:pass(?:ing)?\s+(?:you\s+|this\s+|it\s+)?(?:on\s+)?to\s+(?:the|our)\s+team|connect(?:ing)?\s+you\s+(?:with|to)\s+(?:a|the|our)\s+(?:team|agent|colleague)|handing\s+(?:you|this)\s+over|transfer(?:ring)?\s+you\b(?!r)|team\s+se\s+connect|team\s+ko\s+(?:pass|forward|bhej|transfer|refer)\w*|team\s+(?:ke\s+)?hawal[ae])/i;

export interface ParsedAgentReply {
  /** The visitor-facing text, tags removed. Empty when the model wrote only tags. */
  text: string;
  /** 1-based [ARTICLE n] the model relied on, or null. */
  sourceIndex: number | null;
  handover: boolean;
  handoverReason: string | null;
}

export function parseAgentReply(raw: string): ParsedAgentReply {
  const source = Number(raw.match(SOURCE_TAG)?.[1]);
  const tag = raw.match(HANDOVER_TAG);
  const notCovered = NOT_COVERED_TAG.test(raw);
  const text = raw
    .replace(/\[(?:SOURCE|HANDOVER|NOT_COVERED|MISSING)[^\]]*\]/gi, '')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^\s)]+\)/g, '$1')
    .replace(/(?:^|\s)https?:\/\/\S+/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  const prose = !tag && HANDOVER_PROSE.test(text);
  const handover = Boolean(tag) || notCovered || prose;
  return {
    text,
    sourceIndex: Number.isInteger(source) && source >= 1 ? source : null,
    handover,
    handoverReason: handover
      ? (tag?.[1]?.trim() || (notCovered ? 'Not covered by the help center' : 'Agent said it is bringing in the team')).slice(0, 200)
      : null,
  };
}

/** The line the agent hears when the visitor says the last answer did not help. */
export const RETRY_SITUATION =
  'The customer says your previous answer did not help, or asked the same thing again. Re-read their messages, work out what they are really asking, and answer that more specifically and differently. If it is still unclear, ask exactly what is missing. Do not repeat your previous answer.';

export const UPSET_SITUATION =
  'The customer is upset. Open with one short, sincere acknowledgement, then help with substance. Hand over only if a person must act or they ask for one.';

export function accountSituation(refs: { orderNumber?: string | null; accountNumber?: string | null; email?: string | null }): string {
  const known = [
    refs.accountNumber ? `account ${refs.accountNumber}` : null,
    refs.orderNumber ? `order ${refs.orderNumber}` : null,
    refs.email ? `email ${refs.email}` : null,
  ].filter(Boolean);
  return [
    'This looks like a question about the customer\'s own account, order or payment, which you cannot see.',
    'Explain the rule that applies and what they can check. If a person must look it up or act on it, say the team will check it and add [HANDOVER: reason].',
    known.length
      ? `They gave: ${known.join(', ')}. Do not ask for these again.`
      : 'If you hand over, ask for their account number (or order id) and email in the same reply so the team can find them.',
  ].join(' ');
}
