import { serviceClient } from '@/lib/supabase/service';
import { providerConfigFrom } from './help-answer';
import { isLikelyEnglishText, isRomanizedText, translateToEnglish } from './translator';

/** Bumped when detection improves, so results stored as "English" get a second look. */
const TRANSLATION_ENGINE_VERSION = 2;

export interface InboundTranslation {
  englishText: string;
  detectedLanguage: string;
  languageName: string;
  isOriginalEnglish: boolean;
  isRoman: boolean;
  cached?: boolean;
}

/**
 * Translates one visitor message into English for the agents and stores the
 * result on the message, so every agent (and every reload) sees the English
 * text without translating it again.
 *
 * The text is always read from the stored message, never taken from a caller:
 * the route in front of this is public, and trusting the caller's text would
 * let anyone attach a made-up "translation" to someone else's message.
 */
export async function translateVisitorMessage(messageId: string): Promise<InboundTranslation | null> {
  const supabase = serviceClient();

  const { data: msg } = await supabase
    .from('messages')
    .select('id, conversation_id, sender_type, content, metadata, conversation:conversations(id, workspace_id, channel_metadata)')
    .eq('id', messageId)
    .maybeSingle();

  if (!msg || msg.sender_type !== 'visitor') return null;

  const existingMeta = (msg.metadata as Record<string, any>) || {};
  const messageText = (msg.content || '').trim();

  // Already done: answer from what is stored. A message an older version
  // stored as "English" when it plainly is not (Hebrew came back as Google's
  // code "iw" and was dropped; romanized Arabic was left untranslated) is
  // translated again, once, by the current engine.
  const stored = existingMeta.translation;
  const storedIsTrustworthy =
    stored?.english_text &&
    (stored.is_translated ||
      (stored.engine_version ?? 1) >= TRANSLATION_ENGINE_VERSION ||
      isLikelyEnglishText(messageText));
  if (storedIsTrustworthy) {
    const t = existingMeta.translation;
    return {
      englishText: t.english_text,
      detectedLanguage: t.detected_language || 'en',
      languageName: t.language_name || 'English',
      isOriginalEnglish: !t.is_translated,
      isRoman: Boolean(t.is_roman),
      cached: true,
    };
  }

  if (!messageText) return null;

  const conv = (Array.isArray(msg.conversation) ? msg.conversation[0] : msg.conversation) as
    | { id: string; workspace_id: string; channel_metadata: Record<string, any> | null }
    | null;

  let providerConfig = null;
  if (conv?.workspace_id) {
    const { data: ws } = await supabase
      .from('workspaces')
      .select('ai_settings')
      .eq('id', conv.workspace_id)
      .maybeSingle();
    if (ws) providerConfig = providerConfigFrom(ws.ai_settings);
  }

  const res = await translateToEnglish({ text: messageText, providerConfig });

  const detectedCode = res.detectedLanguageCode || 'en';
  const isNonEnglish =
    detectedCode !== 'en' &&
    !res.isOriginalEnglish &&
    res.englishText.trim().toLowerCase() !== messageText.toLowerCase();
  // A script language typed in Latin letters (Roman Urdu, Arabizi, Roman
  // Russian...): replies to this visitor come back in Latin letters too.
  const isRoman = isNonEnglish && isRomanizedText(detectedCode, messageText);

  const result: InboundTranslation = {
    englishText: isNonEnglish ? res.englishText : messageText,
    detectedLanguage: isNonEnglish ? detectedCode : 'en',
    languageName: isNonEnglish ? res.sourceLanguage : 'English',
    isOriginalEnglish: !isNonEnglish,
    isRoman,
  };

  await supabase
    .from('messages')
    .update({
      metadata: {
        ...existingMeta,
        translation: {
          is_translated: isNonEnglish,
          direction: 'visitor_to_agent',
          original_text: messageText,
          english_text: result.englishText,
          detected_language: result.detectedLanguage,
          language_name: result.languageName,
          is_roman: isRoman,
          engine_version: TRANSLATION_ENGINE_VERSION,
        },
        detected_language: result.detectedLanguage,
        language_name: result.languageName,
        english_translation: result.englishText,
      },
    })
    .eq('id', messageId);

  // The conversation follows the visitor's latest real language. Short English
  // like "ok" does not flip a Spanish conversation back to English, and an
  // agent's manual override is never touched.
  if (conv && isNonEnglish) {
    const chanMeta = conv.channel_metadata || {};
    if (!chanMeta.language_override) {
      await supabase
        .from('conversations')
        .update({
          channel_metadata: {
            ...chanMeta,
            visitor_language: detectedCode,
            language_name: res.sourceLanguage,
            visitor_language_roman: isRoman,
          },
        })
        .eq('id', conv.id);
    }
  }

  return result;
}
