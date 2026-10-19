import { serviceClient } from '@/lib/supabase/service';
import { autoAssignConversation } from '@/lib/team/auto-assign';
import { notifyTeamByEmailLater } from '@/lib/team/agent-notify';
import {
  answerFromHelpCenter,
  buildModelContext,
  helpCenterTopics,
  loadFullKnowledge,
  recordUnanswered,
  type CitableArticle,
  type RetrievalConfidence,
} from './help-answer';
import {
  accountSituation,
  buildSupportAgentPrompt,
  parseAgentReply,
  RETRY_SITUATION,
  UPSET_SITUATION,
} from './support-agent';
import {
  propFirmWelcome,
  routeSubAgent,
  SUB_AGENT_BY_ID,
  subAgentEnabled,
  type SubAgentId,
  type SubAgentSettings,
} from './sub-agents';
import { chat, isConfigured, ProviderError, type ProviderConfig } from './provider';
import { executePlatformAiReply, getPlatformAiConfigServerOnly } from './platform-gateway';
import { getWorkspaceEffectivePlan } from '@/lib/plans/enforce';
import {
  accountSpecificReply,
  asksForHuman,
  BOT_FRUSTRATION,
  FRUSTRATION_REASON,
  BUSINESS_HOURS_QUESTION,
  businessHoursReply,
  buildHandoverSummary,
  classifyVisitorIntent,
  cleanVisitorDisplayName,
  complaintApology,
  getExpectedReplyTimeNotice,
  LANGUAGE_LABEL,
  localized,
  noAnswerHandoverReply,
  outOfScopeReply,
  pendingUpdateReply,
  PROMISED_FOLLOW_UP,
  UPDATE_REQUEST,
  welcomeBackReply,
  replyLanguageOf,
  smallTalkReply,
  wantsHumanReply,
  type IntentClassificationResult,
  type ReplyLanguage,
  type VisitorIntent,
} from './intent';
import { lookupBotAnswerCache, saveBotAnswerCache } from './answer-cache';
import { jevGrounding, loadJevRuntime, type JevRuntime, type JevUsage } from './jev';
import { unsupportedFigures } from './figures';
import { prepareTraderLookup, type LookupStep } from './trader-data/lookup';
import { understandMessage } from './understanding';
import { assistRoute } from './router-assist';
import { withoutImageNote } from './vision';
import { tokenize } from './retrieval';
import { logAiEvent } from './bot-control';
import { pickPolicyArm, POLICY_ARMS, type PolicyArm } from './learning/policy';
import { generateEmbeddings } from './semantic-retrieval';
import { groundedChunkIndex } from './grounding';
import { checkWorkspaceBusinessHours } from '@/lib/business-hours';
import type { BusinessHoursConfig, Conversation } from '@/types/database';

export { cleanVisitorDisplayName };

export const REPETITION_OR_REJECTION =
  /\b(?:didn'?t\s+help|not\s+helpful|doesn'?t\s+work|does\s+not\s+help|still\s+not\s+working|still\s+broken|wrong\s+answer|not\s+what\s+i\s+asked|that\s+didn'?t\s+work|not\s+resolved|useless|ye\s+kaam\s+nahi\s+kar\s+raha|madad\s+nahi\s+mili)\b/i;

export const STRONG_FRUSTRATION =
  /\b(?:angry|pissed|furious|terrible|ridiculous|waste\s+of\s+time|useless|worst\s+customer\s+service|scam|hate\s+this|disaster|stop\s+wasting\s+my\s+time|disgusting|horrible|bakwas|fazool|ghatia)\b/i;

export function isAmbiguousQuestion(text: string): boolean {
  const cleaned = text.trim().toLowerCase().replace(/[?!.,]+$/g, '');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 3) return false;
  const ambiguousPhrases = new Set([
    'help', 'how', 'how to', 'how does it work', 'what', 'why', 'price',
    'pricing', 'it broke', 'broken', 'error', 'not working', 'issue',
    'problem', 'details', 'info', 'tell me', 'assist', 'account', 'login', 'features', 'plans'
  ]);
  return ambiguousPhrases.has(cleaned) || words.length <= 1;
}

export function clarifyingQuestion(lang: ReplyLanguage): string {
  return localized(lang, {
    en: "Could you tell me a bit more about what you're trying to do so I can find the right information for you?",
    roman_ur: "Kya aap thori mazeed tafseelat bata sakte hain ke aap kya karna chahte hain takay main sahi maloomat faraham kar sakoon?",
    ur: "کیا آپ تھوڑی مزید تفصیل بتا سکتے ہیں کہ آپ کیا کرنا چاہتے ہیں تاکہ میں آپ کے لیے درست معلومات فراہم کر سکوں؟",
    hi: "क्या आप थोड़ा और विवरण साझा कर सकते हैं कि आप क्या करना चाहते हैं ताकि मैं आपको सही जानकारी दे सकूँ?",
    ar: "هل يمكنك إخباري بالمزيد حول ما تحاول القيام به حتى أتمكن من العثور على المعلومات المناسبة لك؟",
    es: "¿Podrías darme un poco más de detalles sobre lo que intentas hacer para darte la información correcta?",
    fr: "Pourriez-vous m'en dire un peu plus sur ce que vous essayez de faire afin que je puisse vous trouver la bonne information ?",
  });
}

export function isCustomerRetry(incoming: string, conversationMessages: { role: string; content: string }[]): boolean {
  if (REPETITION_OR_REJECTION.test(incoming)) return true;
  const userTurns = conversationMessages.filter((m) => m.role === 'user');
  if (userTurns.length >= 2) {
    const prior = userTurns[userTurns.length - 2].content.trim().toLowerCase();
    const curr = incoming.trim().toLowerCase();
    if (prior === curr) return true;
  }
  return false;
}

export function buildRunningSummary(
  existingSummary: string | null | undefined,
  messagesToSummarize: { role: string; content: string }[]
): string {
  const points = messagesToSummarize
    .filter((m) => m.content && m.content.trim())
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Assistant'}: ${m.content.slice(0, 80).replace(/\s+/g, ' ')}`)
    .slice(-4);

  if (existingSummary && existingSummary.trim()) {
    return `${existingSummary.trim()}; ${points.join(' | ')}`.slice(0, 350);
  }
  return points.join(' | ').slice(0, 250);
}

export function formatHandoverCustomerMessage({
  lang,
  businessHours,
}: {
  lang: ReplyLanguage;
  businessHours?: BusinessHoursConfig | null;
}): string {
  const status = checkWorkspaceBusinessHours(businessHours);
  if (status.isOpen) {
    return localized(lang, {
      en: "I've passed this to our team. An agent will reply here shortly.",
      roman_ur: "Maine yeh hamari team ko bhej diya hai. Ek agent jald hi yahan rabta karega.",
      ur: "میں نے یہ ہماری سپورٹ ٹیم کو بھیج دیا ہے۔ ایک نمائندہ جلد ہی یہاں آپ سے رابطہ کرے گا۔",
      hi: "मैंने इसे हमारी टीम को भेज दिया है। एक एजेंट जल्द ही यहाँ जवाब देगा।",
      ar: "لقد قمت بتحويل هذا إلى فريقنا. سيقوم أحد الوكلاء بالرد هنا قريباً.",
      es: "He pasado esto a nuestro equipo. Un agente responderá aquí en breve.",
      fr: "J'ai transmis ceci à notre équipe. Un agent vous répondra ici sous peu.",
    });
  }

  return localized(lang, {
    en: `Our team is currently away (our hours are ${status.scheduleSummary}). Please leave your email address below, and an agent will reply as soon as we're back online!`,
    roman_ur: `Hamari team is waqt offline hai (hamare auqat ${status.scheduleSummary} hain). Barah-e-karam apna email neeche likhein, hum wapis aate hi jawab denge!`,
    ur: `ہماری ٹیم اس وقت دستیاب نہیں ہے (ہمارے دفتری اوقات ${status.scheduleSummary} ہیں)۔ براہ کرم اپنا ای میل درج کریں، ہم آن لائن ہوتے ہی آپ سے رابطہ کریں گے!`,
    hi: `हमारी टीम अभी उपलब्ध नहीं है (हमारा समय ${status.scheduleSummary} है)। कृपया अपना ईमेल नीचे छोड़ें, हम ऑनलाइन आते ही जवाब देंगे!`,
    ar: `فريقنا غير متاح حالياً (ساعات العمل لدينا هي ${status.scheduleSummary}). يرجى ترك بريدك الإلكتروني أدناه، وسنرد عليك بمجرد عودتنا!`,
    es: `Nuestro equipo no está disponible en este momento (nuestro horario es ${status.scheduleSummary}). Por favor, déjanos tu correo electrónico abajo y te responderemos tan pronto estemos en línea.`,
    fr: `Notre équipe est actuellement absente (nos horaires sont ${status.scheduleSummary}). Veuillez laisser votre adresse e-mail ci-dessous et un agent vous répondra dès notre retour !`,
  });
}

/**
 * Runs a short model call through whichever provider the workspace configured.
 * Returns null when nothing is configured or the call fails, which is every
 * caller's cue to use its own fallback.
 */
async function askModel(
  providerConfig: ProviderConfig | null | undefined,
  system: string,
  user: string,
  maxTokens = 700
): Promise<string | null> {
  const config = isConfigured(providerConfig)
    ? providerConfig
    : (await getPlatformAiConfigServerOnly()).config;
  if (!isConfigured(config)) return null;
  try {
    const res = await chat(config!, {
      system,
      messages: [{ role: 'user', content: user }],
      maxTokens,
      temperature: 0,
    });
    return res.text || null;
  } catch (err) {
    const e = err as ProviderError;
    console.warn(
      `[ai] ${e?.provider || 'provider'} call failed${e?.status ? ` (HTTP ${e.status})` : ''}: ${e?.message}`
    );
    return null;
  }
}

