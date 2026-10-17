import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { articleId, workspaceId, visitorId, isHelpful, feedbackText } = body;

    if (!articleId || !workspaceId || isHelpful === undefined) {
      return NextResponse.json(
        { error: 'articleId, workspaceId, and isHelpful are required' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const { error } = await supabase.rpc('fn_submit_article_feedback', {
      p_article_id: articleId,
      p_workspace_id: workspaceId,
      p_visitor_id: visitorId || 'anonymous_visitor',
      p_is_helpful: Boolean(isHelpful),
      p_feedback_text: feedbackText?.trim() || null,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ success: true });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || 'Server error' }, { status: 500 });
  }
}
