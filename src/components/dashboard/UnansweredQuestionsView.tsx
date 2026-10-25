'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  HelpCircle,
  Search,
  ExternalLink,
  CheckCircle2,
  XCircle,
  FileText,
  Link as LinkIcon,
  Sparkles,
  Check,
  X,
  MessageSquare,
  AlertTriangle,
  Clock,
  Layers,
  ChevronRight,
  ShieldCheck,
  RefreshCw,
  BookOpen,
} from 'lucide-react';
import { Agent, Workspace } from '@/types/database';
import {
  listUnansweredQuestionsAction,
  saveQuickQaAnswerAction,
  convertUnansweredToArticleAction,
  linkUnansweredToArticleAction,
  dismissUnansweredQuestionAction,
  approvePendingAnswerAction,
  type UnansweredQuestionRecord,
} from '@/app/actions/unanswered';
import { createClient } from '@/lib/supabase/client';
import { formatTimeAgo, cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';

interface UnansweredQuestionsViewProps {
  workspace: Workspace | null;
  currentAgent: Agent | null;
  onSelectConversation?: (conversationId: string) => void;
}

type TabFilter = 'open' | 'pending_approval' | 'answered' | 'dismissed' | 'all';

export function UnansweredQuestionsView({
  workspace,
  currentAgent,
  onSelectConversation,
}: UnansweredQuestionsViewProps) {
  const [questions, setQuestions] = useState<UnansweredQuestionRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<TabFilter>('open');
  const [searchQuery, setSearchQuery] = useState('');
  const [sections, setSections] = useState<Array<{ id: string; name: string }>>([]);
  const [articles, setArticles] = useState<Array<{ id: string; title: string; slug: string | null }>>([]);

  // Modals state
  const [quickQaTarget, setQuickQaTarget] = useState<UnansweredQuestionRecord | null>(null);
  const [quickQaQuestion, setQuickQaQuestion] = useState('');
  const [quickQaAnswer, setQuickQaAnswer] = useState('');
  const [isSubmittingQuickQa, setIsSubmittingQuickQa] = useState(false);

  const [articleTarget, setArticleTarget] = useState<UnansweredQuestionRecord | null>(null);
  const [articleTitle, setArticleTitle] = useState('');
  const [articleContent, setArticleContent] = useState('');
  const [articleSectionId, setArticleSectionId] = useState<string>('');
  const [isSubmittingArticle, setIsSubmittingArticle] = useState(false);

  const [linkTarget, setLinkTarget] = useState<UnansweredQuestionRecord | null>(null);
  const [selectedArticleId, setSelectedArticleId] = useState<string>('');
  const [isSubmittingLink, setIsSubmittingLink] = useState(false);

  const [feedbackToast, setFeedbackToast] = useState<{ message: string; tone: 'success' | 'warn' } | null>(null);

  const isAdmin = currentAgent?.role === 'admin' || currentAgent?.role === 'owner';

  const showToast = (message: string, tone: 'success' | 'warn' = 'success') => {
    setFeedbackToast({ message, tone });
    setTimeout(() => setFeedbackToast(null), 4000);
  };

  const loadData = useCallback(async () => {
    if (!workspace?.id) return;
    setLoading(true);
    try {
      const data = await listUnansweredQuestionsAction(workspace.id, activeTab);
      setQuestions(data);

      const supabase = createClient();
      const [{ data: secData }, { data: artData }] = await Promise.all([
        supabase.from('help_sections').select('id, name').eq('workspace_id', workspace.id),
        supabase
          .from('articles')
          .select('id, title, slug')
          .eq('workspace_id', workspace.id)
          .eq('status', 'published')
          .order('title'),
      ]);
      setSections(secData || []);
      setArticles(artData || []);
    } catch (err: any) {
      console.warn('Failed to load unanswered questions:', err);
    } finally {
      setLoading(false);
    }
  }, [workspace?.id, activeTab]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Handle Quick Q&A Save
  const handleSaveQuickQa = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace?.id || !quickQaAnswer.trim()) return;
    setIsSubmittingQuickQa(true);
    try {
      const res = await saveQuickQaAnswerAction(workspace.id, quickQaTarget?.id ?? null, {
        question: quickQaQuestion.trim() || quickQaTarget?.question || '',
        answer: quickQaAnswer.trim(),
      });
      if (res.pendingApproval) {
        showToast('Answer submitted for admin review before publishing.', 'warn');
      } else {
        showToast('Answer saved and embedded! The AI bot will use this answer immediately.');
      }
      setQuickQaTarget(null);
      setQuickQaAnswer('');
      loadData();
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to save answer'), 'warn');
    } finally {
      setIsSubmittingQuickQa(false);
    }
  };

  // Handle Convert to Article
  const handleSaveArticle = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace?.id || !articleTarget || !articleTitle.trim() || !articleContent.trim()) return;
    setIsSubmittingArticle(true);
    try {
      await convertUnansweredToArticleAction(workspace.id, articleTarget.id, {
        title: articleTitle.trim(),
        content: articleContent.trim(),
        section_id: articleSectionId || null,
      });
      showToast('Article created and embedded into the knowledge base!');
      setArticleTarget(null);
      setArticleTitle('');
      setArticleContent('');
      loadData();
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to create article'), 'warn');
    } finally {
      setIsSubmittingArticle(false);
    }
  };

  // Handle Link to Existing Article
  const handleSaveLink = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!workspace?.id || !linkTarget || !selectedArticleId) return;
    setIsSubmittingLink(true);
    try {
      await linkUnansweredToArticleAction(workspace.id, linkTarget.id, selectedArticleId);
      showToast('Question linked to existing article!');
      setLinkTarget(null);
      setSelectedArticleId('');
      loadData();
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to link article'), 'warn');
    } finally {
      setIsSubmittingLink(false);
    }
  };

  // Handle Dismiss
  const handleDismiss = async (item: UnansweredQuestionRecord) => {
    if (!workspace?.id) return;
    try {
      await dismissUnansweredQuestionAction(workspace.id, item.id);
      showToast('Question dismissed.');
      loadData();
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to dismiss question'), 'warn');
    }
  };

  // Handle Admin Approval
  const handleApprove = async (item: UnansweredQuestionRecord) => {
    if (!workspace?.id) return;
    try {
      await approvePendingAnswerAction(workspace.id, item.id);
      showToast('Answer approved and embedded for AI bot use!');
      loadData();
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to approve answer'), 'warn');
    }
  };

  const filteredQuestions = useMemo(() => {
    if (!searchQuery.trim()) return questions;
    const q = searchQuery.toLowerCase();
    return questions.filter(
      (item) =>
        item.question.toLowerCase().includes(q) ||
        (item.reason && item.reason.toLowerCase().includes(q)) ||
        (item.proposed_answer && item.proposed_answer.toLowerCase().includes(q))
    );
  }, [questions, searchQuery]);

  return (
    <div className="flex-1 flex flex-col h-full bg-canvas overflow-y-auto">
      {/* Toast Notification */}
      {feedbackToast && (
        <div className="fixed bottom-6 right-6 z-50 animate-slide-up">
          <div
            className={cn(
              'px-4 py-3 rounded-xl shadow-lg border flex items-center gap-2.5 text-xs font-medium',
              feedbackToast.tone === 'success'
                ? 'bg-surface border-success-line text-success'
                : 'bg-surface border-warn-line text-warn'
            )}
          >
            {feedbackToast.tone === 'success' ? (
              <CheckCircle2 className="w-4 h-4 text-success shrink-0" />
            ) : (
              <AlertTriangle className="w-4 h-4 text-warn shrink-0" />
            )}
            <span>{feedbackToast.message}</span>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="shrink-0 p-6 border-b border-line bg-surface/50 backdrop-blur-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 max-w-6xl mx-auto">
          <div>
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-xl bg-warn-soft text-warn flex items-center justify-center font-bold">
                <HelpCircle className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-lg font-bold text-ink tracking-tight flex items-center gap-2">
                  Unanswered Questions
                </h1>
                <p className="text-xs text-ink-3">
                  Questions your AI bot could not answer from knowledge. Train the bot by writing answers or linking articles.
                </p>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2.5">
            <button
              onClick={loadData}
              disabled={loading}
              className="px-3 py-1.5 rounded-lg border border-line bg-surface text-ink-2 hover:text-ink hover:bg-surface-2 transition-all flex items-center gap-1.5 text-xs font-medium cursor-pointer shadow-2xs"
            >
              <RefreshCw className={cn('w-3.5 h-3.5', loading && 'animate-spin')} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* Filters & Search */}
        <div className="mt-6 flex flex-col sm:flex-row sm:items-center justify-between gap-3 max-w-6xl mx-auto">
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-surface-2 border border-line overflow-x-auto">
            {(
              [
                { id: 'open', label: 'Open' },
                { id: 'pending_approval', label: 'Pending Approval' },
                { id: 'answered', label: 'Answered' },
                { id: 'dismissed', label: 'Dismissed' },
                { id: 'all', label: 'All' },
              ] as const
            ).map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={cn(
                  'px-3 py-1 rounded-lg text-xs font-medium transition-all whitespace-nowrap cursor-pointer',
                  activeTab === tab.id
                    ? 'bg-surface text-ink font-semibold shadow-2xs border border-line'
                    : 'text-ink-3 hover:text-ink-2'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="relative w-full sm:w-72">
            <Search className="w-3.5 h-3.5 absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search questions..."
              className="w-full pl-8 pr-3 py-1.5 rounded-xl border border-line bg-surface text-xs text-ink placeholder:text-ink-3 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
        </div>
      </div>

      {/* Main Table / List */}
      <div className="flex-1 p-6 max-w-6xl w-full mx-auto">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-ink-3 gap-3">
            <RefreshCw className="w-6 h-6 animate-spin text-accent" />
            <span className="text-xs">Loading unanswered questions…</span>
          </div>
        ) : filteredQuestions.length === 0 ? (
          <div className="py-20 text-center rounded-2xl border border-dashed border-line bg-surface/30 p-8 space-y-3">
            <div className="w-12 h-12 rounded-2xl bg-surface-2 flex items-center justify-center mx-auto text-ink-3">
              <CheckCircle2 className="w-6 h-6 text-success" />
            </div>
            <h3 className="text-sm font-bold text-ink">No questions found</h3>
            <p className="text-xs text-ink-3 max-w-sm mx-auto">
              {searchQuery
                ? 'No questions matched your search term.'
                : activeTab === 'open'
                ? 'All visitor inquiries have been answered or resolved. Great job!'
                : `No questions in the ${activeTab} tab.`}
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {filteredQuestions.map((item) => (
              <div
                key={item.id}
                className="p-4 sm:p-5 rounded-2xl border border-line bg-surface hover:border-line-2 transition-all shadow-2xs space-y-3"
              >
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="space-y-1.5 min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm sm:text-base font-bold text-ink break-words">
                        {item.question}
                      </span>
                      {item.times_asked > 1 ? (
                        <span className="px-2 py-0.5 rounded-full text-2xs font-bold bg-warn-soft text-warn border border-warn-line">
                          🔥 Asked {item.times_asked} times
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-2xs font-medium bg-surface-2 text-ink-3 border border-line">
                          Asked 1 time
                        </span>
                      )}
                      <span
                        className={cn(
                          'px-2 py-0.5 rounded-full text-2xs font-semibold uppercase tracking-wider',
                          item.status === 'open' && 'bg-warn-soft text-warn border border-warn-line',
                          item.status === 'pending_approval' && 'bg-accent-soft text-accent border border-accent-line',
                          item.status === 'answered' && 'bg-success-soft text-success border border-success-line',
                          item.status === 'dismissed' && 'bg-surface-3 text-ink-3 border border-line'
                        )}
                      >
                        {item.status.replace('_', ' ')}
                      </span>
                    </div>

                    {item.reason && (
                      <p className="text-xs text-ink-3 leading-relaxed">
                        Reason: {item.reason}
                      </p>
                    )}

                    <div className="flex items-center gap-3 text-2xs text-ink-3 pt-1">
                      <span className="flex items-center gap-1">
                        <Clock className="w-3 h-3" />
                        <span>Last asked {formatTimeAgo(item.last_asked_at || item.created_at)}</span>
                      </span>
                      {item.conversation_id && (
                        <button
                          type="button"
                          onClick={() => onSelectConversation?.(item.conversation_id!)}
                          className="text-accent hover:underline flex items-center gap-1 font-medium cursor-pointer"
                        >
                          <ExternalLink className="w-3 h-3" />
                          <span>View original conversation</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Actions for this item */}
                  <div className="flex items-center gap-1.5 shrink-0 self-end sm:self-start">
                    {item.status === 'pending_approval' && isAdmin ? (
                      <button
                        onClick={() => handleApprove(item)}
                        className="px-3 py-1.5 rounded-xl bg-accent text-accent-ink hover:opacity-90 font-semibold text-xs flex items-center gap-1.5 transition-all shadow-xs cursor-pointer"
                        title="Approve this answer to train the bot"
                      >
                        <ShieldCheck className="w-3.5 h-3.5" />
                        <span>Approve Answer</span>
                      </button>
                    ) : null}

                    {item.status === 'open' || item.status === 'pending_approval' ? (
                      <>
                        <button
                          onClick={() => {
                            setQuickQaTarget(item);
                            setQuickQaQuestion(item.question);
                            setQuickQaAnswer(item.proposed_answer || '');
                          }}
                          className="px-2.5 py-1.5 rounded-xl border border-accent/30 bg-accent/10 hover:bg-accent/20 text-accent font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer"
                          title="Write a quick answer"
                        >
                          <Sparkles className="w-3.5 h-3.5" />
                          <span>Quick Q&A</span>
                        </button>

                        <button
                          onClick={() => {
                            setArticleTarget(item);
                            setArticleTitle(item.question);
                            setArticleContent(item.proposed_answer || '');
                          }}
                          className="px-2.5 py-1.5 rounded-xl border border-line bg-surface hover:bg-surface-2 text-ink-2 hover:text-ink font-medium text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-2xs"
                          title="Create a full article"
                        >
                          <BookOpen className="w-3.5 h-3.5" />
                          <span>Article</span>
                        </button>

                        <button
                          onClick={() => {
                            setLinkTarget(item);
                            setSelectedArticleId('');
                          }}
                          className="px-2.5 py-1.5 rounded-xl border border-line bg-surface hover:bg-surface-2 text-ink-2 hover:text-ink font-medium text-xs flex items-center gap-1.5 transition-all cursor-pointer shadow-2xs"
                          title="Link to an existing article"
                        >
                          <LinkIcon className="w-3.5 h-3.5" />
                          <span>Link</span>
                        </button>

                        <button
                          onClick={() => handleDismiss(item)}
                          className="p-1.5 rounded-xl border border-line bg-surface hover:bg-surface-2 text-ink-3 hover:text-danger transition-all cursor-pointer shadow-2xs"
                          title="Dismiss question"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </>
                    ) : item.status === 'answered' ? (
                      <div className="flex items-center gap-1.5 text-xs text-success font-medium">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>Answered</span>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-3">Dismissed</span>
                    )}
                  </div>
                </div>

                {/* Proposed Answer Preview if in Pending Approval */}
                {item.proposed_answer && (
                  <div className="p-3 rounded-xl bg-surface-2 border border-line text-xs space-y-1">
                    <span className="font-semibold text-ink-2">Proposed Answer:</span>
                    <p className="text-ink-2 whitespace-pre-wrap">{item.proposed_answer}</p>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* MODAL 1: Quick Q&A */}
      {quickQaTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-fade-in">
          <div className="w-full max-w-lg rounded-2xl border border-line bg-surface p-6 shadow-2xl space-y-4 animate-scale-in">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-ink flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-accent" />
                  Save Quick Q&A Answer
                </h3>
                <p className="text-xs text-ink-3">
                  This answer will be embedded immediately into your workspace knowledge base and answered by the bot.
                </p>
              </div>
              <button
                onClick={() => setQuickQaTarget(null)}
                className="text-ink-3 hover:text-ink p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveQuickQa} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-ink-2">Question</label>
                <input
                  type="text"
                  value={quickQaQuestion}
                  onChange={(e) => setQuickQaQuestion(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-line bg-surface-2 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                  required
                />
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-ink-2">Answer</label>
                <textarea
                  value={quickQaAnswer}
                  onChange={(e) => setQuickQaAnswer(e.target.value)}
                  rows={4}
                  placeholder="Type the answer the bot should provide to visitors..."
                  className="w-full px-3 py-2 rounded-xl border border-line bg-surface-2 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent resize-y"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
                <button
                  type="button"
                  onClick={() => setQuickQaTarget(null)}
                  className="px-3 py-1.5 rounded-xl border border-line bg-surface text-ink-2 hover:bg-surface-2 text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingQuickQa || !quickQaAnswer.trim()}
                  className="px-4 py-1.5 rounded-xl bg-accent text-accent-ink hover:opacity-90 font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50"
                >
                  {isSubmittingQuickQa ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving & Embedding...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Save & Train Bot</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 2: Create Full Article */}
      {articleTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-fade-in">
          <div className="w-full max-w-xl rounded-2xl border border-line bg-surface p-6 shadow-2xl space-y-4 animate-scale-in">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-ink flex items-center gap-2">
                  <BookOpen className="w-4 h-4 text-accent" />
                  Turn into Help Center Article
                </h3>
                <p className="text-xs text-ink-3">
                  Publishes a new Help Center article and synchronizes vector embeddings.
                </p>
              </div>
              <button
                onClick={() => setArticleTarget(null)}
                className="text-ink-3 hover:text-ink p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveArticle} className="space-y-4">
              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-ink-2">Article Title</label>
                <input
                  type="text"
                  value={articleTitle}
                  onChange={(e) => setArticleTitle(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-line bg-surface-2 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                  required
                />
              </div>

              {sections.length > 0 && (
                <div className="space-y-1.5">
                  <label className="text-xs font-semibold text-ink-2">Help Center Section</label>
                  <select
                    value={articleSectionId}
                    onChange={(e) => setArticleSectionId(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl border border-line bg-surface-2 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                  >
                    <option value="">General (No Section)</option>
                    {sections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-ink-2">Content</label>
                <textarea
                  value={articleContent}
                  onChange={(e) => setArticleContent(e.target.value)}
                  rows={6}
                  placeholder="Write comprehensive article content..."
                  className="w-full px-3 py-2 rounded-xl border border-line bg-surface-2 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent resize-y font-mono"
                  required
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
                <button
                  type="button"
                  onClick={() => setArticleTarget(null)}
                  className="px-3 py-1.5 rounded-xl border border-line bg-surface text-ink-2 hover:bg-surface-2 text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingArticle || !articleTitle.trim() || !articleContent.trim()}
                  className="px-4 py-1.5 rounded-xl bg-accent text-accent-ink hover:opacity-90 font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50"
                >
                  {isSubmittingArticle ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Publishing & Embedding...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Publish Article</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL 3: Link to Existing Article */}
      {linkTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-xs animate-fade-in">
          <div className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-2xl space-y-4 animate-scale-in">
            <div className="flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold text-ink flex items-center gap-2">
                  <LinkIcon className="w-4 h-4 text-accent" />
                  Link to Existing Article
                </h3>
                <p className="text-xs text-ink-3">
                  Marks this question as covered by one of your published help center articles.
                </p>
              </div>
              <button
                onClick={() => setLinkTarget(null)}
                className="text-ink-3 hover:text-ink p-1 rounded-lg cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveLink} className="space-y-4">
              <div className="p-3 rounded-xl bg-surface-2 border border-line text-xs text-ink-2">
                <span className="font-semibold block text-ink">Question:</span>
                <span>{linkTarget.question}</span>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-semibold text-ink-2">Select Article</label>
                <select
                  value={selectedArticleId}
                  onChange={(e) => setSelectedArticleId(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-line bg-surface-2 text-xs text-ink focus:outline-none focus:ring-1 focus:ring-accent"
                  required
                >
                  <option value="">-- Choose an article --</option>
                  {articles.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.title}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-line">
                <button
                  type="button"
                  onClick={() => setLinkTarget(null)}
                  className="px-3 py-1.5 rounded-xl border border-line bg-surface text-ink-2 hover:bg-surface-2 text-xs font-medium cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingLink || !selectedArticleId}
                  className="px-4 py-1.5 rounded-xl bg-accent text-accent-ink hover:opacity-90 font-semibold text-xs flex items-center gap-1.5 cursor-pointer shadow-xs disabled:opacity-50"
                >
                  {isSubmittingLink ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Linking...</span>
                    </>
                  ) : (
                    <>
                      <Check className="w-3.5 h-3.5" />
                      <span>Link Article</span>
                    </>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
