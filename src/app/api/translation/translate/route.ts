import { NextRequest, NextResponse } from 'next/server';
import { guardMember } from '@/lib/team/route-guard';
import { serviceClient } from '@/lib/supabase/service';
import { providerConfigFrom } from '@/lib/ai/help-answer';
import {
  detectLanguage,
  translateToEnglish,
  translateFromEnglish,
  translateAgentReply,
  SUPPORTED_LANGUAGES,
} from '@/lib/ai/translator';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

export async function POST(req: NextRequest) {
  try {
    const guard = await guardMember('view');
    if (!guard.ok) return guard.response;
    const body = await req.json();
    const {
      text,
      direction, // 'to_english' | 'agent_reply' | 'from_english'
      targetLanguage,
      sourceLanguage,
      workspaceId,
      romanize,
    } = body;

    if (!text || !text.trim()) {
      return NextResponse.json({ translatedText: text || '', isOriginalEnglish: true }, { headers: CORS_HEADERS });
    }

    let providerConfig = null;
    let businessName = '';

    if (workspaceId) {
      try {
        const supabase = serviceClient();
        const { data: ws } = await supabase
          .from('workspaces')
          .select('name, ai_settings')
          .eq('id', workspaceId)
          .maybeSingle();

        if (ws) {
          businessName = ws.name || '';
          providerConfig = providerConfigFrom(ws.ai_settings);
        }
      } catch (err) {
        console.warn('[Translation API] Workspace fetch skipped:', err);
      }
    }

    if (direction === 'to_english') {
      const detected = sourceLanguage
        ? { code: sourceLanguage, name: SUPPORTED_LANGUAGES[sourceLanguage]?.name || sourceLanguage }
        : detectLanguage(text);

      const res = await translateToEnglish({
        text,
        detectedLanguage: sourceLanguage || (detected.code !== 'en' ? detected.code : undefined),
        providerConfig,
      });

      const finalCode = res.detectedLanguageCode || detected.code || 'en';

      return NextResponse.json(
        {
          originalText: text,
          translatedText: res.englishText,
          englishText: res.englishText,
          detectedLanguage: finalCode,
          languageName: res.sourceLanguage,
          isOriginalEnglish: res.isOriginalEnglish,
        },
        { headers: CORS_HEADERS }
      );
    }

    if (direction === 'agent_reply' || direction === 'from_english') {
      const targetCode = targetLanguage || 'en';
      const res = await translateAgentReply({
        text,
        targetLanguageCode: targetCode,
        sourceLanguageCode: sourceLanguage,
        providerConfig,
        businessName,
        romanize: Boolean(romanize),
      });

      return NextResponse.json(
        {
          originalText: text,
          translatedText: res.translatedText,
          englishText: res.englishText,
          detectedSourceLanguage: res.detectedSourceLanguage,
          sourceLanguageName: res.sourceLanguageName,
          targetLanguage: res.targetLanguage,
          targetLanguageName: res.targetLanguageName,
          targetLanguageCode: targetCode,
          isTranslated: res.isTranslated,
        },
        { headers: CORS_HEADERS }
      );
    }

    return NextResponse.json({ error: 'Invalid direction parameter' }, { status: 400, headers: CORS_HEADERS });
  } catch (error: any) {
    console.error('[Translation API Error]:', error);
    return NextResponse.json(
      { error: error.message || 'Translation failed', translatedText: '' },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}
