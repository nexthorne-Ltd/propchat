import { createClient } from '@/lib/supabase/server';
import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

export default async function HelpRootPage() {
  const supabase = await createClient();

  // Priority 1: Dedicated Zen-try workspace
  const { data: zentryWs } = await supabase
    .from('public_workspaces')
    .select('id, slug')
    .or('slug.eq.zen-try,slug.eq.zentry,name.ilike.Zen-try,slug.eq.chatify,name.ilike.Chatify')
    .limit(1)
    .maybeSingle();

  if (zentryWs) {
    redirect(`/help/${zentryWs.slug || zentryWs.id}`);
  }

  // Priority 2: First active public workspace
  const { data: ws } = await supabase
    .from('public_workspaces')
    .select('id, slug')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  const target = ws?.slug || ws?.id || 'zen-try';
  redirect(`/help/${target}`);
}
