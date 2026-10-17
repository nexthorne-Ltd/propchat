'use client';

import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@/lib/supabase/client';
import { Agent, Workspace } from '@/types/database';
import { UnansweredQuestionsView } from '@/components/dashboard/UnansweredQuestionsView';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import Link from 'next/link';

export default function UnansweredQuestionsPage() {
  const router = useRouter();
  const supabase = createClient();
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function load() {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
          router.push('/login');
          return;
        }

        const { data: agentData } = await supabase
          .from('agents')
          .select('*, workspace:workspaces(*)')
          .eq('user_id', user.id)
          .maybeSingle();

        if (agentData) {
          setAgent(agentData);
          setWorkspace(agentData.workspace || null);
        }
      } catch (e) {
        console.warn('Failed to load user session:', e);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [router, supabase]);

  if (loading) {
    return (
      <div className="flex h-screen items-center justify-center bg-canvas">
        <RefreshCw className="w-6 h-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen bg-canvas overflow-hidden">
      <div className="px-6 py-2 border-b border-line bg-surface flex items-center justify-between">
        <Link
          href="/dashboard"
          className="inline-flex items-center gap-1.5 text-xs text-ink-3 hover:text-ink transition-colors font-medium"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>Back to Dashboard</span>
        </Link>
        <span className="text-2xs text-ink-3 font-mono">{workspace?.name || 'Workspace'}</span>
      </div>
      <div className="flex-1 overflow-hidden">
        <UnansweredQuestionsView
          workspace={workspace}
          currentAgent={agent}
          onSelectConversation={(id) => router.push(`/dashboard?conv=${id}`)}
        />
      </div>
    </div>
  );
}