/** Models sometimes wrap JSON in prose or a code fence; take the payload. */
function parseJsonBlock<T>(text: string | null, opener: '[' | '{'): T | null {
  if (!text) return null;
  const closer = opener === '[' ? ']' : '}';
  const start = text.indexOf(opener);
  const end = text.lastIndexOf(closer);
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

export interface HelpDeskResponseResult {
  replyText: string;
  shouldHandover: boolean;
  handoverReason?: string;
  canAnswerFromDocs: boolean;
  intent?: VisitorIntent;
  /** Whether rules or the model chose the intent. */
  intentSource?: IntentClassificationResult['source'];
  /** Internal note for agents when handing over: the handover summary. */
  internalNote?: string | null;
  disableAi?: boolean;
  priority?: 'normal' | 'high' | 'urgent';
  /** The article a help-centre answer is based on. */
  citation?: CitableArticle | null;
  /** All cited articles used to answer the question. */
  citedArticles?: { id: string; title: string }[];
  /** IDs of articles cited in the response. */
  usedArticleIds?: string[];
  /** Retrieval confidence, for help-centre questions only. */
  retrievalConfidence?: RetrievalConfidence;
  /** Who wrote the answer: the built-in bot, or the workspace's own agent (LangGraph). */
  engine?: 'built_in' | 'external_agent';
  /** The retrieval-policy arm this help-centre reply was made under (learning/policy.ts). */
  policyArm?: PolicyArm;
  /** Agent mode: the specialist that answered (sub-agents.ts). */
  subAgent?: SubAgentId;
  /** Served from the answer cache: no retrieval decision was made. */
  cached?: boolean;
  /**
   * Short option chips shown below the bot's reply in the widget. Each chip
   * sends its value (or label when value is absent) as the visitor's next
   * message when clicked. Shown only until the visitor replies; disappear
   * after that automatically. Max 4 items; labels kept under 40 chars.
   */
  quickReplies?: Array<{ label: string; value?: string }> | null;
}

/* ── Help-centre answers ──────────────────────────────────────────────── */

/**
 * The offer of a person the bot used to make when the help centre had nothing
 * that fits. It now hands over straight away (noAnswerHandoverReply), but this
 * text is still in older conversations, and a "yes" to it must still come back
 * as `wants_human` (see HANDOFF_OFFER in intent.ts, which must keep matching
 * every one of these).
 */
export function lowConfidenceReply(lang: ReplyLanguage): string {
  return localized(lang, {
    en: "I couldn't find this in our help center, and I'd rather not guess. Would you like me to connect you with a team member?",
    roman_ur: 'Mujhe yeh hamare help center mein nahi mila, aur main andaza nahi lagana chahta. Kya main aapko team member se connect kar doon?',
    ur: 'مجھے یہ ہمارے ہیلپ سینٹر میں نہیں ملا، اور میں اندازہ نہیں لگانا چاہتا۔ کیا میں آپ کو ہماری سپورٹ ٹیم کے ممبر سے منسلک کر دوں؟',
    hi: 'मुझे यह हमारे सहायता केंद्र में नहीं मिला, और मैं अनुमान नहीं लगाना चाहता। क्या मैं आपको हमारी सहायता टीम के किसी सदस्य से जोड़ दूँ?',
    ar: 'لم أجد هذا في مركز المساعدة، ولا أريد التخمين. هل تريد أن أصلك بأحد أعضاء فريق الدعم؟',
    es: 'No encontré esto en nuestro centro de ayuda y prefiero no adivinar. ¿Quieres que te comunique con un miembro de nuestro equipo?',
    fr: "Je n'ai pas trouvé cela dans notre centre d'aide et je préfère ne pas deviner. Voulez-vous que je vous mette en contact avec un membre de notre équipe ?",
  });
}

/** "Source: [Title](url)" in the visitor's language; bold title without a URL. */
export function formatCitation(source: { title: string; url: string | null }, lang: ReplyLanguage): string {
  const label = localized(lang, { en: 'Source', ur: 'ماخذ', hi: 'स्रोत', ar: 'المصدر', es: 'Fuente' });
  const title = source.title.replace(/[[\]]/g, '');
  return source.url ? `${label}: [${title}](${source.url})` : `${label}: **${title}**`;
}

/**
 * Tidies a model's answer for the chat bubble. Links are removed because the
 * citation is added by code from the article that was actually retrieved; a
 * URL the model wrote may be one it invented.
 */
export function cleanModelAnswer(rawText: string): string {
  return rawText
    .replace(/\[(?:SOURCE|NOT_COVERED|HANDOVER|MISSING)[^\]]*\]/gi, '')
    .replace(/^#{1,6}\s+(.+)$/gm, '**$1**')
    .replace(/\[([^\]]+)\]\((?:https?:\/\/|mailto:)[^\s)]+\)/g, (_m, anchor: string) =>
      /read\s+(?:more|full)|mazeed|مزید|اقرأ|leer|lire|source|article/i.test(anchor) ? '' : anchor
    )
    .replace(/(?:^|\s)https?:\/\/\S+/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const SOURCE_TAG = /\[SOURCE:\s*(\d+)\s*\]/i;

export { groundedChunkIndex } from './grounding';

const NOT_COVERED_TAG = /\[(?:NOT_COVERED|HANDOVER)\b/i;
/** "[MISSING: weekend rules for 5k]": the part of the question the articles do not answer. */
const MISSING_TAG = /\[MISSING:\s*([^\]]{1,200})\]/i;

/** Added under a partial answer: the rest went to the team. */
export function partialAnswerHandoverLine(lang: ReplyLanguage): string {
  return localized(lang, {
    en: "For the rest of your question, I've passed it to our team and they'll reply here.",
    roman_ur: 'Aap ke sawal ka baaqi hissa main ne team ko bhej diya hai, woh yahin jawab denge.',
    ur: 'آپ کے سوال کا باقی حصہ میں نے ٹیم کو بھیج دیا ہے، وہ یہیں جواب دیں گے۔',
    hi: 'आपके सवाल का बाकी हिस्सा मैंने टीम को भेज दिया है, वे यहीं जवाब देंगे।',
    ar: 'لقد أرسلت باقي سؤالك إلى فريقنا، وسيردون عليك هنا.',
    es: 'He pasado el resto de tu pregunta a nuestro equipo y te responderán aquí.',
    fr: "J'ai transmis le reste de votre question à notre équipe, qui vous répondra ici.",
  });
}

export function buildHumanSupportSystemPrompt({
  botName,
  businessName,
  customInstructions,
  retrievedChunks,
}: {
  botName: string;
  businessName: string;
  customInstructions?: string | null;
  retrievedChunks: string;
}): string {
  const custom = customInstructions?.trim() ? `\n\n${customInstructions.trim()}` : '';
  return `You are ${botName}, a support team member at ${businessName}. Answer using only the information in the KNOWLEDGE section below. Write the way a friendly, competent support agent chats: short, clear, warm, and direct. Reply in the same language and style the customer writes in (including Roman Urdu if they use it). Usually 1-3 short sentences; use steps only when the customer needs to follow a process. Do not use headings, do not start with phrases like 'Great question' or 'I'd be happy to help', do not repeat the customer's question back, and do not mention 'the knowledge base', 'documents' or 'context'. If the customer is upset, acknowledge it briefly before helping. If the answer is not in KNOWLEDGE, or the customer asks for a human, or it concerns a refund, payment dispute or account-specific issue you cannot check, say you are passing them to the team and do not invent an answer. Never make up prices, policies, links or timelines. If asked directly whether you are an AI, answer honestly.${custom}

# OUTPUT RULES (the code that reads your reply depends on these)
- If the KNOWLEDGE does not answer the question at all, reply with exactly [NOT_COVERED] and nothing else.
- If it answers only part of the question (a message often asks several things), answer that part only, then add a last line [MISSING: what is not covered, in a few English words]. Never guess the missing part; the team will answer it.
- Always end your reply with [SOURCE: n], where n is the number of the [CHUNK n] you relied on most. It is removed before the customer sees the reply.
- Do not write links or URLs; the article link is added for you.

# HELP-CENTER ARTICLES
KNOWLEDGE:
${retrievedChunks}`;
}

interface HelpCenterInput {
  workspaceId: string;
  conversationId: string;
  incomingMessage: string;
  intent: IntentClassificationResult;
  lang: ReplyLanguage;
  brand: string;
  botName?: string;
  providerConfig?: ProviderConfig | null;
  systemPrompt?: string | null;
  history?: string[];
  conversationMessages: { role: 'user' | 'assistant'; content: string }[];
  helpCenterUrl?: string | null;
  isRetry?: boolean;
  runningSummary?: string | null;
  humanContext?: HumanContext | null;
  /** Jev, when the workspace has it in shadow or live mode. */
  jev?: JevRuntime | null;
  /** Scores at which the top passage counts as a direct answer; set by the policy arm. */
  highConfidence?: { similarity: number; combined: number };
}

/** The last public reply a person wrote in the current exchange. */
export interface HumanContext {
  lastReply: string;
  at: string;
}

/**
 * Added to the answer prompt when a person handled this exchange before the
 * bot (back on now) picked it up: the bot continues from them, it does not
 * restart, and it does not speak for them.
 */
export function carryOnInstruction(human?: HumanContext | null): string | null {
  const said = human?.lastReply?.replace(/\s+/g, ' ').trim();
  if (!said) return null;
  const clipped = said.length > 300 ? `${said.slice(0, 299)}…` : said;
  return [
    `A team member already handled this conversation. Their last reply was: "${clipped}"`,
    'Carry on from there: do not greet again or restart steps already done, do not contradict what they said or promised, and do not write as if you were them.',
    'Never say that something has happened (an update, a refund, a fix) unless the KNOWLEDGE says so.',
  ].join('\n');
}

/**
 * Answers a help-centre question from this workspace's published articles,
 * with a citation, or says it cannot and offers a person. The decision to
 * answer is made on retrieval confidence before any model is asked; a model
 * that then finds the articles do not cover the question, or names no source,
 * is treated the same as low confidence.
 */
/**
 * Jev's check of a model-written answer: is every fact in it stated in the
 * passages it was written from? Logged in both modes; only in live mode does a
 * low score stop the answer (it goes to the team instead, like any answer the
 * articles do not cover). Any Jev failure lets the answer through: the
 * existing citation checks already ran.
 */
async function jevRejectsAnswer(input: HelpCenterInput, answer: string, passages: string): Promise<boolean> {
  const jev = input.jev;
  if (!jev || !jev.settings.grounding || !passages.trim()) return false;
  let supported: number | null = null;
  let latencyMs: number | null = null;
  let usage: JevUsage | null = null;
  let error: string | null = null;
  try {
    const verdict = await jevGrounding(jev, { question: input.incomingMessage, answer, passages });
    supported = verdict.supported;
    latencyMs = verdict.latencyMs;
    usage = verdict.usage;
  } catch (err) {
    error = String((err as Error)?.message || err).slice(0, 200);
  }
  const reject = jev.settings.mode === 'live' && supported !== null && supported < jev.settings.minGrounding;
  void logAiEvent(serviceClient(), {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    event: 'jev_grounding',
    reason: error ? 'error' : reject ? 'blocked' : jev.settings.mode === 'live' ? 'passed' : 'shadow',
    detail: {
      mode: jev.settings.mode,
      supported: supported === null ? null : Math.round(supported * 1000) / 1000,
      threshold: jev.settings.minGrounding,
      // In shadow mode: would it have been stopped?
      would_block: supported !== null && supported < jev.settings.minGrounding,
      latency_ms: latencyMs,
      input_tokens: usage?.inputTokens ?? null,
      output_tokens: usage?.outputTokens ?? null,
      error,
    },
  });
  return reject;
}

/**
 * Answers under the workspace's current retrieval-policy arm and labels the
 * result with it, so the reward for what happens next goes to that arm.
 */
async function answerHelpCenterQuestion(input: HelpCenterInput): Promise<HelpDeskResponseResult> {
  const arm = await pickPolicyArm(input.workspaceId);
  const result = await answerHelpCenterQuestionUnder({ ...input, highConfidence: POLICY_ARMS[arm] });
  return result.cached ? result : { ...result, policyArm: arm };
}

async function answerHelpCenterQuestionUnder(input: HelpCenterInput): Promise<HelpDeskResponseResult> {
  const { workspaceId, conversationId, incomingMessage, intent, lang, brand, botName, providerConfig } = input;
  const apology = intent.isComplaint ? `${complaintApology(lang)} ` : '';

  // 1. Check per-workspace answer cache before retrieval
  let queryEmbedding: number[] | null = null;
  try {
    const embeddings = await generateEmbeddings([incomingMessage], providerConfig);
    queryEmbedding = embeddings[0] || null;
  } catch {}

  if (queryEmbedding && queryEmbedding.length > 0) {
    const cached = await lookupBotAnswerCache({
      workspaceId,
      queryEmbedding,
      similarityThreshold: 0.90,
    });
    if (cached) {
      console.log('[answer-cache] Cache hit for workspace:', workspaceId);
      return {
        replyText: `${apology}${cached.answerText}`,
        shouldHandover: false,
        canAnswerFromDocs: true,
        intent: intent.intent,
        intentSource: 'rules',
        disableAi: false,
        citation: cached.citation || null,
        citedArticles: cached.citation ? [{ id: cached.citation.id, title: cached.citation.title }] : [],
        usedArticleIds: cached.sourceArticleIds || [],
        retrievalConfidence: 'high',
        cached: true,
      };
    }
  }

  const context = await buildModelContext(workspaceId, incomingMessage, {
    history: input.history,
    turns: input.conversationMessages.slice(-6),
    limit: 5,
    providerConfig,
    helpCenterUrl: input.helpCenterUrl,
    articlesOnly: true,
    // Already paid for by the cache lookup; reused when the query is not rewritten.
    queryEmbedding,
    highConfidence: input.highConfidence,
  });

  // A one-word or vague message that matched nothing: one short clarifying
  // question rather than a handover. A medium match ("pricing") is answered.
  if (isAmbiguousQuestion(incomingMessage) && context.confidence === 'low') {
    return {
      replyText: `${apology}${clarifyingQuestion(lang)}`,
      shouldHandover: false,
      canAnswerFromDocs: false,
      intent: intent.intent,
      intentSource: intent.source,
      disableAi: false,
      citation: null,
      citedArticles: [],
      usedArticleIds: [],
      retrievalConfidence: 'low',
    };
  }

  // No answer: the question goes to the team at once, with a note saying what
  // was asked. The bot stays on so the visitor's next question still gets an
  // answer while they wait.
  const notAnswered = async (why: string, record = true): Promise<HelpDeskResponseResult> => {
    if (record) {
      await recordUnanswered(workspaceId, incomingMessage, why, conversationId, context.queryEmbedding || queryEmbedding);
    }
    return {
      replyText: `${apology}${noAnswerHandoverReply(lang)}`,
      shouldHandover: true,
      handoverReason: why,
      canAnswerFromDocs: false,
      intent: intent.intent,
      intentSource: intent.source,
      internalNote: buildHandoverSummary({
        intent: { ...intent, reason: `Not in the help center: ${why}` },
        message: incomingMessage,
        recentMessages: input.conversationMessages,
        lang,
      }),
      disableAi: false,
      priority: 'normal',
      citation: null,
      citedArticles: [],
      usedArticleIds: [],
      retrievalConfidence: 'low',
    };
  };

  const answered = (text: string, citation: CitableArticle, cache = true): HelpDeskResponseResult => {
    // Bot knowledge grounds answers but is private: it is never cited, named
    // in the article lists, or linked.
    const articleSources = context.sources.filter((s) => s.kind !== 'knowledge');
    const citedArticles = articleSources.map((s) => ({ id: s.id, title: s.title }));
    const usedArticleIds = Array.from(new Set(articleSources.map((s) => s.id)));
    const fromKnowledge = citation.kind === 'knowledge';

    // Save answer to per-workspace cache. Not when Bot knowledge was in the
    // context: the cache is invalidated by article edits only, so an answer
    // drawn from an entry would outlive a change to that entry.
    const usedKnowledge = articleSources.length !== context.sources.length || fromKnowledge;
    if (cache && (context.queryEmbedding || queryEmbedding) && usedArticleIds.length > 0 && !usedKnowledge) {
      saveBotAnswerCache({
        workspaceId,
        question: incomingMessage,
        queryEmbedding: (context.queryEmbedding || queryEmbedding)!,
        answerText: text,
        sourceArticleIds: usedArticleIds,
        citation,
      }).catch((err) => console.warn('[answer-cache] Save error:', err));
    }

    return {
      replyText: fromKnowledge ? `${apology}${text}` : `${apology}${text}\n\n${formatCitation(citation, lang)}`,
      shouldHandover: false,
      canAnswerFromDocs: true,
      intent: intent.intent,
      intentSource: intent.source,
      disableAi: false,
      citation: fromKnowledge ? null : citation,
      citedArticles,
      usedArticleIds,
      retrievalConfidence: context.confidence,
    };
  };

  // A message that asks several things, some of which the articles answer:
  // the visitor gets what the articles say now, and the rest goes to the team
  // (the bot stays on). Answering nothing because one part was missing threw
  // away answers that were right there; answering everything invented the
  // missing part.
  const partlyAnswered = async (text: string, citation: CitableArticle, missing: string): Promise<HelpDeskResponseResult> => {
    await recordUnanswered(workspaceId, incomingMessage, `Partly answered; not covered: ${missing}`, conversationId, context.queryEmbedding || queryEmbedding);
    const base = answered(text, citation, false);
    const reason = `Partly answered. Not in the help center: ${missing}`;
    return {
      ...base,
      replyText: `${base.replyText}\n\n${partialAnswerHandoverLine(lang)}`,
      shouldHandover: true,
      handoverReason: reason.slice(0, 200),
      internalNote: buildHandoverSummary({
        intent: { ...intent, reason },
        message: incomingMessage,
        recentMessages: input.conversationMessages,
        lang,
      }),
      disableAi: false,
      priority: 'normal',
    };
  };

  // Nothing retrieved at all: nothing for anyone to read.
  if (context.sources.length === 0) {
    return notAnswered('Help center has no article that fits (low retrieval confidence)');
  }
  // Retrieved, but the scores are not convincing. These used to go to the
  // team without the model ever seeing them, and they were mostly short,
  // misspelt or non-English questions whose answer was right there ("Instant
  // account rules", "kya stop loss lagana zaroori hai"). The model reads
  // them now and must either cite the passage it used or say [NOT_COVERED];
  // an uncited answer is not accepted at this confidence (see `cited` below).
  // Without a model there is nobody to read them.
  const lowConfidence = context.confidence === 'low';
  if (lowConfidence && !isConfigured(providerConfig)) {
    return notAnswered('Help center has no article that fits (low retrieval confidence)');
  }

  try {
    const system = buildHumanSupportSystemPrompt({
      botName: botName || 'Support Agent',
      businessName: brand,
      customInstructions:
        [input.systemPrompt?.trim(), carryOnInstruction(input.humanContext)].filter(Boolean).join('\n\n') || null,
      retrievedChunks: context.text,
    });

    const aiReply = await executePlatformAiReply({
      workspaceId,
      conversationId,
      providerConfig,
      request: {
        system,
        // The retrieval already resolved follow-ups; older turns only cost tokens.
        messages: input.conversationMessages.slice(-4),
        maxTokens: 300,
        temperature: 0.3,
        reasoning: 'fast',
        // Below the route's overall budget, so a slow provider falls back to
        // quoting the article instead of timing the whole reply out.
        timeoutMs: 15_000,
      },
    });

    if (!aiReply.ok) {
      if (aiReply.handoverTriggered) {
        return {
          replyText: `${apology}${aiReply.handoverMessage || "I'm connecting you with a member of our team who will assist you shortly."}`,
          shouldHandover: true,
          handoverReason: aiReply.unavailableReason || 'AI unavailable, connecting to human agent',
          canAnswerFromDocs: false,
          intent: intent.intent,
          intentSource: intent.source,
          disableAi: false,
          priority: 'normal',
        };
      }
      // If platform AI not yet configured or had provider issue, fall through to answerFromHelpCenter below
    } else {
      const raw = (aiReply.text || '').trim();

      if (raw) {
        // Models often add punctuation or a sentence around the tag, which
        // would otherwise reach the visitor as a near-empty "handover" bubble.
        if (NOT_COVERED_TAG.test(raw)) {
          return notAnswered('Articles retrieved, but they do not answer the question');
        }

        // Check if model politely indicated a handover
        const isHandoverText =
          /(?:pass(?:ing)?\s+(?:you\s+|this\s+|it\s+)?(?:on\s+)?to\s+(?:the|our)\s+team|connect(?:ing)?\s+you\s+with\s+(?:the|our)\s+team|connect(?:ing)?\s+you\s+to\s+(?:a|our)\s+team|handing\s+you\s+over|transfer(?:ring)?\s+you\b(?!r)|team\s+se\s+connect|team\s+se\s+rabta|kisi\s+agent\s+se|team\s+ko\s+(?:pass|forward|bhej|de|transfer|refer)\w*|team\s+(?:ke\s+)?hawal[ae])/i.test(
            raw
          );

        // A partial answer says the rest goes to the team; that is not a handover of the whole question.
        if (isHandoverText && !MISSING_TAG.test(raw)) {
          return {
            replyText: `${apology}${cleanModelAnswer(raw)}`,
            shouldHandover: true,
            handoverReason: 'Inquiry requires human assistance or not covered in knowledge',
            canAnswerFromDocs: false,
            intent: intent.intent,
            intentSource: intent.source,
            disableAi: false,
            priority: 'normal',
            citation: null,
            citedArticles: [],
            usedArticleIds: [],
          };
        }

        const n = Number(raw.match(SOURCE_TAG)?.[1]);
        const grounded = groundedChunkIndex(cleanModelAnswer(raw), context.text, lang);
        const cited =
          Number.isInteger(n) && n >= 1 && n <= context.sources.length
            ? context.sources[n - 1]
            : context.confidence === 'high'
            ? context.sources[0]
            : grounded !== null && grounded < context.sources.length
            ? context.sources[grounded]
            : null;
        const text = cleanModelAnswer(raw);
        if (!cited || !text) {
          // An answer that cannot say where it came from is a guess.
          return notAnswered('Model answer named no source');
        }
        // From passages that only loosely matched, a [SOURCE] tag is not
        // enough: the answer's own words and figures must be in one of them,
        // or it was written from somewhere else.
        if (lowConfidence && grounded === null) {
          return notAnswered('Low-confidence match, and the answer is not written from the articles');
        }
        // Prices, limits and payouts: every amount and percentage must be in
        // the articles or the conversation, or follow from them in one step.
        const invented = unsupportedFigures(
          text,
          [context.text, incomingMessage, ...input.conversationMessages.map((m) => m.content)].join('\n')
        );
        if (invented.length) {
          return notAnswered(`Answer states figures the articles do not have: ${invented.slice(0, 3).join(', ')}`);
        }
        if (await jevRejectsAnswer(input, text, context.text)) {
          return notAnswered('Jev: the drafted answer is not supported by the articles');
        }
        const missing = MISSING_TAG.exec(raw)?.[1]?.replace(/\s+/g, ' ').trim();
        return missing ? partlyAnswered(text, cited, missing) : answered(text, cited);
      }
    }
  } catch (err) {
    const e = err as ProviderError;
    console.warn(`[ai] platform model call failed: ${e?.message}. Answering from the articles directly.`);
  }

  // No model, or it failed: quote the article itself, and only when sure.
  const answer = await answerFromHelpCenter({
    workspaceId,
    conversationId,
    message: context.rewrittenQuery || incomingMessage,
    history: input.history,
    helpCenterUrl: input.helpCenterUrl,
    chunks: context.chunks,
    belowThreshold: context.belowThreshold,
    queryEmbedding: context.queryEmbedding,
    intent: intent.intent,
    providerConfig,
    articlesOnly: true,
    highConfidence: input.highConfidence,
  });

  if (answer.text && answer.article && answer.source !== 'note') {
    return answered(answer.text.trim(), {
      id: answer.article.id,
      title: answer.article.title,
      slug: answer.article.slug ?? null,
      url: answer.article.url ?? null,
      kind: answer.source === 'knowledge' ? 'knowledge' : 'article',
    });
  }
  // answerFromHelpCenter has already recorded the gap.
  return notAnswered(answer.reason, false);
}

/**
 * A short answer to a general question that has nothing to do with this
 * business ("what is 15% of 2000", "what does KYC mean"). Visitors who got
 * "I can only help with questions about X" for these felt ignored. The model
 * is told it knows nothing about the business, and anything that would need
 * the business's own facts comes back as [HANDOVER], so it cannot invent a
 * price or a policy. Null means no answer: no model, a failed call, or a
 * question for the team.
 */
async function answerGeneralQuestion({
  workspaceId,
  conversationId,
  incomingMessage,
  conversationMessages,
  lang,
  brand,
  botName,
  providerConfig,
}: {
  workspaceId: string;
  conversationId: string;
  incomingMessage: string;
  conversationMessages: { role: 'user' | 'assistant'; content: string }[];
  lang: ReplyLanguage;
  brand: string;
  botName?: string;
  providerConfig?: ProviderConfig | null;
}): Promise<string | null> {
  if (!isConfigured(providerConfig)) return null;
  const system = [
    `You are ${botName || 'the support assistant'} for ${brand}. You know nothing about ${brand} beyond its name.`,
    `- A general question (general knowledge, a definition, simple maths, everyday advice, how something works in general): answer it correctly in 1-3 short sentences.`,
    `- Anything that needs facts about ${brand} (its products, prices, policies, stock, locations, delivery, orders, accounts, staff), or that you are not sure of: reply with exactly [HANDOVER].`,
    '- Medical, legal or financial questions: general information only, and suggest a professional.',
    `- No headings, links or filler. Reply in ${LANGUAGE_LABEL[lang]}, matching how the customer writes.`,
  ].join('\n');
  try {
    const res = await executePlatformAiReply({
      workspaceId,
      conversationId,
      providerConfig,
      request: {
        system,
        messages: [...conversationMessages.slice(-3, -1), { role: 'user', content: incomingMessage }],
        maxTokens: 220,
        temperature: 0.2,
        reasoning: 'fast',
        timeoutMs: 12_000,
      },
    });
    const raw = (res.ok && res.text ? res.text : '').trim();
    if (!raw || NOT_COVERED_TAG.test(raw) || SOURCE_TAG.test(raw)) return null;
    return cleanModelAnswer(raw) || null;
  } catch (err) {
    console.warn('[ai] General answer failed:', (err as Error)?.message);
    return null;
  }
}

/* ── Agent mode ───────────────────────────────────────────────────────── */

interface SupportAgentInput {
  workspaceId: string;
  conversationId: string;
  incomingMessage: string;
  intent: IntentClassificationResult;
  lang: ReplyLanguage;
  brand: string;
  botName?: string;
  providerConfig?: ProviderConfig | null;
  systemPrompt?: string | null;
  conversationMessages: { role: 'user' | 'assistant'; content: string }[];
  helpCenterUrl?: string | null;
  humanContext?: HumanContext | null;
  businessHours?: BusinessHoursConfig | null;
  upset: boolean;
  isRetry: boolean;
  accountSpecific: boolean;
  /** The specialist the router picked, and the workspace's extra instructions for it. */
  subAgent: SubAgentId;
  subAgentInstructions?: string | null;
  /** The trader data lookup for this reply, when the specialist has one. */
  lookup?: Extract<LookupStep, { kind: 'answer' }> | null;
  /** Jev, when the platform has it on: checks the reply against its cited article. */
  jev?: JevRuntime | null;
}

/** "[ARTICLE n]" block n of the full-knowledge text (loadFullKnowledge), or ''. */
export function articleBlock(knowledgeText: string, n: number): string {
  const start = knowledgeText.indexOf(`[ARTICLE ${n}]`);
  if (start < 0) return '';
  const next = knowledgeText.indexOf('[ARTICLE ', start + 10);
  return knowledgeText.slice(start, next < 0 ? undefined : next).trim();
}

/** Room Jev is given (jevGrounding keeps 6,000 characters of passages). */
const JEV_PASSAGE_CHARS = 6_000;

/**
 * What Jev checks an agent-mode reply against. The model reads the whole
 * help centre and cites one article, but a reply often joins several (the
 * price from the pricing table, the rules from another); checked against the
 * cited article alone, a correct "Instant 5K is $24" was blocked (supported
 * 0.02) and the visitor got "I couldn't find the answer". So the cited
 * article comes first, then every article holding one of the reply's figures
 * ($24, 5K, 80%), then the articles closest in wording to the reply (a rule
 * stated without numbers), within Jev's budget.
 */
export function groundingPassages(knowledgeText: string, sourceIndex: number, reply: string): string {
  const blocks = knowledgeText.split(/(?=\[ARTICLE \d+\])/).map((b) => b.replace(/\n*---\s*$/, '').trim()).filter(Boolean);
  const cited = articleBlock(knowledgeText, sourceIndex).replace(/\n*---\s*$/, '').trim();
  const figures = [...new Set((reply.match(/\$?\d[\d,]*(?:\.\d+)?\s*(?:%|k\b|K\b)?/g) || []).map((f) => f.replace(/[\s,]/g, '').toLowerCase()))].filter((f) => f.length >= 2);
  const norm = (s: string) => s.replace(/[\s,]/g, '').toLowerCase();
  const withFigures = figures.length ? blocks.filter((b) => b !== cited && figures.some((f) => norm(b).includes(f))) : [];
  // Wording: how many of the reply's distinct content words each article holds.
  const replyTerms = new Set(tokenize(reply));
  const byWording = replyTerms.size
    ? blocks
        .filter((b) => b !== cited && !withFigures.includes(b))
        .map((b) => {
          const terms = new Set(tokenize(b));
          let shared = 0;
          for (const t of replyTerms) if (terms.has(t)) shared += 1;
          return { b, shared };
        })
        .filter((x) => x.shared >= Math.min(3, replyTerms.size))
        .sort((x, y) => y.shared - x.shared)
        .slice(0, 3)
        .map((x) => x.b)
    : [];
  const out: string[] = [];
  let used = 0;
  for (const b of [cited, ...withFigures, ...byWording]) {
    if (!b || used + b.length > JEV_PASSAGE_CHARS) continue;
    out.push(b);
    used += b.length;
  }
  return out.join('\n\n');
}

/** jevRejectsAnswer for an agent-mode reply; logged the same way, never blocks on a Jev failure. */
async function jevRejectsAgentReply(input: SupportAgentInput, answer: string, passages: string): Promise<boolean> {
  return jevRejectsAnswer(
    { jev: input.jev ?? null, incomingMessage: input.lookup?.question || input.incomingMessage, workspaceId: input.workspaceId, conversationId: input.conversationId } as HelpCenterInput,
    answer,
    passages
  );
}

/**
 * The rules' cleaned-up reading of a messy message (understanding.ts), as a
 * hint beside the customer's own words: "bhai 3 din se pyout nahi aaya" is
 * read as "3 days payout not received". Only when the reading changed
 * something, and the several questions in it when there are several. The
 * model still reads the original; the hint only stops it missing the point.
 */
function readingHint(message: string): string | null {
  const u = understandMessage(message);
  const changedWords = u.changed.length > 0 || u.core.split(' ').length < u.normalized.split(' ').length - 2;
  if (!changedWords && !u.parts.length) return null;
  const lines = [`Their latest message, cleaned up (a rough reading of typos, shorthand and Roman Urdu; may be imperfect): "${u.core.slice(0, 300)}".`];
  if (u.parts.length > 1) lines.push(`It asks ${u.parts.length} things: ${u.parts.map((p) => `"${p.slice(0, 120)}"`).join('; ')}. Answer each.`);
  return lines.join(' ');
}

/**
 * One reply in agent mode (see support-agent.ts for why it exists). Null
 * means agent mode could not answer (no help centre, no model, a failed call,
 * figures it could not back up twice) and the caller goes down the strict
 * path, which keeps its own handover rules.
 */
async function answerAsSupportAgent(input: SupportAgentInput): Promise<HelpDeskResponseResult | null> {
  const { workspaceId, conversationId, incomingMessage, intent, lang, brand } = input;
  const startedAt = Date.now();

  const specialist = SUB_AGENT_BY_ID[input.subAgent];
  let knowledge = await loadFullKnowledge(workspaceId, {
    helpCenterUrl: input.helpCenterUrl,
    priorityMatch: specialist.articleMatch,
  }).catch((err) => {
    console.warn('[Agent mode] Could not load the help center:', (err as Error)?.message);
    return null;
  });
  if (!knowledge || knowledge.sources.length === 0) return null;
  // Too big to read whole: what matches the question goes in first.
  if (knowledge.truncated) {
    try {
      const context = await buildModelContext(workspaceId, incomingMessage, {
        turns: input.conversationMessages.slice(-6),
        limit: 8,
        providerConfig: input.providerConfig,
        helpCenterUrl: input.helpCenterUrl,
        articlesOnly: true,
      });
      const priorityIds = context.sources.map((s) => (s.kind === 'knowledge' ? `knowledge:${s.id}` : s.id));
      knowledge = await loadFullKnowledge(workspaceId, { helpCenterUrl: input.helpCenterUrl, priorityIds });
    } catch (err) {
      console.warn('[Agent mode] Prioritising articles failed:', (err as Error)?.message);
    }
  }

  const situation = [
    input.upset ? UPSET_SITUATION : null,
    input.isRetry ? RETRY_SITUATION : null,
    input.accountSpecific ? accountSituation(intent) : null,
    intent.isUrgent ? 'The customer says this is urgent: be quick and concrete.' : null,
    carryOnInstruction(input.humanContext),
    input.lookup?.justVerified
      ? `The customer just gave the email their account is on. Now answer the question they asked before: "${input.lookup.question.replace(/\s+/g, ' ').slice(0, 300)}".`
      : null,
    input.lookup && !input.lookup.record
      ? "Looking up the customer's record failed just now: answer as you would without it, and hand over if a person must check."
      : null,
    readingHint(input.lookup?.question || incomingMessage),
  ].filter((s): s is string => Boolean(s));
  const record = input.lookup?.record
    ? { found: input.lookup.record.found, text: input.lookup.record.text, verifiedEmail: input.lookup.verifiedEmail }
    : null;

  const baseSystem = buildSupportAgentPrompt({
    botName: input.botName || 'Support Agent',
    businessName: brand,
    knowledge: knowledge.text,
    lang,
    customInstructions: input.systemPrompt,
    specialist: specialist.brief
      ? { name: specialist.name, brief: specialist.brief, instructions: input.subAgentInstructions }
      : null,
    situation,
    traderRecord: record,
  });
  // A figure from the trader's own record is not an invented one.
  const evidence = [knowledge.text, record?.text ?? '', ...input.conversationMessages.map((m) => m.content)].join('\n');

  // The route gives the whole reply 35 s, and the intent call may already
  // have used some: the first draft gets 18 s, a rewrite only what is left.
  const draft = async (system: string, timeoutMs = 18_000) =>
    executePlatformAiReply({
      workspaceId,
      conversationId,
      providerConfig: input.providerConfig,
      request: {
        system,
        // More turns than the strict path: understanding a short follow-up
        // ("aur 25k pe?") needs what came before it.
        messages: input.conversationMessages.slice(-8),
        maxTokens: 700,
        temperature: 0.3,
        reasoning: 'fast',
        timeoutMs,
      },
    });

  let reply;
  try {
    reply = await draft(baseSystem);
  } catch (err) {
    console.warn('[Agent mode] Model call failed:', (err as Error)?.message);
    return null;
  }
  if (!reply.ok) {
    if (reply.handoverTriggered) {
      return {
        replyText: reply.handoverMessage || "I'm connecting you with a member of our team who will assist you shortly.",
        shouldHandover: true,
        handoverReason: reply.unavailableReason || 'AI unavailable, connecting to human agent',
        canAnswerFromDocs: false,
        intent: intent.intent,
        intentSource: intent.source,
        disableAi: false,
        priority: 'normal',
      };
    }
    return null;
  }

  let parsed = parseAgentReply((reply.text || '').trim());
  // An amount or percentage that is not in the help centre or the chat is
  // the one thing a support agent must never make up. One rewrite, told
  // which figures; a second miss goes down the strict path.
  let invented = parsed.text ? unsupportedFigures(parsed.text, evidence) : [];
  const timeLeft = 26_000 - (Date.now() - startedAt);
  if (invented.length && timeLeft > 6_000) {
    try {
      const retry = await draft(
        `${baseSystem}\n\n# CORRECTION\nYour previous draft stated figures that are not in the HELP CENTER or the conversation: ${invented
          .slice(0, 5)
          .join(', ')}. Write the reply again using only figures stated there (or simple arithmetic on them, shown). If the figure the customer needs is not stated, say so.`,
        timeLeft
      );
      if (retry.ok && retry.text) {
        parsed = parseAgentReply(retry.text.trim());
        invented = parsed.text ? unsupportedFigures(parsed.text, evidence) : [];
      }
    } catch (err) {
      console.warn('[Agent mode] Rewrite failed:', (err as Error)?.message);
    }
  }
  if (invented.length) {
    console.warn('[Agent mode] Figures not in the help center, using the strict path:', invented.slice(0, 3));
    return null;
  }
  if (!parsed.text) return null;

  // Jev checks the reply against the article it cites (plus the trader's
  // record), the way it checks strict-path answers: the whole help centre is
  // too long for it, the cited article is what the reply claims to rest on.
  // Live and below the bar: the strict path answers instead.
  if (input.jev && parsed.sourceIndex) {
    const passagesFor = (p: typeof parsed) =>
      [groundingPassages(knowledge.text, p.sourceIndex ?? parsed.sourceIndex!, p.text), record?.text ?? ''].filter(Boolean).join('\n\n');
    if (await jevRejectsAgentReply(input, parsed.text, passagesFor(parsed))) {
      // One refusal is not the end: Jev sees only part of the help centre,
      // and falling to the strict path turned correct answers into "I
      // couldn't find this". The reply is written once more, held to the
      // HELP CENTER's own words and citing the article the facts are in,
      // and checked again (figures and Jev). Only a second refusal hands
      // the question to the strict path.
      const timeLeftForCheck = 26_000 - (Date.now() - startedAt);
      let recovered = false;
      if (timeLeftForCheck > 6_000) {
        try {
          const again = await draft(
            `${baseSystem}\n\n# CORRECTION\nA checker could not match your previous draft to the article you cited. Write the reply again stating only what the HELP CENTER says, in its own terms and figures, and end with [SOURCE: n] for the article that states the main fact. If the HELP CENTER does not say it, say so.`,
            timeLeftForCheck
          );
          if (again.ok && again.text) {
            const second = parseAgentReply(again.text.trim());
            const secondInvented = second.text ? unsupportedFigures(second.text, evidence) : ['(empty)'];
            if (second.text && !secondInvented.length && !(second.sourceIndex && (await jevRejectsAgentReply(input, second.text, passagesFor(second))))) {
              parsed = second;
              recovered = true;
            }
          }
        } catch (err) {
          console.warn('[Agent mode] Rewrite after the Jev check failed:', (err as Error)?.message);
        }
      }
      if (!recovered) {
        console.warn('[Agent mode] Jev: the reply is not supported by the help center, using the strict path.');
        return null;
      }
    }
  }

  const source = parsed.sourceIndex ? knowledge.sources[parsed.sourceIndex - 1] ?? null : null;
  const citation = source && source.kind !== 'knowledge' ? source : null;
  const articleIds = source && source.kind !== 'knowledge' ? [source.id] : [];
  const base: HelpDeskResponseResult = {
    replyText: citation ? `${parsed.text}\n\n${formatCitation(citation, lang)}` : parsed.text,
    shouldHandover: false,
    canAnswerFromDocs: Boolean(source),
    intent: intent.intent,
    intentSource: intent.source,
    disableAi: false,
    citation,
    citedArticles: citation ? [{ id: citation.id, title: citation.title }] : [],
    usedArticleIds: articleIds,
    retrievalConfidence: source ? 'high' : 'medium',
    // After answering a specific topic, offer a follow-up chip so the visitor
    // can either ask another common question or escalate — no typing needed.
    quickReplies: !parsed.handover
      ? [
          { label: '❓ Another question', value: 'I have another question.' },
          { label: '🧑‍💼 Talk to a person', value: 'I want to speak with a team member.' },
        ]
      : null,
  };
  if (!parsed.handover) return base;

  // A person has to act. The agent already said so in its own words; the bot
  // stays on so the visitor's other questions are still answered meanwhile.
  const reason = parsed.handoverReason || 'Agent mode: needs a person';
  const closed = !checkWorkspaceBusinessHours(input.businessHours).isOpen;
  if (/not covered/i.test(reason)) {
    await recordUnanswered(workspaceId, incomingMessage, reason, conversationId, null);
  }
  return {
    ...base,
    replyText: closed ? `${base.replyText}\n\n${formatHandoverCustomerMessage({ lang, businessHours: input.businessHours })}` : base.replyText,
    shouldHandover: true,
    handoverReason: reason,
    internalNote: [
      buildHandoverSummary({
        intent: { ...intent, reason },
        message: input.lookup?.question || incomingMessage,
        recentMessages: input.conversationMessages,
        lang,
      }),
      input.lookup?.verifiedEmail ? `Email verified in chat with a code: ${input.lookup.verifiedEmail}` : null,
    ]
      .filter(Boolean)
      .join('\n'),
    priority: intent.isUrgent ? 'urgent' : input.accountSpecific || input.upset ? 'high' : 'normal',
  };
}

/* ── Pipeline ─────────────────────────────────────────────────────────── */

/**
 * The bot's reply to one visitor message:
 *
 *   1. classify intent (rules, then the workspace's model when rules are unsure)
 *   2. route:
 *      small_talk           short reply in the visitor's language
 *      help_center_question cited answer from published articles, or an offer
 *                           of a person when retrieval confidence is low
 *      account_specific     hand over with a summary; ask for missing order /
 *                           account number and email
 *      out_of_scope         say what the bot covers; hand over with a summary
 *      wants_human          hand over with a summary
 *
 * The caller (the auto-respond route) stores the reply and runs the handover.
 */
/**
 * In agent mode every reply names the specialist behind it, for the inbox
 * label and the settings page; the routes that answer before the router runs
 * (spam, anger, repeated failures, plan limits) are Human handover when they
 * hand over and General otherwise.
 */
export async function generateHelpDeskResponseWithHandover(
  args: Parameters<typeof respondToVisitor>[0]
): Promise<HelpDeskResponseResult> {
  const result = await respondToVisitor(args);
  if (args.answerMode !== 'agent' || result.subAgent) return result;
  return {
    ...result,
    subAgent: result.shouldHandover ? 'human_handover' : result.intent === 'small_talk' ? 'greeting' : 'general',
  };
}

/** A specialist the workspace switched off: its topic goes to the team. */
export function teamHandlesTopicReply(lang: ReplyLanguage): string {
  const notice = getExpectedReplyTimeNotice(lang);
  return localized(lang, {
    en: `Our team handles this one personally, so I've passed your message to them. ${notice}`,
    roman_ur: `Ye cheez hamari team khud dekhti hai, is liye maine aapka message unhe bhej diya hai. ${notice}`,
    ur: `یہ معاملہ ہماری ٹیم خود دیکھتی ہے، اس لیے میں نے آپ کا پیغام انہیں بھیج دیا ہے۔ ${notice}`,
  });
}

async function respondToVisitor({
  workspaceId,
  conversationId,
  incomingMessage,
  visitorName,
  botName,
  providerConfig,
  systemPrompt,
  history,
  turns,
  helpCenterUrl,
  workspaceName,
  hasHumanReplied = false,
  botFailureCount = 0,
  runningSummary = null,
  businessHours = null,
  cannedGreeting = null,
  humanContext = null,
  resuming = false,
  answerMode = 'strict',
  subAgents = null,
}: {
  workspaceId: string;
  conversationId: string;
  incomingMessage: string;
  visitorName?: string;
  botName?: string;
  providerConfig?: ProviderConfig | null;
  systemPrompt?: string | null;
  history?: string[];
  turns?: { role: 'user' | 'assistant'; content: string }[];
  helpCenterUrl?: string | null;
  workspaceName?: string | null;
  /** A human agent has already replied in the current exchange. */
  hasHumanReplied?: boolean;
  botFailureCount?: number;
  runningSummary?: string | null;
  businessHours?: BusinessHoursConfig | null;
  cannedGreeting?: string | null;
  /** The last public reply a person wrote in this exchange, if any. */
  humanContext?: HumanContext | null;
  /** The bot was just switched back on and has not answered since. */
  resuming?: boolean;
  /** ai_settings.answer_mode: 'agent' reads the whole help centre (support-agent.ts). */
  answerMode?: 'agent' | 'strict';
  /** ai_settings.sub_agents: specialists switched off and their extra instructions. */
  subAgents?: SubAgentSettings | null;
}): Promise<HelpDeskResponseResult> {
  const brand = workspaceName?.trim() || 'our team';
  // The screenshot note (vision.ts) is English; the reply follows the visitor's own words.
  const lang = replyLanguageOf(withoutImageNote(incomingMessage) || incomingMessage);
  const name = cleanVisitorDisplayName(visitorName);

  const priorTurns = (turns && turns.length
    ? turns
    : (history || []).slice(0, 10).reverse().map((h) => ({ role: 'user' as const, content: h }))
  ).slice(-9);
  const conversationMessages = [...priorTurns, { role: 'user' as const, content: incomingMessage }].slice(-10);

  // 1. Enforce plan AI access and monthly limits
  const effective = await getWorkspaceEffectivePlan(workspaceId);
  const plan = effective.plan;

  if (effective.status === 'canceled' || effective.status === 'suspended' || effective.isTrialExpired || plan.ai_enabled === false) {
    return {
      replyText: formatHandoverCustomerMessage({ lang, businessHours }),
      shouldHandover: true,
      handoverReason: 'AI is disabled on current subscription plan.',
      canAnswerFromDocs: false,
      intent: 'wants_human',
      disableAi: true,
      priority: 'high',
    };
  }

  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    .toISOString()
    .split('T')[0];
  const { data: usageRow } = await serviceClient()
    .from('workspace_ai_usage')
    .select('replies_used')
    .eq('workspace_id', workspaceId)
    .eq('period_start', periodStart)
    .maybeSingle();

  const repliesUsed = usageRow?.replies_used ?? 0;
  if (plan.ai_monthly_reply_limit !== null && plan.ai_monthly_reply_limit !== undefined && repliesUsed >= plan.ai_monthly_reply_limit) {
    return {
      replyText: "Our AI assistant has reached its monthly reply limit. I'm connecting you with a team member who can help.",
      shouldHandover: true,
      handoverReason: `Monthly AI reply limit of ${plan.ai_monthly_reply_limit} reached (${repliesUsed} used).`,
      canAnswerFromDocs: false,
      intent: 'wants_human',
      disableAi: true,
      priority: 'high',
    };
  }

  const platform = await getPlatformAiConfigServerOnly();
  const activeConfig = isConfigured(providerConfig) ? providerConfig : platform.config;

  const jev = await loadJevRuntime();
  const intent = await classifyVisitorIntent({
    message: incomingMessage,
    recentMessages: conversationMessages,
    providerConfig: activeConfig,
    workspaceName: brand,
    topics: isConfigured(activeConfig) || jev ? await helpCenterTopics(workspaceId) : [],
    jev,
  });
  if (jev && intent.jev) {
    const v = intent.jev.verdict;
    void logAiEvent(serviceClient(), {
      workspaceId,
      conversationId,
      event: 'jev_intent',
      reason: intent.jev.used ? 'decided' : intent.jev.error ? 'error' : jev.settings.mode === 'live' ? 'below_confidence' : 'shadow',
      detail: {
        mode: jev.settings.mode,
        jev_intent: v?.intent ?? null,
        jev_confidence: v ? Math.round(v.confidence * 1000) / 1000 : null,
        wants_human: v ? Math.round(v.wantsHuman * 1000) / 1000 : null,
        very_upset: v ? Math.round(v.veryUpset * 1000) / 1000 : null,
        urgent: v ? Math.round(v.urgent * 1000) / 1000 : null,
        spam: v ? Math.round(v.spam * 1000) / 1000 : null,
        latency_ms: v?.latencyMs ?? null,
        input_tokens: v?.usage.inputTokens ?? null,
        output_tokens: v?.usage.outputTokens ?? null,
        error: intent.jev.error ?? null,
        final_intent: intent.intent,
        final_source: intent.source,
        // Only meaningful when someone else decided: did Jev agree?
        agreed: intent.jev.used || !v ? null : v.intent === intent.intent,
      },
    });
  }

  const handover = (
    replyText: string,
    opts: { disableAi: boolean; priority: 'normal' | 'high' | 'urgent'; reason?: string }
  ): HelpDeskResponseResult => ({
    replyText,
    shouldHandover: true,
    handoverReason: opts.reason || intent.reason,
    canAnswerFromDocs: false,
    intent: intent.intent,
    intentSource: intent.source,
    internalNote: buildHandoverSummary({
      intent: opts.reason ? { ...intent, reason: opts.reason } : intent,
      message: incomingMessage,
      recentMessages: conversationMessages,
      lang,
    }),
    disableAi: opts.disableAi,
    // Time-critical ("refund today") reaches the team as urgent, whatever the route.
    priority: intent.isUrgent ? 'urgent' : opts.priority,
  });

  // Spam or an advert: a fixed line, no model, nobody paged.
  if (intent.isSpam) {
    return {
      replyText: outOfScopeReply(lang, brand),
      shouldHandover: false,
      canAnswerFromDocs: false,
      intent: intent.intent,
      intentSource: intent.source,
      disableAi: false,
    };
  }

  // Agent mode needs a model; without one the strict path's rules apply.
  const agentMode = answerMode === 'agent' && isConfigured(activeConfig);

  // Never Frustrate Customer Rule 1: Immediate handover for anger or strong frustration.
  // In agent mode an upset customer with something to answer is answered,
  // with an apology ("this is unfair, why did my account fail?" deserves the
  // rule, not a queue); being fed up with the bot, or asking for a person,
  // still goes to the team.
  const isAngry = intent.isComplaint || STRONG_FRUSTRATION.test(incomingMessage);
  const agentTakesAnger = agentMode && !BOT_FRUSTRATION.test(incomingMessage) && !asksForHuman(incomingMessage);
  if (isAngry && !agentTakesAnger) {
    return handover(formatHandoverCustomerMessage({ lang, businessHours }), {
      disableAi: true,
      priority: 'urgent',
      reason: 'Customer expressed anger or strong frustration. Immediate handover.',
    });
  }

  // A person promised to come back with news and the visitor asks for it.
  // The bot cannot know whether the news has come: it says there is none yet
  // and puts the question in front of the team, staying on for anything else.
  if (humanContext && PROMISED_FOLLOW_UP.test(humanContext.lastReply) && UPDATE_REQUEST.test(incomingMessage)) {
    return handover(pendingUpdateReply(lang), {
      disableAi: false,
      priority: 'high',
      reason: `Visitor asked for the update a team member promised: "${humanContext.lastReply.replace(/\s+/g, ' ').slice(0, 160)}"`,
    });
  }

  // Never Frustrate Customer Rule 2: Hand over if bot has failed twice in one conversation
  if (botFailureCount >= 2) {
    return handover(formatHandoverCustomerMessage({ lang, businessHours }), {
      disableAi: true,
      priority: 'high',
      reason: 'Bot reached maximum attempts (2 failures) in this conversation.',
    });
  }

  // Never Frustrate Customer Rule 3: Rejection / Retry ("didn't help" or repeated question)
  const isRetry = isCustomerRetry(incomingMessage, conversationMessages);
  if (isRetry) {
    if (botFailureCount >= 1) {
      return handover(formatHandoverCustomerMessage({ lang, businessHours }), {
        disableAi: true,
        priority: 'high',
        reason: 'Customer repeated inquiry or indicated previous response did not help (2 failures).',
      });
    } else {
      // First retry: increment failure count on conversation so next failure hands over
      serviceClient()
        .from('conversations')
        .update({ bot_failure_count: 1 })
        .eq('id', conversationId)
        .then();
    }
  }

  // Opening hours are in the workspace's own calendar: no retrieval, no model.
  if (
    (intent.intent === 'help_center_question' || intent.intent === 'out_of_scope') &&
    businessHours?.enabled &&
    BUSINESS_HOURS_QUESTION.test(incomingMessage)
  ) {
    return {
      replyText: businessHoursReply(lang, checkWorkspaceBusinessHours(businessHours)),
      shouldHandover: false,
      canAnswerFromDocs: false,
      intent: intent.intent,
      intentSource: intent.source,
      disableAi: false,
    };
  }

  // Agent mode: the router (sub-agents.ts) hands the message to one
  // specialist. Greeting answers from templates, Human handover goes to the
  // switch below, and every other specialist is the model with its own
  // brief. Anger alone is not a request for a person. A null result (no help
  // centre, failed call, unbacked figures) falls through to the strict routes.
  if (agentMode) {
    const angerOnly = intent.intent === 'wants_human' && intent.reason === FRUSTRATION_REASON && agentTakesAnger;
    const ruled = routeSubAgent({
      message: incomingMessage,
      recent: conversationMessages,
      intent: intent.intent,
      asksForHuman: intent.intent === 'wants_human' && !angerOnly,
    });
    // A tie between topics, or no topic at all: Jev, then the model, may
    // pick instead (router-assist.ts). Clear routes cost nothing extra.
    const route = await assistRoute({
      workspaceId,
      conversationId,
      message: incomingMessage,
      recent: conversationMessages,
      route: ruled,
      jev,
      providerConfig: activeConfig,
      enabled: (id) => subAgentEnabled(subAgents, id),
    });
    // Trader data (trader-data/lookup.ts): a verification in progress takes
    // the email or code first, and a lookup specialist gets the trader's
    // record. Without a connection this is `none` and nothing changes.
    const step: LookupStep =
      route.agent === 'human_handover'
        ? { kind: 'none' }
        : await prepareTraderLookup({
            workspaceId,
            conversationId,
            message: incomingMessage,
            routedAgent: route.agent,
            enabled: (id) => subAgentEnabled(subAgents, id),
            lang,
            brand,
          });
    if (step.kind === 'reply') {
      if (step.handover) {
        return { ...handover(step.text, { disableAi: false, priority: 'high', reason: step.handover }), subAgent: step.subAgent };
      }
      return {
        replyText: step.text,
        shouldHandover: false,
        canAnswerFromDocs: false,
        intent: intent.intent,
        intentSource: intent.source,
        disableAi: false,
        subAgent: step.subAgent,
      };
    }
    const lookup = step.kind === 'answer' ? step : null;
    if (lookup) {
      const reply = await answerAsSupportAgent({
        workspaceId,
        conversationId,
        incomingMessage,
        intent,
        lang,
        brand,
        botName,
        providerConfig: activeConfig,
        systemPrompt,
        conversationMessages,
        helpCenterUrl,
        humanContext,
        businessHours,
        upset: isAngry,
        isRetry,
        accountSpecific: true,
        subAgent: lookup.subAgent,
        subAgentInstructions: subAgents?.[lookup.subAgent]?.instructions ?? null,
        lookup,
        jev,
      });
      if (reply) return { ...reply, subAgent: lookup.subAgent };
      // After a code the visitor's message is only digits: the strict path
      // has nothing to answer, so the team takes the original question.
      if (lookup.justVerified) {
        return {
          ...handover(formatHandoverCustomerMessage({ lang, businessHours }), {
            disableAi: false,
            priority: 'high',
            reason: `Trader verified their email; ${SUB_AGENT_BY_ID[lookup.subAgent].name} could not answer: "${lookup.question.slice(0, 160)}"`,
          }),
          subAgent: lookup.subAgent,
        };
      }
    }

    const specialist = SUB_AGENT_BY_ID[route.agent];

    if (route.agent === 'greeting' && intent.intent === 'small_talk') {
      const ongoing = resuming || Boolean(humanContext) || priorTurns.some((t) => t.role === 'assistant');
      const greeting = intent.smallTalkKind === 'greeting' || !intent.smallTalkKind;
      const text = greeting && ongoing
        ? welcomeBackReply(lang)
        : greeting
        ? cannedGreeting || propFirmWelcome(lang, brand, name)
        : smallTalkReply(intent.smallTalkKind ?? 'greeting', lang, brand, name, null, incomingMessage);
      // On a fresh greeting show topic chips so the visitor can jump to what they need
      // without typing. Shown only on greetings, not on thanks/bye/other small talk.
      const greetingQuickReplies: Array<{ label: string; value: string }> | null =
        greeting && !ongoing
          ? [
              { label: '💰 Pricing & Plans', value: 'What are the challenge prices and account sizes?' },
              { label: '📋 Trading Rules', value: 'What are the trading rules and drawdown limits?' },
              { label: '💸 Payouts', value: 'How and when can I request a payout?' },
              { label: '🧑‍💼 Talk to a person', value: 'I want to speak with a team member.' },
            ]
          : null;
      return {
        replyText: text,
        shouldHandover: false,
        canAnswerFromDocs: false,
        intent: intent.intent,
        intentSource: intent.source,
        disableAi: false,
        subAgent: 'greeting',
        quickReplies: greetingQuickReplies,
      };
    }

    // A specialist the workspace switched off: its topic is the team's.
    if (specialist.engine === 'model' && !subAgentEnabled(subAgents, route.agent)) {
      return {
        ...handover(teamHandlesTopicReply(lang), {
          disableAi: false,
          priority: intent.intent === 'account_specific' ? 'high' : 'normal',
          reason: `${specialist.name} specialist is switched off: the team answers these`,
        }),
        subAgent: route.agent,
      };
    }

    if (specialist.engine === 'model' && !lookup) {
      const reply = await answerAsSupportAgent({
        workspaceId,
        conversationId,
        incomingMessage,
        intent,
        lang,
        brand,
        botName,
        providerConfig: activeConfig,
        systemPrompt,
        conversationMessages,
        helpCenterUrl,
        humanContext,
        businessHours,
        upset: isAngry,
        isRetry,
        accountSpecific: intent.intent === 'account_specific',
        subAgent: route.agent,
        subAgentInstructions: subAgents?.[route.agent]?.instructions ?? null,
        jev,
      });
      if (reply) return { ...reply, subAgent: route.agent };
    }
  }

  switch (intent.intent) {
    case 'small_talk': {
      // The welcome is for a new conversation. "hi" in one that is already
      // going, or that a person handled before the bot came back, is not.
      const ongoing = resuming || Boolean(humanContext) || priorTurns.some((t) => t.role === 'assistant');
      const greeting = intent.smallTalkKind === 'greeting' || !intent.smallTalkKind;
      const text = greeting && ongoing
        ? welcomeBackReply(lang)
        : cannedGreeting && greeting
        ? cannedGreeting
        : smallTalkReply(intent.smallTalkKind ?? 'greeting', lang, brand, name, null, incomingMessage);
      const strictGreetingQuickReplies: Array<{ label: string; value: string }> | null =
        greeting && !ongoing
          ? [
              { label: '💰 Pricing & Plans', value: 'What are the challenge prices and account sizes?' },
              { label: '📋 Trading Rules', value: 'What are the trading rules and drawdown limits?' },
              { label: '💸 Payouts', value: 'How and when can I request a payout?' },
              { label: '🧑‍💼 Talk to a person', value: 'I want to speak with a team member.' },
            ]
          : null;
      return {
        replyText: text,
        shouldHandover: false,
        canAnswerFromDocs: false,
        intent: intent.intent,
        intentSource: intent.source,
        disableAi: false,
        quickReplies: strictGreetingQuickReplies,
      };
    }

    case 'wants_human':
      // The bot steps aside until the conversation is resolved.
      return handover(wantsHumanReply(lang, hasHumanReplied), { disableAi: true, priority: 'high' });

    case 'account_specific': {
      const baseReply = accountSpecificReply(lang, intent);
      const bStatus = checkWorkspaceBusinessHours(businessHours);
      const fullReply = bStatus.isOpen ? baseReply : `${baseReply}\n\n${formatHandoverCustomerMessage({ lang, businessHours })}`;
      return handover(fullReply, { disableAi: false, priority: 'high' });
    }

    case 'out_of_scope': {
      const general = await answerGeneralQuestion({
        workspaceId,
        conversationId,
        incomingMessage,
        conversationMessages,
        lang,
        brand,
        botName,
        providerConfig: activeConfig,
      });
      if (general) {
        return {
          replyText: general,
          shouldHandover: false,
          canAnswerFromDocs: false,
          intent: intent.intent,
          intentSource: intent.source,
          disableAi: false,
        };
      }
      // The bot stays on: the visitor's next message may well be in scope.
      // With a model that declined, the question needs this business's facts.
      return handover(isConfigured(activeConfig) ? noAnswerHandoverReply(lang) : outOfScopeReply(lang, brand), {
        disableAi: false,
        priority: 'normal',
      });
    }

    case 'help_center_question':
    default:
      return answerHelpCenterQuestion({
        workspaceId,
        conversationId,
        incomingMessage,
        intent,
        lang,
        brand,
        botName,
        providerConfig: activeConfig,
        systemPrompt,
        history,
        conversationMessages,
        helpCenterUrl,
        isRetry,
        runningSummary,
        humanContext,
        jev,
      });
  }
}

/**
 * Backward compatibility wrapper returning reply text
 */
export async function generateAutoFirstResponse(params: {
  workspaceId: string;
  conversationId: string;
  incomingMessage: string;
  visitorName?: string;
  providerConfig?: ProviderConfig | null;
  systemPrompt?: string | null;
  history?: string[];
  turns?: { role: 'user' | 'assistant'; content: string }[];
  helpCenterUrl?: string | null;
  workspaceName?: string | null;
}): Promise<string> {
  const result = await generateHelpDeskResponseWithHandover(params);
  return result.replyText;
}

/**
 * Executes a seamless handover to human agents:
 * - Updates conversation: status = 'open', priority = 'high', ai_mode = 'disabled'
 * - Inserts internal note: '🤖 [AI Handover]: Transferred to human agent. Reason: ...'
 * - Auto-assigns to an online human agent if auto-assignment is enabled
 */
export async function executeHandoverToHuman({
  supabase,
  conversationId,
  workspaceId,
  reason,
  channel = 'web',
  visitorMessageId,
  disableAi = false,
  pausedReason = 'needs_attention',
  internalNote,
  priority = 'high',
  controlVersion = null,
  announce = true,
}: {
  supabase: ReturnType<typeof serviceClient>;
  conversationId: string;
  workspaceId: string;
  reason: string;
  channel?: string;
  visitorMessageId?: string;
  disableAi?: boolean;
  /** Why the bot steps aside, when `disableAi`: the visitor asked, or it cannot help. */
  pausedReason?: 'human_requested' | 'needs_attention';
  internalNote?: string | null;
  priority?: 'normal' | 'high' | 'urgent';
  /**
   * The conversation's ai_control_version when the bot started on this
   * message. If a person took over since, the visitor is not told anything.
   */
  controlVersion?: number | null;
  /**
   * Post the "we've passed this to our team" notice. False when the bot's own
   * reply already told the visitor; two messages saying the same was noise.
   */
  announce?: boolean;
}) {
  try {
    // 0. Idempotency guard: refuse to create a second handover note for the same visitor message
    if (visitorMessageId) {
      const { data: existingHandover } = await supabase
        .from('messages')
        .select('id')
        .eq('conversation_id', conversationId)
        .eq('is_internal', true)
        .or(`reply_to_message_id.eq.${visitorMessageId},metadata->>handover_for_message_id.eq.${visitorMessageId}`)
        .limit(1);

      if (existingHandover && existingHandover.length > 0) {
        console.log(`[executeHandoverToHuman] Handover note already exists for visitor message ${visitorMessageId}. Skipping duplicate note.`);
        return;
      }
    }

    // 0b. One visible handover per exchange. A visitor who asks three
    // uncovered questions in a row should not be told three times that they
    // were passed to the team; agents are already notified.
    const [{ data: recent }, { data: convRow }] = await Promise.all([
      supabase
        .from('messages')
        .select('sender_type, is_internal, sender_id, metadata, created_at')
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: false })
        .limit(30),
      supabase.from('conversations').select('*').eq('id', conversationId).maybeSingle(),
    ]);
    const resolvedAt = Date.parse((convRow as any)?.last_resolved_at || '') || -Infinity;
    const alreadyHandedOver = (() => {
      for (const m of recent || []) {
        // Earlier exchanges (before the last resolution) do not count.
        if (Date.parse(m.created_at) <= resolvedAt) return false;
        // A human reply since the last handover means this is a new handover.
        if (m.sender_type === 'agent' && !m.is_internal && m.sender_id) return false;
        if (m.metadata?.system_event === 'handover' || m.metadata?.is_handover) return true;
      }
      return false;
    })();

    // A person took the conversation over while the bot was working on it:
    // the team already has it, and the visitor must not hear from the bot.
    const control = (convRow ?? null) as Pick<Conversation, 'ai_control_version' | 'ai_paused_reason' | 'ai_needs_attention_at'> | null;
    const humanTookOver =
      control != null &&
      ((controlVersion != null &&
        typeof control.ai_control_version === 'number' &&
        control.ai_control_version !== controlVersion) ||
        control.ai_paused_reason === 'human_reply' ||
        control.ai_paused_reason === 'agent_paused');

    // 1. Escalate conversation in Supabase
    const now = new Date().toISOString();
    const updatePayload: Record<string, any> = {
      status: 'open',
      priority,
      updated_at: now,
    };
    if (disableAi && !humanTookOver) {
      updatePayload.ai_mode = 'disabled'; // Disables AI auto-replies on this conversation
      updatePayload.ai_paused_reason = pausedReason;
      // Recorded so a later resolution knows the switch-off predates it.
      updatePayload.channel_metadata = {
        ...(((convRow as any)?.channel_metadata as Record<string, any>) || {}),
        ai_disabled_at: now,
      };
    } else if (!disableAi && control && 'ai_needs_attention_at' in control) {
      // The bot stays on, but the inbox shows the conversation needs someone.
      updatePayload.ai_needs_attention_at = now;
    }

    const { error: escalateErr } = await supabase
      .from('conversations')
      .update(updatePayload)
      .eq('id', conversationId);
    if (escalateErr) console.error('[executeHandoverToHuman] Could not escalate the conversation:', escalateErr.message);

    if (alreadyHandedOver && !disableAi) {
      return;
    }

    // 2. Give it to the right person first (the one on shift; see
    // auto-assign.ts), so the note can say who has it and their dashboard can
    // alert them by name. A conversation already with someone suitable stays
    // with them.
    let assignment: Awaited<ReturnType<typeof autoAssignConversation>> | null = null;
    if (!humanTookOver) {
      try {
        assignment = await autoAssignConversation(serviceClient(), conversationId, { keepAssignee: true });
      } catch (e) {
        console.warn('[Auto-Assign Error during Handover]:', e);
      }
    }
    let assignedTo = assignment?.assigned ? (assignment.agent ?? null) : null;

    // Fallback: if nobody is strictly online or on shift, assign the best active workspace agent
    if (!assignedTo && !humanTookOver) {
      try {
        const { data: fallbackAgents } = await supabase
          .from('agents')
          .select('id, name, email, avatar_url, status, role, is_active')
          .eq('workspace_id', workspaceId)
          .neq('is_active', false)
          .neq('role', 'light_agent');

        if (fallbackAgents && fallbackAgents.length > 0) {
          const rank = (s: string | null) => (s === 'online' ? 0 : s === 'away' ? 1 : 2);
          const sorted = [...fallbackAgents].sort((a, b) => rank(a.status) - rank(b.status));
          const chosen = sorted[0];
          assignedTo = {
            id: chosen.id,
            name: chosen.name,
            email: chosen.email,
            avatar_url: chosen.avatar_url,
          };
          await supabase
            .from('conversations')
            .update({ assigned_agent_id: chosen.id, updated_at: now })
            .eq('id', conversationId);
        }
      } catch (fbErr) {
        console.warn('[Fallback Agent Selection Error]:', fbErr);
      }
    }

    // 3. Private note for the team: why the bot stepped aside and who has it.
    const who = assignedTo
      ? `\nAssigned to ${assignedTo.name || assignedTo.email || 'a teammate'}${assignment?.basis === 'on_shift' ? ' (on shift)' : ''}.`
      : '\nNobody is on shift or online right now: the team was emailed.';
    const noteContent = (internalNote || `🤖 The bot could not answer this, so it needs a person.\nReason: ${reason}`) + who;

    const { error: insertErr } = await supabase.from('messages').insert({
      conversation_id: conversationId,
      sender_type: 'ai',
      content: noteContent,
      is_internal: true,
      reply_to_message_id: visitorMessageId || null,
      metadata: {
        is_handover: true,
        handover_for_message_id: visitorMessageId || null,
        reason,
        priority,
        // Read by the dashboard to alert this person (everyone when null).
        assigned_agent_id: assignedTo?.id ?? null,
        assigned_agent_name: assignedTo?.name ?? null,
      },
    });

    if (insertErr) {
      if ((insertErr as any).code === '23505') {
        console.log(`[executeHandoverToHuman] Handover note already exists for visitor message ${visitorMessageId} (unique violation). Skipping.`);
        return { assignedAgent: assignedTo };
      }
      throw insertErr;
    }

    // 2b. Visitor-visible system event. The widget turns it into
    // "We've passed this to our team. We usually reply within … We'll also
    // email you at …" using the reply time and the visitor's own email.
    if (channel === 'web' && announce && !humanTookOver) {
      const { data: wsRow } = await supabase
        .from('workspaces')
        .select('business_hours')
        .eq('id', workspaceId)
        .maybeSingle();

      const bStatus = checkWorkspaceBusinessHours(wsRow?.business_hours);
      const handoverNotice = bStatus.isOpen
        ? "We've passed this to our team."
        : `Our team is currently away (our hours are ${bStatus.scheduleSummary}). Please leave your email address so we can follow up with you.`;

      await supabase.from('messages').insert({
        conversation_id: conversationId,
        sender_type: 'ai',
        content: handoverNotice,
        is_internal: false,
        metadata: {
          system_event: 'handover',
          handover_for_message_id: visitorMessageId || null,
          is_offline: !bStatus.isOpen,
          schedule_summary: bStatus.scheduleSummary,
          assigned_agent_id: assignedTo?.id ?? null,
          assigned_agent_name: assignedTo?.name ?? null,
          assigned_agent_avatar: assignedTo?.avatar_url ?? null,
        },
      });
    }

    // 4. Email the team (after assignment, so an on-shift assignee is told
    // alone). Not when a person already took the conversation over.
    if (!humanTookOver) {
      notifyTeamByEmailLater({ workspaceId, conversationId, event: 'handover', reason });
    }

    return { assignedAgent: assignedTo };
  } catch (err: any) {
    if (err?.code === '23505') {
      return { assignedAgent: null };
    }
    console.error('[executeHandoverToHuman Error]:', err.message);
    return { assignedAgent: null };
  }
}

