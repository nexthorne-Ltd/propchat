import { NextRequest, NextResponse } from 'next/server';
import { guardConversation } from '@/lib/team/route-guard';
import { providerConfigFrom } from '@/lib/ai/help-answer';
import { serviceClient } from '@/lib/supabase/service';
import {
  analyzeVisitorSentiment,
  generateAutoTags,
  generateConversationSummary,
} from '@/lib/ai/anthropic';

export async function POST(req: NextRequest) {
  try {
    const { conversation_id, workspace_id, apply_tags = true } = await req.json();

    if (!conversation_id || !workspace_id) {
      return NextResponse.json({ error: 'Missing conversation_id or workspace_id' }, { status: 400 });
    }

    const guard = await guardConversation(conversation_id, 'edit_ticket');
    if (!guard.ok) return guard.response;
    if (guard.workspaceId !== workspace_id) return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });

    const supabase = serviceClient();

    // 1. Fetch workspace AI settings
    const { data: workspace } = await supabase
      .from('workspaces')
      .select('ai_settings')
      .eq('id', workspace_id)
      .single();

    const aiSettings = workspace?.ai_settings;
    // Missing flags count as on, matching Settings and the auto-respond route.
    if (aiSettings && aiSettings.enabled === false) {
      return NextResponse.json({ disabled: true });
    }

    // 2. Fetch conversation and messages
    const [{ data: conv }, { data: messages }] = await Promise.all([
      supabase.from('conversations').select('*, visitor:visitors(*)').eq('id', conversation_id).single(),
      supabase
        .from('messages')
        .select('sender_type, content, created_at')
        .eq('conversation_id', conversation_id)
        .order('created_at', { ascending: true }),
    ]);

    if (!conv) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 });
    }

    const msgList = messages || [];
    const providerConfig = providerConfigFrom(aiSettings);
    const updates: Record<string, any> = {};

    let sentiment = conv.sentiment || 'neutral';
    let sentimentConfidence = (conv.channel_metadata as any)?.sentiment_confidence ?? 0;
    let summary = conv.summary || null;
    let tags = conv.tags || [];

    // A. Sentiment Analysis (if enabled)
    if (aiSettings?.sentiment_enabled !== false) {
      const sentimentResult = await analyzeVisitorSentiment({
        messages: msgList,
        providerConfig,
      });
      sentimentConfidence = sentimentResult.confidence;
      sentiment = sentimentResult.confidence >= 0.7 ? sentimentResult.sentiment : 'neutral';
      updates.sentiment = sentiment;
      updates.channel_metadata = {
        ...((conv.channel_metadata as Record<string, any>) || {}),
        sentiment_confidence: sentimentResult.confidence,
      };
    }

    // B. Auto-Tagging (if enabled)
    if (aiSettings?.auto_tagging_enabled !== false) {
      const visitorMessages = msgList.filter((m) => m.sender_type === 'visitor');
      const allVisitorText = visitorMessages.map((m) => m.content).join(' ');
      if (allVisitorText) {
        tags = await generateAutoTags({
          content: allVisitorText,
          existingTags: conv.tags || [],
          providerConfig,
        });
        if (apply_tags) {
          updates.tags = tags;
        }
      }
    }

    // C. 2-Line Conversation Summary (for long threads >= 4 messages)
    if (aiSettings?.summary_enabled !== false && msgList.length >= 3) {
      summary = await generateConversationSummary({
        messages: msgList,
        visitorName: conv.visitor?.name,
        providerConfig,
      });
      updates.summary = summary;
    }

    // D. Persist updates to conversations table (without altering updated_at recency)
    if (Object.keys(updates).length > 0) {
      await supabase
        .from('conversations')
        .update(updates)
        .eq('id', conversation_id);
    }

    return NextResponse.json({
      sentiment,
      summary,
      tags,
      applied: updates,
    });
  } catch (error: any) {
    console.error('Error analyzing conversation:', error);
    return NextResponse.json({ error: error.message || 'Analysis failed' }, { status: 500 });
  }
}