/**
 * 2. AI Suggested Replies (Returns 2-3 contextual drafts for an agent)
 */
export async function generateSuggestedReplies({
  incomingMessage,
  conversationHistory,
  visitorName,
  providerConfig,
}: {
  incomingMessage: string;
  conversationHistory?: Array<{ sender_type: string; content: string }>;
  visitorName?: string;
  providerConfig?: ProviderConfig | null;
}): Promise<Array<{ title: string; text: string }>> {
  {
    {
      const historySummary = (conversationHistory || [])
        .slice(-6)
        .map((m) => `${m.sender_type.toUpperCase()}: ${m.content}`)
        .join('\n');

      const prompt = `You are assisting a customer support agent.
Customer: "${visitorName || 'Customer'}"
Recent conversation context:
${historySummary || `VISITOR: ${incomingMessage}`}

Generate exactly 3 diverse, contextual suggested replies the agent can choose from:
1. A direct solution/confirmation
2. A friendly troubleshooting/explanatory guide
3. A polite follow-up asking for more details

Reply with a JSON array of objects with keys "title" (2-3 words) and "text" (the message). JSON only.`;

      const parsed = parseJsonBlock<Array<{ title: string; text: string }>>(
        await askModel(providerConfig, 'You write concise customer support replies.', prompt, 800),
        '['
      );
      if (Array.isArray(parsed) && parsed.length) return parsed;
    }
  }

  // Heuristic Fallback drafts
  return [
    {
      title: 'Quick Resolution',
      text: `Hi ${visitorName || 'there'}! I've checked into this for you and updated your settings. Everything is good to go now!`,
    },
    {
      title: 'Step-by-Step Help',
      text: `Hello! You can easily accomplish this by navigating to your Account Settings and clicking the Verification tab.`,
    },
    {
      title: 'Ask for Details',
      text: `Thanks for reaching out! Could you please provide your account email or order number so I can look into this immediately?`,
    },
  ];
}

/**
 * 3. Auto-Tagging (Suggests tags based on conversation content)
 */
export async function generateAutoTags({
  content,
  existingTags,
  providerConfig,
}: {
  content: string;
  existingTags?: string[];
  providerConfig?: ProviderConfig | null;
}): Promise<string[]> {
  {
    {
      const prompt = `Analyze this customer support conversation message and extract 1 to 3 relevant tags.
Message: "${content}"
Standard categories to pick from: Billing, Bug, Refund, VIP, Feature Request, Sales Lead, Account Access, Urgent, Setup, General.

Output ONLY a comma-separated list of tags, for example: "Billing, Refund"`;

      const text = await askModel(
        providerConfig,
        'You label customer support conversations. Reply with tags only.',
        prompt,
        60
      );
      if (text) {
        const tags = text
          .split(',')
          .map((t) => t.trim().replace(/^#/, ''))
          // A model that ignores the format instruction can return a sentence;
          // a 40-character "tag" is not one, and would look broken on a chip.
          .filter((t) => t.length > 0 && t.length <= 24)
          .slice(0, 3);
        if (tags.length) {
          return Array.from(new Set([...(existingTags || []), ...tags]));
        }
      }
    }
  }

  // Keyword heuristic fallback
  const text = content.toLowerCase();
  const tags: string[] = [...(existingTags || [])];

  if (text.includes('refund') || text.includes('cancel') || text.includes('money back')) tags.push('Refund');
  if (text.includes('bill') || text.includes('invoice') || text.includes('charge') || text.includes('card') || text.includes('price')) tags.push('Billing');
  if (text.includes('bug') || text.includes('error') || text.includes('broken') || text.includes('failed') || text.includes('crash')) tags.push('Bug');
  if (text.includes('urgent') || text.includes('asap') || text.includes('emergency')) tags.push('Urgent');
  if (text.includes('buy') || text.includes('purchase') || text.includes('enterprise') || text.includes('demo')) tags.push('Sales Lead');

  // No catch-all tag: a label every conversation carries is not a label.
  return Array.from(new Set(tags)).slice(0, 4);
}

/**
 * 4. Conversation Summary (Generates 2-line summary for long threads)
 */
export async function generateConversationSummary({
  messages,
  visitorName,
  providerConfig,
}: {
  messages: Array<{ sender_type: string; content: string }>;
  visitorName?: string;
  providerConfig?: ProviderConfig | null;
}): Promise<string> {
  {
    {
      const threadText = messages
        .map((m) => `${m.sender_type.toUpperCase()}: ${m.content}`)
        .join('\n');

      const prompt = `Summarize this support conversation in exactly 2 concise lines (under 25 words total).
Customer: ${visitorName || 'Visitor'}
Thread:
${threadText}

Format:
Line 1: Customer inquired about [issue].
Line 2: Status / resolution [status].`;

      const text = await askModel(
        providerConfig,
        'You summarise support conversations in two short lines.',
        prompt,
        160
      );
      if (text) return text.trim();
    }
  }

  // Fallback summary generator
  const visitorMsgs = messages.filter((m) => m.sender_type === 'visitor');
  const lastVisitor = visitorMsgs[visitorMsgs.length - 1]?.content || 'general inquiry';
  const hasAgentReply = messages.some((m) => m.sender_type === 'agent' || m.sender_type === 'ai');

  return `Customer inquired about: "${lastVisitor.slice(0, 60)}..."\n${hasAgentReply ? 'Agent replied with instructions. Awaiting customer follow-up.' : 'Awaiting agent first response.'}`;
}

export interface SentimentResult {
  sentiment: 'positive' | 'neutral' | 'negative';
  confidence: number;
}

/**
 * 5. Visitor Sentiment Analysis (Positive / Neutral / Negative)
 * Computed from the visitor's last 5 messages.
 * Marks Negative when messages contain insults, complaints or repeated "waiting" messages.
 * Returns confidence score so low-confidence badges can be hidden.
 */
export async function analyzeVisitorSentiment({
  messages,
  providerConfig,
}: {
  messages: Array<{ sender_type: string; content: string }>;
  providerConfig?: ProviderConfig | null;
}): Promise<SentimentResult> {
  const visitorMsgs = messages
    .filter((m) => m.sender_type === 'visitor')
    .slice(-5);

  if (visitorMsgs.length === 0) {
    return { sentiment: 'neutral', confidence: 0 };
  }

  // 1. Insults
  const insultRegex = /\b(stupid|idiot|moron|dumb|useless|scam|scammer|clowns?|pathetic|trash|garbage|bullshit|bull crap|worst|incompetent|terrible|sucks?|horrible|wtf|damn|fucking?)\b/i;

  // 2. Complaints
  const complaintRegex = /\b(broken|not working|doesn'?t work|won'?t work|failed|fail|failure|charge|billing issue|overcharg(ed|ing)|unacceptable|refund|cancel|disappointed|bad experience|horrible service|rip off|ripoff|fix this|frustrated|angry|fraud|poor service|awful)\b/i;

  // 3. Repeated "waiting" messages
  const waitingRegex = /\b(still waiting|waiting|wait|anyone (here|there|alive)|hello\?+|any update\?*|are you there|reply please|respond please|no response|how long|ignoring me|nobody answers)\b/i;

  const hasInsult = visitorMsgs.some((m) => insultRegex.test(m.content));
  const hasComplaint = visitorMsgs.some((m) => complaintRegex.test(m.content));
  const waitingMessagesCount = visitorMsgs.filter((m) => waitingRegex.test(m.content)).length;
  const singleMsgRepeatedWait = visitorMsgs.some((m) => {
    const matches = m.content.match(/\b(waiting|wait|hello\?|anyone there|reply)\b/gi);
    return matches && matches.length >= 2;
  });
  const hasRepeatedWaiting = waitingMessagesCount >= 2 || singleMsgRepeatedWait;

  if (hasInsult || hasComplaint || hasRepeatedWaiting) {
    return { sentiment: 'negative', confidence: 0.95 };
  }

  // 4. Check positive cues
  const positiveRegex = /\b(thank|thanks|thank you|great|awesome|helpful|love it|good job|perfect|resolved|amazing|excellent|wonderful|appreciate)\b/i;
  const positiveCount = visitorMsgs.filter((m) => positiveRegex.test(m.content)).length;
  if (positiveCount >= 1) {
    return { sentiment: 'positive', confidence: 0.85 };
  }

  // 5. LLM classification. askModel falls back to the platform model, which
  // is the only one configured now that workspaces no longer hold keys.
  const visitorText = visitorMsgs.map((m) => m.content).join(' ');
  if (visitorText) {
    try {
      const prompt = `Analyze the sentiment of this customer's last messages:
"${visitorText}"

Classify into exactly one word: "positive", "neutral", or "negative".
Output ONLY the single classification word.`;

      const answer = await askModel(
        providerConfig,
        'You classify customer sentiment. Reply with one word: positive, neutral, or negative.',
        prompt,
        16
      );
      if (answer) {
        const text = answer.toLowerCase().trim();
        if (text.includes('neg')) return { sentiment: 'negative', confidence: 0.85 };
        if (text.includes('pos')) return { sentiment: 'positive', confidence: 0.85 };
        if (text.includes('neu')) return { sentiment: 'neutral', confidence: 0.4 };
      }
    } catch (err) {}
  }

  // Default to neutral with low confidence so badge stays hidden
  return { sentiment: 'neutral', confidence: 0.4 };
}
