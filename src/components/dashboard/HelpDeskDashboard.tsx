'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  BookOpen,
  Plus,
  Search,
  ExternalLink,
  Settings,
  Eye,
  ThumbsUp,
  ThumbsDown,
  Edit2,
  Trash2,
  CheckCircle2,
  ArrowUpDown,
  Filter,
  Layers,
  Sparkles,
  X,
  Heading1,
  Heading2,
  Heading3,
  List,
  Code,
  Link2,
  AlertCircle,
  Globe,
  Copy,
  Maximize2,
  Minimize2,
  Columns2,
  Check,
  RotateCcw,
  Info,
  Upload,
  MoreHorizontal,
  ArrowUp,
  ArrowDown,
  GripVertical,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import { Agent, Article, HelpSection, Workspace } from '@/types/database';
import { EmojiPickerPopover } from '@/components/dashboard/EmojiPickerPopover';
import { MarkdownArticleContent } from '@/components/dashboard/MarkdownArticleContent';
import { getWorkspaceHelpCenterUrl } from '@/lib/domain';
import { createClient } from '@/lib/supabase/client';
import {
  getHelpDeskDataAction,
  createHelpSectionAction,
  updateHelpSectionAction,
  deleteHelpSectionAction,
  deleteArticleAction,
  reorderArticlesAction,
  reorderHelpSectionsAction,
  migrateHelpDeskArticlesAction,
  toggleArticleStatusAction,
  updateHelpTabSettingsAction,
  searchArticleBodiesAction,
} from '@/app/actions/helpdesk';
import { generateSlug } from '@/lib/slug';
import { Avatar } from '@/components/ui/Avatar';
import { KnowledgePanel } from '@/components/dashboard/KnowledgePanel';
import { BotKnowledgePanel } from '@/components/dashboard/BotKnowledgePanel';
import { Menu } from '@/components/ui/Menu';
import { cn } from '@/lib/utils';
import { NavbarPreviewModal } from '@/components/dashboard/NavbarPreviewModal';
import { dismissNavbarPromptAction } from '@/app/actions/admin';
import { errorMessage } from '@/lib/errors/user-error';
import { ArticleEditor } from '@/components/helpdesk/ArticleEditor';

interface HelpDeskDashboardProps {
  workspace: Workspace | null;
  currentAgent: Agent | null;
  onArticlesCountChange?: (count: number) => void;
}

const COMMON_EMOJIS = ['🚀', '💳', '⚙️', '📦', '🔒', '💡', '❓', '📖', '🛠️', '🎯', '📱', '🔔'];

export function SectionIconPreview({
  icon,
  className = 'w-9 h-9 rounded-xl',
  imgClassName = 'w-6 h-6',
}: {
  icon?: string | null;
  className?: string;
  imgClassName?: string;
}) {
  const isImg =
    icon &&
    (icon.startsWith('http://') ||
      icon.startsWith('https://') ||
      icon.startsWith('/') ||
      icon.startsWith('data:image/'));

  return (
    <span
      className={`grid place-items-center bg-surface-2 border border-line overflow-hidden shrink-0 select-none ${className}`}
    >
      {isImg ? (
        <img
          src={icon}
          alt=""
          className={`object-contain ${imgClassName}`}
        />
      ) : (
        <span className="text-lg leading-none">{icon?.trim() || '📚'}</span>
      )}
    </span>
  );
}

export const GENERIC_ICON_GROUPS = [
  {
    name: 'General & Support',
    icons: ['📚', '📄', '📁', '💬', '❓', '🎯', '👤', '🎧'],
  },
  {
    name: 'Tech & Platform',
    icons: ['🚀', '⚡', '⚙️', '💡', '📱', '🌐', '💻', '🔧'],
  },
  {
    name: 'Security & Rules',
    icons: ['🛡️', '🔒', '⚖️', '🔑', '📜', '🔏', '🪪', '⚠️'],
  },
];

export const TRADING_ICON_GROUP = {
  name: 'Trading & Finance',
  icons: ['📈', '💳', '💵', '📊', '🪙', '📉', '🏦', '💹'],
};

export function isTradingWorkspace(workspace?: Workspace | null): boolean {
  if (!workspace?.industry) return false;
  const ind = workspace.industry.toLowerCase().trim();
  return ['trading', 'prop_firm', 'prop-firm', 'finance', 'fintech'].includes(ind);
}

export function getSectionIconGroups(workspace?: Workspace | null) {
  return isTradingWorkspace(workspace)
    ? [TRADING_ICON_GROUP, ...GENERIC_ICON_GROUPS]
    : GENERIC_ICON_GROUPS;
}

export const SECTION_ICON_GROUPS = [
  TRADING_ICON_GROUP,
  ...GENERIC_ICON_GROUPS,
];

export function HelpDeskDashboard({
  workspace,
  currentAgent,
  onArticlesCountChange,
}: HelpDeskDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [sections, setSections] = useState<HelpSection[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);


  // Filter and search state
  const [selectedSectionId, setSelectedSectionId] = useState<string | 'all'>('all');
  const [selectedStatus, setSelectedStatus] = useState<'all' | 'published' | 'draft'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [bodyMatchIds, setBodyMatchIds] = useState<Set<string>>(new Set());

  // Modals
  const [isArticleModalOpen, setIsArticleModalOpen] = useState(false);
  const [editingArticle, setEditingArticle] = useState<Article | null>(null);
  const [isSectionModalOpen, setIsSectionModalOpen] = useState(false);
  const [editingSection, setEditingSection] = useState<HelpSection | null>(null);
  const [sectionToRename, setSectionToRename] = useState<HelpSection | null>(null);
  const [sectionToDelete, setSectionToDelete] = useState<HelpSection | null>(null);
  const [isDeletingSection, setIsDeletingSection] = useState(false);
  const [isReorderModalOpen, setIsReorderModalOpen] = useState(false);
  const [isTabSettingsModalOpen, setIsTabSettingsModalOpen] = useState(false);
  const [workspaceState, setWorkspaceState] = useState<Workspace | null>(workspace);

  useEffect(() => {
    setWorkspaceState(workspace);
  }, [workspace]);

  // Website Navbar Button Auto-Injector Prompt & Modal State
  const [isNavbarModalOpen, setIsNavbarModalOpen] = useState(false);
  const [navbarPromptDismissed, setNavbarPromptDismissed] = useState(false);

  const handleDismissNavbarPrompt = async () => {
    setNavbarPromptDismissed(true);
    if (!workspaceState?.id) return;
    try {
      const res = await dismissNavbarPromptAction(workspaceState.id);
      if (res.workspace) {
        setWorkspaceState(res.workspace);
      }
    } catch (err) {
      console.error('[HelpDesk] Error dismissing navbar prompt:', err);
    }
  };

  // Status feedback toast
  const [toastMessage, setToastMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  /**
   * Public articles, or the internal side of the same job.
   *
   * Team knowledge and unanswered questions belong beside the articles rather
   * than in Settings: they are the same work — deciding what the help centre
   * says — just the parts that are private or not written yet.
   */
  const [view, setView] = useState<'articles' | 'bot' | 'internal'>('articles');
  /** Bumped by the header button to ask the knowledge panel to open its editor. */
  const [newNoteRequest, setNewNoteRequest] = useState(0);
  /** Same, for the Bot knowledge panel. */
  const [newBotEntryRequest, setNewBotEntryRequest] = useState(0);

  const showToast = (text: string, type: 'success' | 'error' = 'success') => {
    setToastMessage({ text, type });
    setTimeout(() => setToastMessage(null), 3500);
  };

  const loadHelpDeskData = async () => {
    if (!workspace?.id) return;
    try {
      setLoading(true);
      const data = await getHelpDeskDataAction(workspace.id);
      setSections(data.sections);
      setArticles(data.articles);
    } catch (err: any) {
      // The server action's tenancy check can reject sessions the sidebar
      // badge (RLS-scoped browser client) still serves, which left the tiles
      // at "0 published / 0 drafts". Read the same projection through RLS.
      try {
        const supabase = createClient();
        const [secRes, artRes] = await Promise.all([
          supabase
            .from('help_sections')
            .select('*')
            .eq('workspace_id', workspace.id)
            .order('order_index', { ascending: true })
            .order('created_at', { ascending: true }),
          supabase
            .from('articles')
            .select(
              'id, workspace_id, section_id, title, slug, category, summary, status, order_index, ' +
                'author_id, views_count, helpful_count, not_helpful_count, created_at, updated_at, ' +
                'author:agents(id, name, avatar_url), section:help_sections(id, name, slug, icon)'
            )
            .eq('workspace_id', workspace.id)
            .order('order_index', { ascending: true })
            .order('created_at', { ascending: true }),
        ]);
        if (secRes.error || artRes.error) throw secRes.error || artRes.error;
        const secs = (secRes.data as HelpSection[]) || [];
        const arts = (artRes.data as unknown as Article[]) || [];
        const perSection: Record<string, number> = {};
        arts.forEach((a) => {
          if (a.section_id) perSection[a.section_id] = (perSection[a.section_id] || 0) + 1;
        });
        setSections(secs.map((s) => ({ ...s, article_count: perSection[s.id] || 0 })));
        setArticles(arts);
      } catch {
        showToast(errorMessage(err, 'Failed to load Help Desk data'), 'error');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadHelpDeskData();
  }, [workspace?.id]);

  // Body search runs on the server, debounced. Titles and summaries filter
  // instantly from data already in memory, so typing stays responsive and the
  // deeper match arrives a moment later.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!workspace?.id || q.length < 2) {
      setBodyMatchIds(new Set());
      return;
    }

    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const ids = await searchArticleBodiesAction(workspace.id, q);
        if (!cancelled) setBodyMatchIds(new Set(ids));
      } catch {
        // A failed deep search just means fewer results, not a broken page.
      }
    }, 250);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [searchQuery, workspace?.id]);

  // Derived from the list itself, so publishing or deleting an article updates
  // the tiles immediately and cannot drift from what is on screen.
  const metrics = useMemo(() => {
    const totalHelpful = articles.reduce((n, a) => n + (a.helpful_count || 0), 0);
    const totalNotHelpful = articles.reduce(
      (n, a) => n + (a.not_helpful_count || 0),
      0
    );
    const votes = totalHelpful + totalNotHelpful;

    return {
      totalArticles: articles.length,
      publishedCount: articles.filter((a) => a.status === 'published').length,
      draftCount: articles.filter((a) => a.status === 'draft').length,
      totalViews: articles.reduce((n, a) => n + (a.views_count || 0), 0),
      totalHelpful,
      totalNotHelpful,
      // null, not 100 — a help centre with no votes has not earned a score.
      helpfulRate: votes > 0 ? Math.round((totalHelpful / votes) * 100) : null,
    };
  }, [articles]);

  useEffect(() => {
    onArticlesCountChange?.(metrics.totalArticles);
  }, [metrics.totalArticles, onArticlesCountChange]);

  const [isMigrating, setIsMigrating] = useState(false);

  // Section pills count what the list currently holds, for the same reason.
  const sectionCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const a of articles) {
      if (a.section_id) counts[a.section_id] = (counts[a.section_id] || 0) + 1;
    }
    return counts;
  }, [articles]);

  const uncategorisedArticles = useMemo(() => {
    const validSecIds = new Set(sections.map((s) => s.id));
    return articles.filter((a) => !a.section_id || !validSecIds.has(a.section_id));
  }, [articles, sections]);

  const uncategorisedCount = uncategorisedArticles.length;

  const activeSection = useMemo(() => {
    if (selectedSectionId === 'all' || selectedSectionId === 'uncategorised') return null;
    return sections.find((s) => s.id === selectedSectionId) || null;
  }, [sections, selectedSectionId]);

  const handleStartRenameSection = (sec: HelpSection) => {
    setSectionToRename(sec);
  };

  const handleStartDeleteSection = (sec: HelpSection) => {
    setSectionToDelete(sec);
  };

  const handleConfirmDeleteSection = async (moveToSectionId: string | null) => {
    if (!workspace?.id || !sectionToDelete) return;
    setIsDeletingSection(true);
    try {
      await deleteHelpSectionAction(workspace.id, sectionToDelete.id, moveToSectionId);

      await loadHelpDeskData();

      if (selectedSectionId === sectionToDelete.id) {
        setSelectedSectionId('all');
      }

      showToast(`Section "${sectionToDelete.name}" deleted successfully!`);
      setSectionToDelete(null);
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to delete section'), 'error');
    } finally {
      setIsDeletingSection(false);
    }
  };

  const handleRunMigration = async () => {
    if (!workspace?.id) return;
    setIsMigrating(true);
    try {
      const res = await migrateHelpDeskArticlesAction(workspace.id);
      showToast(
        `Migration complete! Organized ${res.migratedCount} article(s) across ${res.createdSectionsCount} section(s). All articles now belong to sections.`
      );
      await loadHelpDeskData();
      setSelectedSectionId('all');
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to migrate articles'), 'error');
    } finally {
      setIsMigrating(false);
    }
  };

  const handleSectionUpdated = (updatedSec: HelpSection) => {
    setSections((prev) =>
      prev.map((s) => (s.id === updatedSec.id ? updatedSec : s))
    );
    setArticles((prev) =>
      prev.map((art) =>
        art.section_id === updatedSec.id
          ? {
              ...art,
              category: updatedSec.name,
              section: updatedSec,
            }
          : art
      )
    );
    showToast(`Section "${updatedSec.name}" updated successfully!`);
    setSectionToRename(null);
  };

  // Articles in the currently selected section, sorted by order_index asc, created_at asc
  const activeSectionArticles = useMemo(() => {
    if (!activeSection) return [];
    return articles
      .filter((a) => a.section_id === activeSection.id)
      .sort((a, b) => {
        const ao = a.order_index ?? 0;
        const bo = b.order_index ?? 0;
        if (ao !== bo) return ao - bo;
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      });
  }, [articles, activeSection]);

  const handleQuickMoveArticle = async (article: Article, direction: 'up' | 'down') => {
    if (!workspace?.id || !activeSection) return;
    const list = [...activeSectionArticles];
    const idx = list.findIndex((a) => a.id === article.id);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= list.length) return;

    // Swap adjacent items
    const temp = list[idx];
    list[idx] = list[targetIdx];
    list[targetIdx] = temp;

    // Assign sequential 1..N order_index
    const updates = list.map((item, index) => ({
      id: item.id,
      order_index: index + 1,
    }));

    // Optimistically update local articles state
    setArticles((prev) =>
      prev.map((art) => {
        const up = updates.find((u) => u.id === art.id);
        return up ? { ...art, order_index: up.order_index } : art;
      })
    );

    try {
      await reorderArticlesAction(workspace.id, updates);
      showToast(`Article moved ${direction}!`);
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to reorder article'), 'error');
      loadHelpDeskData();
    }
  };

  // Filtered Articles: group by section in section order, then by article order
  const filteredArticles = useMemo(() => {
    const validSecIds = new Set(sections.map((s) => s.id));
    const sortedSectionsList = [...sections].sort(
      (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)
    );
    const sectionOrderMap = new Map<string, number>();
    sortedSectionsList.forEach((s, idx) => {
      sectionOrderMap.set(s.id, idx);
    });
    const UNCATEGORISED_ORDER = 999999;

    const list = articles.filter((art) => {
      if (selectedSectionId === 'uncategorised') {
        if (art.section_id && validSecIds.has(art.section_id)) {
          return false;
        }
      } else if (selectedSectionId !== 'all' && art.section_id !== selectedSectionId) {
        return false;
      }
      if (selectedStatus !== 'all' && art.status !== selectedStatus) {
        return false;
      }
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase().trim();
        return (
          art.title.toLowerCase().includes(q) ||
          art.summary?.toLowerCase().includes(q) ||
          art.category?.toLowerCase().includes(q) ||
          bodyMatchIds.has(art.id)
        );
      }
      return true;
    });

    // Sort by section in section order, then by article order
    list.sort((a, b) => {
      const secA =
        a.section_id && sectionOrderMap.has(a.section_id)
          ? sectionOrderMap.get(a.section_id)!
          : UNCATEGORISED_ORDER;
      const secB =
        b.section_id && sectionOrderMap.has(b.section_id)
          ? sectionOrderMap.get(b.section_id)!
          : UNCATEGORISED_ORDER;
      if (secA !== secB) return secA - secB;

      const ao = a.order_index ?? 0;
      const bo = b.order_index ?? 0;
      if (ao !== bo) return ao - bo;

      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });

    return list;
  }, [articles, selectedSectionId, selectedStatus, searchQuery, bodyMatchIds, sections]);

  // Pagination for articles list: 25 per page
  const [articlePage, setArticlePage] = useState(1);
  const ARTICLES_PER_PAGE = 25;
  const totalArticlePages = Math.max(1, Math.ceil(filteredArticles.length / ARTICLES_PER_PAGE));

  useEffect(() => {
    setArticlePage(1);
  }, [searchQuery, selectedStatus, selectedSectionId]);

  useEffect(() => {
    if (articlePage > totalArticlePages) {
      setArticlePage(totalArticlePages);
    }
  }, [totalArticlePages, articlePage]);

  const paginatedArticles = useMemo(() => {
    const start = (articlePage - 1) * ARTICLES_PER_PAGE;
    return filteredArticles.slice(start, start + ARTICLES_PER_PAGE);
  }, [filteredArticles, articlePage]);

  // Group paginated articles by section
  const articleGroups = useMemo(() => {
    const validSecIds = new Set(sections.map((s) => s.id));
    const sortedSectionsList = [...sections].sort(
      (a, b) => (a.order_index ?? 0) - (b.order_index ?? 0)
    );
    const groups: {
      sectionId: string | null;
      section: HelpSection | null;
      isUncategorised: boolean;
      articles: Article[];
    }[] = [];

    const map = new Map<string | null, Article[]>();
    for (const art of paginatedArticles) {
      const secId = art.section_id && validSecIds.has(art.section_id) ? art.section_id : null;
      if (!map.has(secId)) {
        map.set(secId, []);
      }
      map.get(secId)!.push(art);
    }

    for (const sec of sortedSectionsList) {
      if (map.has(sec.id)) {
        groups.push({
          sectionId: sec.id,
          section: sec,
          isUncategorised: false,
          articles: map.get(sec.id)!,
        });
      }
    }

    if (map.has(null)) {
      groups.push({
        sectionId: null,
        section: null,
        isUncategorised: true,
        articles: map.get(null)!,
      });
    }

    return groups;
  }, [paginatedArticles, sections]);

  // Drag to reorder inside section
  const [draggedArticleId, setDraggedArticleId] = useState<string | null>(null);
  const [dragOverArticleId, setDragOverArticleId] = useState<string | null>(null);

  const handleDragStart = (e: React.DragEvent, article: Article) => {
    e.dataTransfer.setData('text/plain', article.id);
    e.dataTransfer.effectAllowed = 'move';
    setDraggedArticleId(article.id);
  };

  const handleDragOver = (e: React.DragEvent, targetArticle: Article) => {
    if (!draggedArticleId || draggedArticleId === targetArticle.id) return;
    const dragged = articles.find((a) => a.id === draggedArticleId);
    if (!dragged) return;

    const validSecIds = new Set(sections.map((s) => s.id));
    const draggedSecId =
      dragged.section_id && validSecIds.has(dragged.section_id) ? dragged.section_id : null;
    const targetSecId =
      targetArticle.section_id && validSecIds.has(targetArticle.section_id)
        ? targetArticle.section_id
        : null;

    if (draggedSecId !== targetSecId) return;

    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverArticleId !== targetArticle.id) {
      setDragOverArticleId(targetArticle.id);
    }
  };

  const handleDragLeave = () => {
    setDragOverArticleId(null);
  };

  const handleDrop = async (e: React.DragEvent, targetArticle: Article) => {
    e.preventDefault();
    setDragOverArticleId(null);
    const draggedId = draggedArticleId || e.dataTransfer.getData('text/plain');
    setDraggedArticleId(null);

    if (!draggedId || draggedId === targetArticle.id || !workspace?.id) return;

    const dragged = articles.find((a) => a.id === draggedId);
    if (!dragged) return;

    const validSecIds = new Set(sections.map((s) => s.id));
    const draggedSecId =
      dragged.section_id && validSecIds.has(dragged.section_id) ? dragged.section_id : null;
    const targetSecId =
      targetArticle.section_id && validSecIds.has(targetArticle.section_id)
        ? targetArticle.section_id
        : null;

    if (draggedSecId !== targetSecId) {
      showToast('Can only reorder articles inside the same section', 'error');
      return;
    }

    const sectionArticles = articles
      .filter((a) => {
        const aSecId = a.section_id && validSecIds.has(a.section_id) ? a.section_id : null;
        return aSecId === targetSecId;
      })
      .sort((a, b) => {
        const ao = a.order_index ?? 0;
        const bo = b.order_index ?? 0;
        if (ao !== bo) return ao - bo;
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      });

    const draggedIdx = sectionArticles.findIndex((a) => a.id === draggedId);
    const targetIdx = sectionArticles.findIndex((a) => a.id === targetArticle.id);
    if (draggedIdx === -1 || targetIdx === -1) return;

    const reordered = [...sectionArticles];
    const [removed] = reordered.splice(draggedIdx, 1);
    reordered.splice(targetIdx, 0, removed);

    const updates = reordered.map((item, idx) => ({
      id: item.id,
      order_index: idx + 1,
    }));

    setArticles((prev) =>
      prev.map((art) => {
        const up = updates.find((u) => u.id === art.id);
        return up ? { ...art, order_index: up.order_index } : art;
      })
    );

    try {
      await reorderArticlesAction(workspace.id, updates);
      showToast('Article reordered successfully!');
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to reorder article'), 'error');
      loadHelpDeskData();
    }
  };

  const handleToggleStatus = async (article: Article) => {
    if (!workspace?.id) return;
    const nextStatus = article.status === 'published' ? 'draft' : 'published';
    try {
      const res = await toggleArticleStatusAction(workspace.id, article.id, nextStatus);
      if (res.article) {
        setArticles((prev) => prev.map((a) => (a.id === article.id ? res.article : a)));
        showToast(
          nextStatus === 'published'
            ? 'Article is live on your help centre.'
            : 'Article moved back to drafts.'
        );
      }
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to update article status'), 'error');
    }
  };

  const handleDeleteArticle = async (articleId: string, title: string) => {
    if (!workspace?.id) return;
    if (!confirm(`Are you sure you want to delete "${title}"? This cannot be undone.`)) return;

    try {
      await deleteArticleAction(workspace.id, articleId);
      setArticles((prev) => prev.filter((a) => a.id !== articleId));
      showToast(`"${title}" deleted.`);
    } catch (err: any) {
      showToast(errorMessage(err, 'Failed to delete article'), 'error');
    }
  };

  const handleOpenPublicHelpCenter = () => {
    if (!workspace) return;
    const url = getWorkspaceHelpCenterUrl(workspace);
    window.open(url, '_blank');
  };

  const handleCopyPublicHelpCenterLink = () => {
    if (!workspace) return;
    const url = getWorkspaceHelpCenterUrl(workspace);
    navigator.clipboard.writeText(url);
    showToast('Help Center link copied to clipboard!');
  };

  const handleCopyArticleLink = (art: Article) => {
    if (!workspace) return;
    const url = getWorkspaceHelpCenterUrl(workspace, art);
    navigator.clipboard.writeText(url);
    showToast(`Link for "${art.title}" copied!`);
  };

  const handleOpenArticleLive = (art: Article) => {
    if (!workspace) return;
    const url = getWorkspaceHelpCenterUrl(workspace, art);
    window.open(url, '_blank');
  };

  return (
    <div className="flex-1 flex flex-col h-screen overflow-y-auto bg-surface select-none">
      {/* Toast Notification */}
      {toastMessage && (
        <div
          className={cn(
            'fixed top-5 right-5 z-50 px-4 py-2.5 rounded-xl shadow-lg border text-ui font-medium flex items-center gap-2 animate-in fade-in slide-in-from-top-2',
            toastMessage.type === 'success'
              ? 'bg-success/10 text-success border-success/30'
              : 'bg-danger/10 text-danger border-danger/30'
          )}
        >
          <span>{toastMessage.text}</span>
        </div>
      )}

      {/* Top Navigation Bar */}
      <header className="px-8 py-5 border-b border-line/80 flex items-center justify-between gap-4 bg-surface sticky top-0 z-20">
        <div>
          <h1 className="text-xl font-semibold text-ink tracking-tight">
            Help Center
          </h1>
          <p className="text-xs text-ink-3 mt-0.5">
            {view === 'articles'
              ? 'Write once, and let customers answer their own questions.'
              : view === 'bot'
              ? 'What the bot should know beyond your articles, without publishing it.'
              : 'What your team knows but customers should not read — and what nobody has written yet.'}
          </p>
        </div>

        {/* One primary action, everything else behind the overflow.
            Five equal-weight buttons wrapped their own labels onto three lines
            at 1100px, none of them read as the main thing to do, and "Copy URL"
            was duplicated by the address bar directly below. */}
        <div className="flex items-center gap-2 shrink-0">
          <Menu
            value={'' as string}
            align="end"
            label="More Help Center actions"
            options={[
              { value: 'open', label: 'Open public help center' },
              { value: 'copy', label: 'Copy public link' },
              { value: 'sections', label: 'Manage sections' },
              {
                value: 'tab',
                label: `Widget tab: ${workspaceState?.help_center_tab_label || 'Help'}`,
              },
            ]}
            onChange={(v) => {
              if (v === 'open') handleOpenPublicHelpCenter();
              else if (v === 'copy') handleCopyPublicHelpCenterLink();
              else if (v === 'sections') {
                setEditingSection(null);
                setIsSectionModalOpen(true);
              } else if (v === 'tab') setIsTabSettingsModalOpen(true);
            }}
            trigger={() => (
              <span className="h-9 w-9 grid place-items-center rounded-lg border border-line bg-surface-2 text-ink-2 hover:text-ink hover:bg-surface transition-colors">
                <MoreHorizontal className="w-4 h-4" />
              </span>
            )}
          />

          {/* The primary action follows the view, so it is never the wrong one. */}
          <button
            onClick={() => {
              if (view === 'internal') {
                setNewNoteRequest(Date.now());
              } else if (view === 'bot') {
                setNewBotEntryRequest(Date.now());
              } else {
                setEditingArticle(null);
                setIsArticleModalOpen(true);
              }
            }}
            className="h-9 px-4 rounded-lg bg-accent text-accent-ink hover:opacity-90 text-ui font-semibold flex items-center gap-1.5 transition-all shadow-sm whitespace-nowrap"
          >
            <Plus className="w-4 h-4" />
            <span>{view === 'internal' ? 'New note' : view === 'bot' ? 'Add data' : 'New article'}</span>
          </button>
        </div>
      </header>

      {/* Domain Status Banner */}
      {workspace && (
        <div className="px-8 py-2 bg-surface-2/80 border-b border-line/60 flex items-center justify-between text-xs">
          <div className="flex items-center gap-2.5 min-w-0">
            <Globe className="w-3.5 h-3.5 text-accent shrink-0" />
            <span className="text-ink-3 shrink-0">Public URL:</span>
            <a
              href={getWorkspaceHelpCenterUrl(workspace)}
              target="_blank"
              rel="noreferrer"
              className="font-mono text-accent hover:underline font-semibold truncate"
            >
              {getWorkspaceHelpCenterUrl(workspace)}
            </a>
            <span className="px-2 py-0.5 rounded-full text-2xs font-bold uppercase tracking-wider shrink-0 bg-success/10 text-success border border-success/20 flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
              Live
            </span>
            {Boolean(workspace.custom_domain?.trim()) && (
              <span
                className={cn(
                  'px-2 py-0.5 rounded-full text-2xs font-bold uppercase tracking-wider shrink-0',
                  workspace.custom_domain_status === 'verified'
                    ? 'bg-success/10 text-success border border-success/20'
                    : workspace.custom_domain_status === 'failed'
                    ? 'bg-danger/10 text-danger border border-danger/20'
                    : 'bg-warn/10 text-warn border border-warn/20'
                )}
              >
                {workspace.custom_domain_status === 'verified'
                  ? 'Custom Domain Verified'
                  : workspace.custom_domain_status === 'failed'
                  ? 'Custom Domain DNS Failed'
                  : 'Custom Domain DNS Pending'}
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-4">
            <button
              onClick={handleCopyPublicHelpCenterLink}
              className="text-ink-3 hover:text-ink font-medium text-xs flex items-center gap-1 transition-colors px-2 py-1 rounded-md hover:bg-surface-3"
              title="Copy public URL"
            >
              <Copy className="w-3 h-3" />
              <span>Copy</span>
            </button>
            <a
              href={getWorkspaceHelpCenterUrl(workspace)}
              target="_blank"
              rel="noreferrer"
              className="text-accent hover:text-accent/80 font-medium text-xs flex items-center gap-1 transition-colors px-2 py-1 rounded-md hover:bg-accent-soft"
              title="Open public Help Center in new tab"
            >
              <ExternalLink className="w-3 h-3" />
              <span>Open</span>
            </a>
          </div>
        </div>
      )}

      <main className="p-8 space-y-6 max-w-7xl mx-auto w-full">
        <div className="inline-flex items-center p-0.5 rounded-lg bg-surface-2 border border-line">
          {(
            [
              ['articles', 'Published articles'],
              ['bot', 'Bot knowledge'],
              ['internal', 'Team knowledge & gaps'],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => setView(id)}
              className={cn(
                'h-7 px-3 rounded-md text-xs font-medium transition-all',
                view === id
                  ? 'bg-surface text-ink font-semibold shadow-xs'
                  : 'text-ink-3 hover:text-ink'
              )}
            >
              {label}
            </button>
          ))}
        </div>

        {view === 'bot' ? (
          <BotKnowledgePanel workspaceId={workspace?.id || ''} newEntrySignal={newBotEntryRequest} />
        ) : view === 'internal' ? (
          <KnowledgePanel
            workspaceId={workspace?.id || ''}
            newNoteSignal={newNoteRequest}
            onCreateArticle={(title) => {
              // Straight from the question a customer actually asked into a
              // draft, so the gap closes in one step instead of being
              // copy-pasted into a new article later.
              setView('articles');
              setEditingArticle({ title } as Article);
              setIsArticleModalOpen(true);
            }}
          />
        ) : (
        <>
        {/* Website Navbar Auto-Injector Callout Card */}
        {metrics.publishedCount >= 1 &&
          workspaceState?.navbar_trigger_config?.enabled !== true &&
          !workspaceState?.navbar_trigger_config?.dismissed_prompt &&
          !navbarPromptDismissed && (
            <div className="p-4 sm:p-5 rounded-2xl border border-accent/40 bg-accent-soft shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4 animate-in fade-in">
              <div className="flex items-start sm:items-center gap-3.5">
                <div className="w-10 h-10 rounded-xl bg-accent text-accent-ink flex items-center justify-center shrink-0 shadow-sm">
                  <Sparkles className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-md font-bold text-ink flex items-center gap-2">
                    <span>Your Help Center is live. Add it to your website menu?</span>
                    <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider bg-success/10 text-success border border-success/20">
                      Zero-Code
                    </span>
                  </h3>
                  <p className="text-xs text-ink-3 mt-0.5 max-w-xl">
                    Direct your website visitors to your documentation seamlessly without touching any code. Preview where the button appears and customize its style.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                <button
                  type="button"
                  onClick={handleDismissNavbarPrompt}
                  className="btn btn-sm btn-ghost text-ink-3 hover:text-ink text-xs"
                >
                  Not now
                </button>
                <button
                  type="button"
                  onClick={() => setIsNavbarModalOpen(true)}
                  className="btn btn-sm btn-primary gap-1.5 shadow-sm text-xs font-semibold"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  <span>Preview and add</span>
                </button>
              </div>
            </div>
          )}

        {/* KPI Metrics Cards */}
        <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-4 rounded-xl border border-line bg-surface-2/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">Total Articles</span>
              <BookOpen className="w-4 h-4 text-accent" />
            </div>
            {loading && articles.length === 0 ? (
              <>
                <div className="skeleton h-[30px] w-12 mt-2 rounded-md" />
                <div className="skeleton h-3 w-32 mt-2 rounded" />
              </>
            ) : (
              <>
                <div className="text-2xl font-bold text-ink mt-2">{metrics.totalArticles}</div>
                <div className="text-xs text-ink-3 mt-1 flex items-center gap-2">
                  <span className="text-success font-medium">{metrics.publishedCount} published</span>
                  <span>•</span>
                  <span className="text-warn font-medium">
                    {metrics.draftCount} {metrics.draftCount === 1 ? 'draft' : 'drafts'}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="p-4 rounded-xl border border-line bg-surface-2/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">Total Views</span>
              <Eye className="w-4 h-4 text-accent" />
            </div>
            <div className="text-2xl font-bold text-ink mt-2">{metrics.totalViews.toLocaleString()}</div>
            <div className="text-xs text-ink-3 mt-1">Across all published help guides</div>
          </div>

          <div className="p-4 rounded-xl border border-line bg-surface-2/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">Helpfulness Rate</span>
              <ThumbsUp className="w-4 h-4 text-success" />
            </div>
            <div className="text-2xl font-bold text-ink mt-2">
              {metrics.helpfulRate === null ? '—' : `${metrics.helpfulRate}%`}
            </div>
            <div className="text-xs text-ink-3 mt-1 flex items-center gap-2">
              {metrics.helpfulRate === null ? (
                <span>No reader votes yet</span>
              ) : (
                <>
                  <span>{metrics.totalHelpful} helpful</span>
                  <span>•</span>
                  <span>{metrics.totalNotHelpful} not helpful</span>
                </>
              )}
            </div>
          </div>

          <div className="p-4 rounded-xl border border-line bg-surface-2/60">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-ink-3 uppercase tracking-wider">Help Sections</span>
              <Layers className="w-4 h-4 text-accent" />
            </div>
            <div className="text-2xl font-bold text-ink mt-2">{sections.length}</div>
            <div className="text-xs text-ink-3 mt-1">Organized categories &amp; topics</div>
          </div>
        </section>

        {/* Section Navigation Tabs & Pills */}
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 overflow-x-auto pb-1 min-w-0 flex-1 scrollbar-none">
              <button
                onClick={() => setSelectedSectionId('all')}
                className={cn(
                  'h-8 px-3 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5',
                  selectedSectionId === 'all'
                    ? 'bg-accent text-accent-ink shadow-xs'
                    : 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink'
                )}
              >
                <span>All Sections</span>
                <span className="text-2xs opacity-80">({articles.length})</span>
              </button>

              {/* Uncategorised (N) Chip */}
              {uncategorisedCount > 0 && (
                <button
                  type="button"
                  onClick={() => setSelectedSectionId('uncategorised')}
                  className={cn(
                    'h-8 px-3 rounded-lg text-xs font-medium transition-all whitespace-nowrap flex items-center gap-1.5 border',
                    selectedSectionId === 'uncategorised'
                      ? 'bg-warn text-white border-transparent shadow-xs font-semibold'
                      : 'bg-warn/10 text-warn border-warn/30 hover:bg-warn/20'
                  )}
                  title="Articles without a section or with legacy category"
                >
                  <AlertCircle className="w-3.5 h-3.5" />
                  <span>Uncategorised</span>
                  <span className="text-2xs font-bold px-1.5 py-0.2 rounded-full bg-warn/20 text-inherit">
                    {uncategorisedCount}
                  </span>
                </button>
              )}

              {sections.map((sec, idx) => {
                const isSelected = selectedSectionId === sec.id;
                return (
                  <div
                    key={sec.id}
                    className={cn(
                      'group relative inline-flex items-center h-8 rounded-lg text-xs font-medium transition-all whitespace-nowrap border',
                      isSelected
                        ? 'bg-accent text-accent-ink border-transparent shadow-xs'
                        : 'bg-surface-2 text-ink-2 hover:bg-surface-3 hover:text-ink border-transparent'
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => setSelectedSectionId(sec.id)}
                      className="h-full pl-3 pr-2 flex items-center gap-1.5 cursor-pointer"
                    >
                      <span className="font-mono text-2xs font-bold opacity-75">
                        #{String(idx + 1).padStart(2, '0')}
                      </span>
                      <span>{sec.icon || '📚'}</span>
                      <span className="max-w-[130px] truncate">{sec.name}</span>
                      <span className="text-2xs opacity-75">({sectionCounts[sec.id] || 0})</span>
                    </button>

                    {/* Quick rename & delete actions on pill hover */}
                    <div className="flex items-center pr-1.5 gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartRenameSection(sec);
                        }}
                        className={cn(
                          'w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer',
                          isSelected
                            ? 'hover:bg-white/20 text-accent-ink'
                            : 'hover:bg-surface text-ink-3 hover:text-ink'
                        )}
                        title={`Rename section "${sec.name}"`}
                      >
                        <Edit2 className="w-3 h-3" />
                      </button>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleStartDeleteSection(sec);
                        }}
                        className={cn(
                          'w-5 h-5 rounded flex items-center justify-center transition-colors cursor-pointer',
                          isSelected
                            ? 'hover:bg-danger text-accent-ink hover:text-white'
                            : 'hover:bg-danger/20 text-ink-3 hover:text-danger'
                        )}
                        title={`Delete section "${sec.name}"`}
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Fixed buttons next to the section chips */}
            <div className="flex items-center gap-1.5 shrink-0 pl-2 border-l border-line/60">
              <button
                type="button"
                onClick={() => {
                  setEditingSection(null);
                  setIsSectionModalOpen(true);
                }}
                className="h-8 px-2.5 rounded-lg border border-dashed border-line text-xs text-ink-3 hover:text-accent hover:border-accent flex items-center gap-1 transition-all whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-3 h-3" />
                <span>Add Section</span>
              </button>
              <button
                type="button"
                onClick={() => {
                  setEditingSection(null);
                  setIsSectionModalOpen(true);
                }}
                className="h-8 px-2.5 rounded-lg bg-surface-2 hover:bg-surface-3 text-xs text-ink-2 hover:text-ink flex items-center gap-1.5 transition-all whitespace-nowrap cursor-pointer border border-line/60"
                title="Manage all sections (reorder, rename, delete, custom icons)"
              >
                <Settings className="w-3 h-3 text-ink-3" />
                <span>Manage Sections</span>
              </button>
            </div>
          </div>

          {/* Active Section Banner with direct Rename and Delete controls */}
          {activeSection && (
            <div className="p-3.5 sm:p-4 rounded-xl border border-accent/30 bg-accent/5 flex flex-col md:flex-row md:items-center justify-between gap-3.5 animate-in fade-in">
              <div className="flex items-center gap-3 min-w-0">
                <SectionIconPreview
                  icon={activeSection.icon}
                  className="w-10 h-10 rounded-xl bg-surface border border-line shadow-xs text-xl shrink-0"
                  imgClassName="w-6 h-6 object-contain"
                />
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-2xs font-bold px-1.5 py-0.5 rounded-md bg-surface border border-line text-ink-3">
                      Section #{String(sections.findIndex((s) => s.id === activeSection.id) + 1).padStart(2, '0')}
                    </span>
                    <h2 className="text-md font-bold text-ink truncate">{activeSection.name}</h2>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-accent/10 text-accent border border-accent/20">
                      {sectionCounts[activeSection.id] || 0} articles
                    </span>
                  </div>
                  {activeSection.description ? (
                    <p className="text-xs text-ink-3 mt-0.5 line-clamp-1">{activeSection.description}</p>
                  ) : (
                    <p className="text-xs text-ink-3 italic mt-0.5">No description set for this section.</p>
                  )}
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 self-start md:self-auto flex-wrap">
                <button
                  type="button"
                  onClick={() => handleStartRenameSection(activeSection)}
                  className="h-8 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                  title="Rename or update this section"
                >
                  <Edit2 className="w-3.5 h-3.5 text-accent" />
                  <span>Rename Section</span>
                </button>

                <button
                  type="button"
                  onClick={() => handleStartDeleteSection(activeSection)}
                  className="h-8 px-3 rounded-lg border border-danger/20 bg-danger/5 hover:bg-danger/15 text-danger text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer"
                  title="Delete this section"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Section</span>
                </button>

                <button
                  type="button"
                  onClick={() => setIsReorderModalOpen(true)}
                  className="h-8 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
                  title="Change the display order of articles in this section"
                >
                  <ArrowUpDown className="w-3.5 h-3.5 text-accent" />
                  <span>Reorder Articles</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setEditingArticle({ section_id: activeSection.id } as Article);
                    setIsArticleModalOpen(true);
                  }}
                  className="h-8 px-3 rounded-lg bg-accent text-accent-ink hover:opacity-95 text-xs font-semibold flex items-center gap-1.5 transition-all shadow-xs cursor-pointer"
                  title="Create a new article directly in this section"
                >
                  <Plus className="w-3.5 h-3.5" />
                  <span>New Article</span>
                </button>

                <button
                  type="button"
                  onClick={() => setSelectedSectionId('all')}
                  className="h-8 w-8 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink-3 hover:text-ink flex items-center justify-center transition-colors cursor-pointer"
                  title="View all sections"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          {/* Uncategorised Articles Banner */}
          {selectedSectionId === 'uncategorised' && (
            <div className="p-3.5 sm:p-4 rounded-xl border border-warn/30 bg-warn/5 flex flex-col md:flex-row md:items-center justify-between gap-3.5 animate-in fade-in">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-10 h-10 rounded-xl bg-warn/10 border border-warn/20 text-warn flex items-center justify-center text-lg shrink-0">
                  <AlertCircle className="w-5 h-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <h2 className="text-md font-bold text-ink">Uncategorised Articles</h2>
                    <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-warn/15 text-warn border border-warn/30">
                      {uncategorisedCount} {uncategorisedCount === 1 ? 'article' : 'articles'}
                    </span>
                  </div>
                  <p className="text-xs text-ink-3 mt-0.5">
                    These articles have no section or point to a legacy category. Run the automatic migration to create or match sections from their categories.
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2 shrink-0 self-start md:self-auto flex-wrap">
                <button
                  type="button"
                  disabled={isMigrating}
                  onClick={handleRunMigration}
                  className="h-8 px-3.5 rounded-lg bg-warn hover:bg-warn text-white text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs disabled:opacity-50"
                  title="Automatically match or create sections from legacy categories"
                >
                  <Sparkles className={cn('w-3.5 h-3.5', isMigrating && 'animate-spin')} />
                  <span>{isMigrating ? 'Migrating...' : 'Organize & Migrate All'}</span>
                </button>
              </div>
            </div>
          )}

          {/* Search and Status Filters */}
          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-1">
            <div className="relative w-full sm:w-80">
              <Search className="w-4 h-4 text-ink-3 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search articles by title, content..."
                className="w-full h-9 pl-9 pr-3 rounded-lg border border-line bg-surface-2/70 text-ui text-ink placeholder:text-ink-3 focus:outline-none focus:border-accent focus:bg-surface transition-all"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <div className="flex items-center gap-2 self-end sm:self-auto">
              <div className="flex items-center p-0.5 rounded-lg bg-surface-2 border border-line">
                {(['all', 'published', 'draft'] as const).map((status) => (
                  <button
                    key={status}
                    onClick={() => setSelectedStatus(status)}
                    className={cn(
                      'px-2.5 py-1 rounded-md text-xs font-medium transition-all capitalize',
                      selectedStatus === status
                        ? 'bg-surface text-ink shadow-xs font-semibold'
                        : 'text-ink-3 hover:text-ink'
                    )}
                  >
                    {status}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* Articles List / Grid */}
        <section className="space-y-3">
          {loading ? (
            <div className="p-12 text-center text-ink-3 text-ui">Loading help articles...</div>
          ) : filteredArticles.length === 0 ? (
            <div className="p-12 rounded-2xl border border-dashed border-line text-center space-y-3 bg-surface-2/40">
              <BookOpen className="w-10 h-10 text-ink-3 mx-auto stroke-1" />
              <div className="text-md font-semibold text-ink">No articles found</div>
              <p className="text-xs text-ink-3 max-w-sm mx-auto">
                {searchQuery
                  ? 'No articles match your search filter. Try clearing the search query.'
                  : 'Start building your Knowledge Base so customers can resolve questions on their own.'}
              </p>
              <button
                onClick={() => {
                  setEditingArticle(null);
                  setIsArticleModalOpen(true);
                }}
                className="h-8 px-3.5 rounded-lg bg-accent text-accent-ink text-xs font-semibold inline-flex items-center gap-1.5 transition-all shadow-xs"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Create Your First Article</span>
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {articleGroups.map((group) => {
                const groupTitle = group.section ? group.section.name : 'Uncategorised';
                const groupIcon = group.section ? group.section.icon || '📚' : null;
                const groupDesc = group.section?.description;
                const totalCount = group.section ? (sectionCounts[group.section.id] || group.articles.length) : group.articles.length;

                return (
                  <div
                    key={group.sectionId || 'uncategorised'}
                    className="border border-line rounded-xl overflow-hidden bg-surface shadow-xs"
                  >
                    {/* Section Group Header */}
                    <div
                      className={cn(
                        'px-4 py-2.5 flex items-center justify-between gap-3 border-b',
                        group.isUncategorised
                          ? 'bg-warn/10 border-warn/20 text-warn'
                          : 'bg-surface-2/80 border-line text-ink'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {group.isUncategorised ? (
                          <AlertCircle className="w-4 h-4 text-warn shrink-0" />
                        ) : (
                          <span className="text-md shrink-0">{groupIcon}</span>
                        )}
                        <span className="text-ui font-semibold truncate">
                          {groupTitle}
                        </span>
                        {groupDesc && (
                          <span className="text-xs text-ink-3 hidden sm:inline truncate max-w-md">
                            — {groupDesc}
                          </span>
                        )}
                      </div>

                      <span
                        className={cn(
                          'text-xs font-medium px-2 py-0.5 rounded-full shrink-0',
                          group.isUncategorised
                            ? 'bg-warn/20 text-warn'
                            : 'bg-surface border border-line text-ink-3'
                        )}
                      >
                        {totalCount} {totalCount === 1 ? 'article' : 'articles'}
                      </span>
                    </div>

                    {/* Section Articles */}
                    <div className="divide-y divide-line/80">
                      {group.articles.map((article) => {
                        const isPublished = article.status === 'published';
                        const isDragging = draggedArticleId === article.id;
                        const isDragOver = dragOverArticleId === article.id;

                        return (
                          <div
                            key={article.id}
                            id={`article-item-${article.id}`}
                            draggable
                            onDragStart={(e) => handleDragStart(e, article)}
                            onDragOver={(e) => handleDragOver(e, article)}
                            onDragLeave={handleDragLeave}
                            onDrop={(e) => handleDrop(e, article)}
                            onDragEnd={() => {
                              setDraggedArticleId(null);
                              setDragOverArticleId(null);
                            }}
                            className={cn(
                              'p-4 hover:bg-surface-2/50 transition-all flex flex-col md:flex-row items-start md:items-center justify-between gap-4 group cursor-default',
                              isDragging && 'opacity-40 bg-surface-2/60',
                              isDragOver && 'border-t-2 border-accent bg-accent/5'
                            )}
                          >
                            <div className="min-w-0 flex-1 space-y-1.5">
                              <div className="flex items-center gap-2.5 flex-wrap">
                                {/* Drag Handle */}
                                <div
                                  className="cursor-grab active:cursor-grabbing text-ink-3 hover:text-ink p-0.5 rounded hover:bg-surface transition-colors shrink-0"
                                  title="Drag to reorder inside section"
                                >
                                  <GripVertical className="w-3.5 h-3.5" />
                                </div>

                                <span
                                  className={cn(
                                    'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-2xs font-semibold',
                                    isPublished
                                      ? 'bg-success/10 text-success border border-success/20'
                                      : 'bg-warn/10 text-warn border border-warn/20'
                                  )}
                                >
                                  <span
                                    className={cn(
                                      'w-1.5 h-1.5 rounded-full',
                                      isPublished ? 'bg-success' : 'bg-warn'
                                    )}
                                  />
                                  {isPublished ? 'Published' : 'Draft'}
                                </span>

                                {/* Order Index Badge */}
                                {article.order_index && article.order_index > 0 ? (
                                  <span
                                    className="font-mono text-2xs font-bold px-1.5 py-0.5 rounded bg-surface-2 border border-line text-ink-3"
                                    title="Display order within section"
                                  >
                                    #{String(article.order_index).padStart(2, '0')}
                                  </span>
                                ) : null}

                                <span className="text-2xs text-ink-3">
                                  Updated {new Date(article.updated_at || article.created_at).toLocaleDateString()}
                                </span>
                              </div>

                              <h3
                                onClick={() => {
                                  setEditingArticle(article);
                                  setIsArticleModalOpen(true);
                                }}
                                className="text-sm font-semibold text-ink hover:text-accent cursor-pointer transition-colors"
                              >
                                {article.title}
                              </h3>

                              {article.summary && (
                                <p className="text-xs text-ink-2 line-clamp-1 max-w-2xl">
                                  {article.summary}
                                </p>
                              )}
                            </div>

                            {/* Stats & Actions */}
                            <div className="flex items-center gap-5 shrink-0 text-xs text-ink-3">
                              <div className="flex items-center gap-3">
                                <span className="flex items-center gap-1" title="Total Views">
                                  <Eye className="w-3.5 h-3.5 text-ink-3" />
                                  <span>{article.views_count || 0}</span>
                                </span>

                                <span className="flex items-center gap-1" title="Helpful votes">
                                  <ThumbsUp className="w-3.5 h-3.5 text-success/80" />
                                  <span>{article.helpful_count || 0}</span>
                                </span>

                                {Boolean(article.not_helpful_count) && (
                                  <span className="flex items-center gap-1" title="Unhelpful votes">
                                    <ThumbsDown className="w-3.5 h-3.5 text-danger/80" />
                                    <span>{article.not_helpful_count}</span>
                                  </span>
                                )}
                              </div>

                              <div className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleCopyArticleLink(article)}
                                  className="h-8 w-8 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink transition-colors"
                                  title="Copy public article link"
                                >
                                  <Link2 className="w-3.5 h-3.5" />
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleOpenArticleLive(article)}
                                  className="h-8 w-8 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink transition-colors"
                                  title="Open live article"
                                >
                                  <ExternalLink className="w-3.5 h-3.5" />
                                </button>

                                <button
                                  type="button"
                                  onClick={() => handleToggleStatus(article)}
                                  className="h-8 px-2.5 rounded-md text-xs font-medium border border-line hover:bg-surface-2 text-ink transition-colors"
                                  title={isPublished ? 'Unpublish to draft' : 'Publish live'}
                                >
                                  {isPublished ? 'Unpublish' : 'Publish'}
                                </button>

                                <button
                                  type="button"
                                  onClick={() => {
                                    setEditingArticle(article);
                                    setIsArticleModalOpen(true);
                                  }}
                                  className="h-8 w-8 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-2 hover:text-ink transition-colors"
                                  title="Edit article"
                                >
                                  <Edit2 className="w-3.5 h-3.5" />
                                </button>

                                {/* More actions ("...") dropdown containing Delete with confirmation */}
                                <Menu
                                  value=""
                                  align="end"
                                  label={`More actions for "${article.title}"`}
                                  options={[
                                    { value: 'edit', label: 'Edit article' },
                                    { value: 'copy', label: 'Copy link' },
                                    { value: 'live', label: 'Open live article' },
                                    { value: 'status', label: isPublished ? 'Unpublish to draft' : 'Publish live' },
                                    { value: 'delete', label: 'Delete article', danger: true },
                                  ]}
                                  onChange={(val) => {
                                    if (val === 'edit') {
                                      setEditingArticle(article);
                                      setIsArticleModalOpen(true);
                                    } else if (val === 'copy') {
                                      handleCopyArticleLink(article);
                                    } else if (val === 'live') {
                                      handleOpenArticleLive(article);
                                    } else if (val === 'status') {
                                      handleToggleStatus(article);
                                    } else if (val === 'delete') {
                                      handleDeleteArticle(article.id, article.title);
                                    }
                                  }}
                                  trigger={() => (
                                    <span
                                      className="h-8 w-8 rounded-md hover:bg-surface-2 flex items-center justify-center text-ink-3 hover:text-ink transition-colors cursor-pointer"
                                      title="More options"
                                    >
                                      <MoreHorizontal className="w-4 h-4" />
                                    </span>
                                  )}
                                />
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Pagination footer (25 per page) */}
              {totalArticlePages > 1 && (
                <div className="flex items-center justify-between px-3 py-2.5 rounded-xl border border-line bg-surface text-xs text-ink-3 shadow-xs">
                  <span>
                    Showing {(articlePage - 1) * ARTICLES_PER_PAGE + 1} to{' '}
                    {Math.min(articlePage * ARTICLES_PER_PAGE, filteredArticles.length)} of {filteredArticles.length} articles
                  </span>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      disabled={articlePage <= 1}
                      onClick={() => setArticlePage((p) => Math.max(1, p - 1))}
                      className="h-7 px-2.5 rounded-md border border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none inline-flex items-center gap-1 text-xs font-medium"
                    >
                      <ChevronLeft className="w-3.5 h-3.5" />
                      Previous
                    </button>
                    <div className="flex items-center gap-1 px-1">
                      {Array.from({ length: totalArticlePages }, (_, i) => i + 1).map((pg) => (
                        <button
                          key={pg}
                          type="button"
                          onClick={() => setArticlePage(pg)}
                          className={cn(
                            'w-7 h-7 rounded-md text-xs font-semibold transition-all',
                            articlePage === pg
                              ? 'bg-accent text-accent-ink shadow-xs'
                              : 'text-ink-2 hover:bg-surface-2 hover:text-ink'
                          )}
                        >
                          {pg}
                        </button>
                      ))}
                    </div>
                    <button
                      type="button"
                      disabled={articlePage >= totalArticlePages}
                      onClick={() => setArticlePage((p) => Math.min(totalArticlePages, p + 1))}
                      className="h-7 px-2.5 rounded-md border border-line bg-surface text-ink hover:bg-surface-2 disabled:opacity-30 disabled:pointer-events-none inline-flex items-center gap-1 text-xs font-medium"
                    >
                      Next
                      <ChevronRight className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </section>
        </>
        )}
      </main>

      {/* NAVBAR PREVIEW & SETUP MODAL */}
      {isNavbarModalOpen && workspaceState && (
        <NavbarPreviewModal
          isOpen={isNavbarModalOpen}
          onClose={() => setIsNavbarModalOpen(false)}
          workspace={workspaceState}
          onConfigSaved={(updatedWs) => {
            setWorkspaceState(updatedWs);
            showToast('Help button added to your website navbar! Changes are live.');
          }}
          showToast={showToast}
        />
      )}

      {/* ARTICLE EDITOR MODAL */}
      {isArticleModalOpen && (
        <ArticleEditor
          workspace={workspace}
          workspaceId={workspace?.id || ''}
          sections={sections}
          article={editingArticle}
          templates={getArticleBlueprints(workspace)}
          onPersisted={() => void loadHelpDeskData()}
          onClose={() => {
            setIsArticleModalOpen(false);
            setEditingArticle(null);
          }}
          onSaved={(savedArticle) => {
            setIsArticleModalOpen(false);
            setEditingArticle(null);
            showToast(`Article "${savedArticle.title}" saved successfully!`);
            // Ensure filters do not hide the newly saved/updated article
            if (selectedStatus !== 'all' && selectedStatus !== savedArticle.status) {
              setSelectedStatus('all');
            }
            if (searchQuery.trim()) {
              setSearchQuery('');
            }
            if (
              selectedSectionId !== 'all' &&
              savedArticle.section_id &&
              selectedSectionId !== savedArticle.section_id
            ) {
              setSelectedSectionId(savedArticle.section_id);
            }
            loadHelpDeskData();
            setTimeout(() => {
              const el = document.getElementById(`article-item-${savedArticle.id}`);
              if (el) {
                el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                el.classList.add('ring-2', 'ring-accent', 'bg-accent/10');
                setTimeout(() => {
                  el.classList.remove('ring-2', 'ring-accent', 'bg-accent/10');
                }, 3000);
              }
            }, 350);
          }}
        />
      )}

      {/* SECTIONS MANAGER MODAL */}
      {isSectionModalOpen && (
        <SectionsManagerModal
          workspace={workspace}
          workspaceId={workspace?.id || ''}
          sections={sections}
          articleCounts={sectionCounts}
          initialEditingSection={editingSection}
          uncategorisedCount={uncategorisedCount}
          onRunMigration={handleRunMigration}
          onClose={() => {
            setIsSectionModalOpen(false);
            setEditingSection(null);
          }}
          onSectionsChanged={() => {
            loadHelpDeskData();
          }}
          onDeleteRequest={(sec) => {
            setIsSectionModalOpen(false);
            setSectionToDelete(sec);
          }}
        />
      )}

      {/* QUICK RENAME SECTION MODAL */}
      {sectionToRename && (
        <QuickRenameSectionModal
          workspace={workspace}
          workspaceId={workspace?.id || ''}
          section={sectionToRename}
          onClose={() => setSectionToRename(null)}
          onUpdated={handleSectionUpdated}
          onDeleteRequest={(sec) => {
            setSectionToRename(null);
            handleStartDeleteSection(sec);
          }}
        />
      )}

      {/* DELETE SECTION CONFIRM MODAL */}
      {sectionToDelete && (
        <DeleteSectionConfirmModal
          section={sectionToDelete}
          sections={sections}
          articleCount={sectionCounts[sectionToDelete.id] || 0}
          isDeleting={isDeletingSection}
          onClose={() => setSectionToDelete(null)}
          onConfirm={handleConfirmDeleteSection}
        />
      )}

      {/* REORDER ARTICLES MODAL */}
      {isReorderModalOpen && activeSection && (
        <ReorderArticlesModal
          workspaceId={workspace?.id || ''}
          section={activeSection}
          articles={activeSectionArticles}
          onClose={() => setIsReorderModalOpen(false)}
          onSaved={(updatedSectionArticles: Article[]) => {
            setIsReorderModalOpen(false);
            setArticles((prev) =>
              prev.map((art) => {
                const up = updatedSectionArticles.find((u: Article) => u.id === art.id);
                return up ? { ...art, order_index: up.order_index } : art;
              })
            );
            showToast(`Article order for "${activeSection.name}" updated successfully!`);
          }}
        />
      )}

      {/* WIDGET TAB SETTINGS MODAL */}
      {isTabSettingsModalOpen && workspaceState && (
        <WidgetTabSettingsModal
          workspace={workspaceState}
          onClose={() => setIsTabSettingsModalOpen(false)}
          onUpdated={(updatedWs) => {
            setWorkspaceState(updatedWs);
            showToast(`Widget tab renamed to "${updatedWs.help_center_tab_label || 'Help'}"!`);
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// ARTICLE BLUEPRINTS (Generic Default Templates + Industry Specific)
// ============================================================================
export const GENERIC_BLUEPRINTS = [
  {
    id: 'faq',
    label: '❓ FAQ',
    name: 'Frequently Asked Questions',
    desc: 'Structured Q&A format for common questions and answers',
    content: `# ❓ Frequently Asked Questions

Find quick answers to common questions about our platform and services.

### Q: How do I get started?
Sign up for an account, verify your email, and follow our quick setup guide to configure your workspace.

### Q: Where can I manage my account details?
You can update your personal information, email address, and security preferences directly in your Account Settings.

### Q: What payment methods are supported?
We accept major credit cards (Visa, MasterCard, American Express), bank transfers, and standard online payment providers.

> [!NOTE]
> Have a question that isn't answered here? Reach out to our 24/7 support team via live chat.`,
  },
  {
    id: 'step-guide',
    label: '📋 Step Guide',
    name: 'Step-by-Step Tutorial',
    desc: 'Actionable walkthrough with prerequisites, numbered steps & tips',
    content: `# 📋 Step-by-Step Guide

A clear walkthrough explaining how to complete this task successfully.

> [!NOTE]
> Before you begin, ensure you have your account credentials and necessary permissions ready.

## 1. Prerequisites
- [ ] Active verified account
- [ ] Access to the workspace dashboard
- [ ] Administrator or manager role

## 2. Step-by-Step Instructions
1. Navigate to your **Settings** panel from the sidebar navigation.
2. Select the **Configuration** tab and review the available options.
3. Apply your preferred settings and click **Save Changes**.

> [!TIP]
> Configuration changes take effect immediately across all connected apps.

## 3. Common Troubleshooting
- **Settings not saving?** Verify that all required fields are filled out.
- **Missing options?** Check that your role has administrative privileges.

---
*Still need help? Reach out to our 24/7 support team via live chat.*`,
  },
  {
    id: 'policy',
    label: '📜 Policy',
    name: 'Standard Policy & Rules',
    desc: 'Compliance criteria, usage rules, and guidelines',
    content: `# 📜 Standard Policy & Terms

This policy outlines the guidelines, requirements, and compliance rules applicable to all users.

> [!IMPORTANT]
> All users must adhere to these policies to maintain account standing.

## General Guidelines
- Maintain account security by using strong passwords and multi-factor authentication (MFA).
- Keep contact and billing information accurate and up to date.
- Comply with all local and international terms of service.

## Account Status & Compliance
- **Good Standing**: Accounts adhering to standard terms and usage guidelines.
- **Under Review**: Accounts undergoing routine security or identity verification.
- **Suspended**: Accounts involved in prohibited behavior or terms violations.

> [!WARNING]
> Repeated violations of platform rules will lead to permanent account deactivation.`,
  },
  {
    id: 'troubleshooting',
    label: '🛠️ Troubleshooting',
    name: 'Troubleshooting Guide',
    desc: 'Error symptoms, root causes, and verified fix steps',
    content: `# 🛠️ Troubleshooting & Fix Guide

Quick solutions for unexpected errors or issues you might encounter.

> [!IMPORTANT]
> Always make sure you are running the latest browser version before proceeding.

## Symptoms & Fixes

### Issue: Unable to log in or session expired
1. **Clear cache and cookies**: Clear your browser browsing data or open a private/incognito window.
2. **Password reset**: Click the "Forgot Password" link on the login page to receive a reset email.
3. **Check connection**: Ensure your network is active and disable any conflicting VPNs.

### Issue: Changes not appearing on the dashboard
1. Perform a hard refresh (\`Ctrl + F5\` or \`Cmd + Shift + R\`).
2. Verify that your recent edits were saved with a success confirmation toast.

> [!TIP]
> If the issue persists, contact our support team with your browser version and error screenshot.`,
  },
  {
    id: 'comparison',
    label: '📊 Comparison',
    name: 'Feature & Plan Comparison',
    desc: 'Side-by-side comparison table, tier matrix, and recommendations',
    content: `# 📊 Plan & Feature Comparison

Compare available plans and features to choose the right fit for your team.

## Overview Matrix

| Feature | Starter Plan | Pro Plan | Enterprise |
|:---|:---|:---|:---|
| Team Members | Up to 3 | Up to 15 | Unlimited |
| Storage | 5 GB | 50 GB | 1 TB |
| Response Time | 24 Hours | 4 Hours | Instant / 1 Hour |
| Custom Domain | - | Included | Included |
| Dedicated Manager | - | - | Included |

## Choosing the Right Option
- **Starter**: Best for individual creators and early-stage projects.
- **Pro**: Ideal for growing businesses needing team collaboration and custom branding.
- **Enterprise**: Built for organizations requiring SLA guarantees and advanced compliance.

> [!CTA]
> **Ready to upgrade?**
> *Visit your billing settings to switch plans anytime with prorated billing.*`,
  },
];

export const PROPFIRM_BLUEPRINTS = [
  {
    id: 'aquafunded-split',
    label: '🏆 Profit Split & Payouts',
    name: 'Profit Split Policy (AquaFunded Style)',
    desc: '90% standard split, 100% upgrade notice, reward calculations & CTA',
    content: `# 🏆 What is the Profit Split?

Traders receive a ==90% profit split== as standard on all evaluation and funded accounts.

### Example Calculation
If a trader earns a profit of **$5,000** and requests a payout reward, they will receive **$4,500** as their total reward directly to their preferred method.

> [!SUCCESS]
> **100% PROFIT SPLIT UPGRADE**
> Upon checkout, you have the option to upgrade with an add-on to:
> - [badge:emerald:100% PROFIT SPLIT]
> Keep every single dollar you generate through your trading strategy!

## Supported Payout Methods
We process reward payouts within **24 hours** through the following gateways:

| Method | Min Amount | Processing Time | Fee |
|:---|:---|:---|:---|
| Crypto (USDT / BTC) | $50 | Instant - 2 Hours | $0 |
| Bank Wire (Direct) | $200 | 1 - 2 Business Days | $0 |
| Deel / Rise | $100 | Same Day | $0 |

> [!CTA]
> **Trade with our capital and keep 100% of the profit**
> *Take advantage of our limited time evaluation sale live now.*
> [button:Get Funded](https://www.aquafunded.com/#Evaluations)`,
  },
  {
    id: 'aquafunded-risk',
    label: '⚡ Floating Loss & Risk',
    name: 'Maximum Loss Per Trade Policy',
    desc: '-2% risk limits, violation consequences, and account scaling tiers',
    content: `# ⚡ Maximum Loss Per Trade Policy

For all Instant Funding Models & AquaMan Models, if your floating PnL (profit and loss) drops below ==-2% of the account starting balance==, the account will be closed immediately.

This ensures strict adherence to risk management protocols and safeguards the integrity of our funding process.

### Floating Loss Example
For a **$50,000** account balance, if your combined open PnL across all active positions reaches a loss of ==$1,000 (-2%)==, the account will be permanently breached.

> [!WARNING]
> **Important Note for $300,000 & $400,000 Accounts**
> For $300k and $400k accounts, a stricter floating risk limit of ==-1%== applies to manage market exposure.

## Consequences for Exceeding the Risk Limit:
- [ ] Immediate and permanent closure of the breached account.
- [ ] No further trading activity permitted on the account.
- [ ] Remaining balance is settled according to evaluation terms.

> [!DANGER]
> **Zero Tolerance Violations**
> Hedging between different accounts, latency arbitrage, or account sharing will result in permanent ban from the platform.

---

> [!CTA]
> **Need help configuring risk on your platform?**
> *Our 24/7 team is available to assist you with lot size calculators.*
> [button:Contact Support](https://trading.aquafunded.com)`,
  },
  {
    id: 'aquafunded-faq',
    label: '❓ Trading Rules FAQ',
    name: 'Trading Rules & Conditions FAQ',
    desc: 'EAs, copy trading, holding trades overnight and weekend rules',
    content: `# ❓ General Trading Rules & FAQ

Find answers to common operational and strategy questions below.

### Q: Are EAs & Trade Copiers allowed?
==Yes.== Expert Advisors (EAs), algorithms, and trade copiers between your own personal accounts are fully permitted.

### Q: Can I hold trades overnight and over the weekend?
==Yes.== You are free to hold positions overnight and across the weekend on all swing and evaluation models without restriction.

### Q: Is there a maximum lot limit?
No, there is no arbitrary max lot limit. You can trade any position size that fits within your margin and max drawdown boundaries.

> [!NOTE]
> **News Trading Guidelines**
> You are permitted to trade high-impact news releases without restrictions on standard evaluation phases.

### Q: Do you allow hedging and martingale?
==Hedging is allowed== within the same trading account. Martingale strategies are permitted as long as you do not exceed max drawdown.

> [!CTA]
> **Ready to test your trading skills?**
> [button:Start Evaluation Challenge](https://www.aquafunded.com/#Evaluations)`,
  },
];

export function getArticleBlueprints(workspace?: Workspace | null) {
  if (isTradingWorkspace(workspace)) {
    return [...GENERIC_BLUEPRINTS, ...PROPFIRM_BLUEPRINTS];
  }
  return GENERIC_BLUEPRINTS;
}

export const ARTICLE_BLUEPRINTS = GENERIC_BLUEPRINTS;

// ============================================================================
// REORDER ARTICLES MODAL COMPONENT
// ============================================================================
interface ReorderArticlesModalProps {
  workspaceId: string;
  section: HelpSection;
  articles: Article[];
  onClose: () => void;
  onSaved: (updatedSectionArticles: Article[]) => void;
}

function ReorderArticlesModal({
  workspaceId,
  section,
  articles,
  onClose,
  onSaved,
}: ReorderArticlesModalProps) {
  // Sort initially by order_index ascending, then created_at
  const [list, setList] = useState<Article[]>(() => {
    return [...articles].sort((a, b) => {
      const ao = a.order_index ?? 0;
      const bo = b.order_index ?? 0;
      if (ao !== bo) return ao - bo;
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });
  });

  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Check if current order differs from initial
  const hasChanges = useMemo(() => {
    if (list.length !== articles.length) return true;
    return list.some((item, index) => item.id !== articles[index]?.id);
  }, [list, articles]);

  const handleMove = (index: number, direction: 'up' | 'down') => {
    const targetIndex = direction === 'up' ? index - 1 : index + 1;
    if (targetIndex < 0 || targetIndex >= list.length) return;

    const copy = [...list];
    const temp = copy[index];
    copy[index] = copy[targetIndex];
    copy[targetIndex] = temp;
    setList(copy);
  };

  const handleMoveToTop = (index: number) => {
    if (index === 0) return;
    const copy = [...list];
    const [item] = copy.splice(index, 1);
    copy.unshift(item);
    setList(copy);
  };

  const handleMoveToBottom = (index: number) => {
    if (index === list.length - 1) return;
    const copy = [...list];
    const [item] = copy.splice(index, 1);
    copy.push(item);
    setList(copy);
  };

  const handleReset = () => {
    setList(
      [...articles].sort((a, b) => {
        const ao = a.order_index ?? 0;
        const bo = b.order_index ?? 0;
        if (ao !== bo) return ao - bo;
        return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
      })
    );
    setErrorMsg(null);
  };

  const handleSave = async () => {
    if (!workspaceId || list.length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    setErrorMsg(null);

    const updates = list.map((item, index) => ({
      id: item.id,
      order_index: index + 1,
    }));

    try {
      await reorderArticlesAction(workspaceId, updates);
      const updatedArticles = list.map((item, index) => ({
        ...item,
        order_index: index + 1,
      }));
      onSaved(updatedArticles);
    } catch (err: any) {
      setErrorMsg(errorMessage(err, 'Failed to save article order'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay animate-in fade-in">
      <div className="popover border border-line rounded-2xl shadow-2xl max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden animate-in zoom-in-95">
        {/* Header */}
        <div className="px-5 py-4 border-b border-line flex items-center justify-between bg-surface-2/60 shrink-0">
          <div className="flex items-center gap-3">
            <SectionIconPreview
              icon={section.icon}
              className="w-10 h-10 rounded-xl bg-surface border border-line shadow-xs text-xl"
              imgClassName="w-6 h-6 object-contain"
            />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-ink">Reorder Articles</h3>
                <span className="font-mono text-2xs font-bold px-1.5 py-0.5 rounded-md bg-accent/10 text-accent border border-accent/20">
                  {section.name}
                </span>
              </div>
              <p className="text-xs text-ink-3">
                Change the sequence in which articles are displayed on help.business.com
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface-3 flex items-center justify-center text-ink-3 hover:text-ink transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 overflow-y-auto flex-1 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-xl bg-danger/10 border border-danger/20 text-danger text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          <div className="p-3.5 rounded-xl bg-accent-soft/30 border border-accent/20 flex items-start gap-2.5 text-xs text-ink-2">
            <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <span>
              Articles at the top appear first on your public Help Center and inside the widget. Use the <strong className="text-ink">Up</strong> and <strong className="text-ink">Down</strong> buttons to reorder.
            </span>
          </div>

          {list.length === 0 ? (
            <div className="py-12 text-center text-ink-3 text-ui">
              No articles found in this section.
            </div>
          ) : (
            <div className="space-y-2">
              {list.map((item, index) => {
                const isFirst = index === 0;
                const isLast = index === list.length - 1;
                const displayNum = String(index + 1).padStart(2, '0');

                return (
                  <div
                    key={item.id}
                    className="p-3 rounded-xl border border-line bg-surface hover:bg-surface-2/60 transition-all flex items-center justify-between gap-3 shadow-2xs group"
                  >
                    <div className="flex items-center gap-3 min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 shrink-0">
                        <GripVertical className="w-4 h-4 text-ink-3/40 group-hover:text-ink-3 transition-colors" />
                        <span className="font-mono text-xs font-bold px-2 py-0.5 rounded-md bg-surface-2 border border-line text-accent">
                          #{displayNum}
                        </span>
                      </div>

                      <div className="min-w-0 flex-1">
                        <h4 className="text-ui font-semibold text-ink truncate">
                          {item.title}
                        </h4>
                        <div className="flex items-center gap-2 mt-0.5 text-2xs text-ink-3">
                          <span
                            className={cn(
                              'px-1.5 py-0.2 rounded font-medium',
                              item.status === 'published'
                                ? 'bg-success/10 text-success'
                                : 'bg-warn/10 text-warn'
                            )}
                          >
                            {item.status === 'published' ? 'Published' : 'Draft'}
                          </span>
                          {item.summary && (
                            <span className="truncate max-w-xs opacity-75">
                              • {item.summary}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Order Controls */}
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        type="button"
                        disabled={isFirst}
                        onClick={() => handleMove(index, 'up')}
                        className="h-7.5 px-2 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shadow-2xs"
                        title="Move Up"
                      >
                        <ArrowUp className="w-3.5 h-3.5 text-accent" />
                        <span className="hidden sm:inline">Up</span>
                      </button>

                      <button
                        type="button"
                        disabled={isLast}
                        onClick={() => handleMove(index, 'down')}
                        className="h-7.5 px-2 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-medium flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed shadow-2xs"
                        title="Move Down"
                      >
                        <ArrowDown className="w-3.5 h-3.5 text-accent" />
                        <span className="hidden sm:inline">Down</span>
                      </button>

                      <button
                        type="button"
                        disabled={isFirst}
                        onClick={() => handleMoveToTop(index)}
                        className="h-7.5 w-7.5 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink-3 hover:text-ink flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Move to Top"
                      >
                        <span className="text-2xs font-bold font-mono">⇈</span>
                      </button>

                      <button
                        type="button"
                        disabled={isLast}
                        onClick={() => handleMoveToBottom(index)}
                        className="h-7.5 w-7.5 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink-3 hover:text-ink flex items-center justify-center transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                        title="Move to Bottom"
                      >
                        <span className="text-2xs font-bold font-mono">⇊</span>
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-5 py-3.5 border-t border-line flex items-center justify-between bg-surface-2/40 shrink-0">
          <button
            type="button"
            onClick={handleReset}
            disabled={saving || !hasChanges}
            className="text-xs text-ink-3 hover:text-ink flex items-center gap-1 cursor-pointer font-medium disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            <span>Reset Order</span>
          </button>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="h-8.5 px-3.5 rounded-lg border border-line bg-surface text-ink text-xs font-medium hover:bg-surface-2 transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={saving}
              onClick={handleSave}
              className="h-8.5 px-4 rounded-lg bg-accent text-accent-ink text-xs font-semibold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Check className="w-4 h-4" />
              <span>{saving ? 'Saving...' : 'Save & Apply Order'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// QUICK RENAME / EDIT SECTION MODAL
// ============================================================================
interface QuickRenameSectionModalProps {
  workspace?: Workspace | null;
  workspaceId: string;
  section: HelpSection;
  onClose: () => void;
  onUpdated: (updatedSection: HelpSection) => void;
  onDeleteRequest: (section: HelpSection) => void;
}

function QuickRenameSectionModal({
  workspace,
  workspaceId,
  section,
  onClose,
  onUpdated,
  onDeleteRequest,
}: QuickRenameSectionModalProps) {
  const iconGroups = useMemo(() => getSectionIconGroups(workspace), [workspace]);
  const [name, setName] = useState(section.name);
  const [description, setDescription] = useState(section.description || '');
  const [icon, setIcon] = useState(section.icon || '📚');
  const [orderIndex, setOrderIndex] = useState(section.order_index ?? 1);
  const [iconTab, setIconTab] = useState<'presets' | 'custom'>(
    section.icon && (section.icon.startsWith('http') || section.icon.startsWith('/'))
      ? 'custom'
      : 'presets'
  );
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [nameError, setNameError] = useState<string | null>(null);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingIcon(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.url) setIcon(data.url);
    } catch {
      setErrorMsg('Failed to upload icon image');
    } finally {
      setUploadingIcon(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError('Section name cannot be empty. Please enter a valid name.');
      return;
    }
    setSaving(true);
    setErrorMsg(null);
    setNameError(null);
    try {
      const res = await updateHelpSectionAction(workspaceId, section.id, {
        name: name.trim(),
        description: description.trim(),
        icon: icon.trim() || '📚',
      });
      if (res.section) {
        onUpdated(res.section);
      }
    } catch (err: any) {
      setErrorMsg(errorMessage(err, 'Failed to rename section'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay animate-in fade-in">
      <div className="popover border border-line rounded-2xl shadow-2xl max-w-lg w-full flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between bg-surface-2/50">
          <div>
            <h2 className="text-base font-bold text-ink">Rename Section</h2>
            <p className="text-xs text-ink-3">
              Change section name, description, or custom icon.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface-3 flex items-center justify-center text-ink-3 hover:text-ink transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-4 overflow-y-auto max-h-[75vh]">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs font-medium">
              {errorMsg}
            </div>
          )}

          {/* Live Preview */}
          <div className="p-3 rounded-xl border border-line bg-surface-2/60 flex items-center gap-3">
            <SectionIconPreview
              icon={icon}
              className="w-11 h-11 rounded-xl text-xl"
              imgClassName="w-7 h-7"
            />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold text-ink truncate">
                  {name.trim() || 'Section Name'}
                </span>
              </div>
              <p className="text-xs text-ink-3 truncate mt-0.5">
                {description.trim() || 'Section description will appear here'}
              </p>
            </div>
            <span className="text-2xs font-medium px-2 py-0.5 rounded bg-surface border border-line text-ink-3 shrink-0">
              Live Preview
            </span>
          </div>

          {/* Name */}
          <div>
            <label className="text-xs font-semibold text-ink-2 block mb-1">
              Section Name <span className="text-danger">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (nameError) setNameError(null);
              }}
              placeholder="e.g. Account Management, Rules, Payouts"
              className={cn(
                'w-full h-9 px-3 rounded-lg border bg-surface text-ui text-ink focus:outline-none transition-colors',
                nameError
                  ? 'border-danger focus:border-danger bg-danger/5'
                  : 'border-line focus:border-accent'
              )}
              autoFocus
            />
            {nameError && (
              <p className="text-xs text-danger font-medium flex items-center gap-1 mt-1">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                <span>{nameError}</span>
              </p>
            )}
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-semibold text-ink-2 block mb-1">
              Short Description (Optional)
            </label>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Understand guidelines, payout split, and account types"
              className="w-full h-9 px-3 rounded-lg border border-line bg-surface text-ui text-ink focus:outline-none focus:border-accent"
            />
          </div>

          {/* Icon Tabs */}
          <div className="space-y-2 pt-1">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold text-ink-2">Section Icon / Logo</label>
              <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface-2 border border-line text-2xs">
                <button
                  type="button"
                  onClick={() => setIconTab('presets')}
                  className={`px-2 py-0.5 rounded font-medium transition-all ${
                    iconTab === 'presets'
                      ? 'bg-accent text-white shadow-xs'
                      : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  Icon Presets
                </button>
                <button
                  type="button"
                  onClick={() => setIconTab('custom')}
                  className={`px-2 py-0.5 rounded font-medium transition-all ${
                    iconTab === 'custom'
                      ? 'bg-accent text-white shadow-xs'
                      : 'text-ink-3 hover:text-ink'
                  }`}
                >
                  Custom Logo / URL
                </button>
              </div>
            </div>

            {iconTab === 'presets' ? (
              <div className="p-3 rounded-xl border border-line bg-surface-2/40 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={icon}
                    onChange={(e) => setIcon(e.target.value)}
                    className="w-14 h-8 px-2 text-center text-lg rounded-lg border border-line bg-surface focus:outline-none focus:border-accent"
                  />
                  <button
                    type="button"
                    onClick={() => setShowEmojiPicker((prev) => !prev)}
                    className="h-8 px-2.5 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs shrink-0 font-medium inline-flex items-center gap-1 cursor-pointer"
                  >
                    <span>😊</span>
                    <span>More Emojis</span>
                  </button>
                  {showEmojiPicker && (
                    <div className="absolute z-50 mt-10">
                      <EmojiPickerPopover
                        onSelect={(em) => {
                          setIcon(em);
                          setShowEmojiPicker(false);
                        }}
                        onClose={() => setShowEmojiPicker(false)}
                      />
                    </div>
                  )}
                </div>

                <div className="space-y-1.5 pt-1">
                  {iconGroups.map((grp) => (
                    <div key={grp.name} className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-2xs text-ink-3 w-28 shrink-0 font-medium">
                        {grp.name}:
                      </span>
                      {grp.icons.map((em) => (
                        <button
                          key={em}
                          type="button"
                          onClick={() => setIcon(em)}
                          className={`w-6 h-6 rounded flex items-center justify-center text-ui transition-all cursor-pointer ${
                            icon === em ? 'bg-accent text-white scale-110' : 'hover:bg-surface'
                          }`}
                        >
                          {em}
                        </button>
                      ))}
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div className="p-3 rounded-xl border border-line bg-surface-2/40 space-y-2.5">
                <div className="flex items-center gap-2">
                  <label className="h-8 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer shrink-0">
                    <Upload className="w-3.5 h-3.5" />
                    <span>{uploadingIcon ? 'Uploading…' : 'Upload Logo'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      disabled={uploadingIcon}
                      onChange={handleUpload}
                      className="hidden"
                    />
                  </label>
                  <span className="text-2xs text-ink-3">or paste image link:</span>
                </div>

                <input
                  type="url"
                  value={icon.startsWith('http') || icon.startsWith('/') ? icon : ''}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder="https://example.com/icon.svg"
                  className="w-full h-8 px-3 rounded-lg border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
                />
              </div>
            )}
          </div>

          {/* Footer Actions */}
          <div className="pt-3 border-t border-line flex items-center justify-between">
            <button
              type="button"
              onClick={() => onDeleteRequest(section)}
              className="text-xs text-danger hover:text-danger hover:underline flex items-center gap-1 cursor-pointer font-medium"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>Delete this section</span>
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="h-8 px-3 rounded-lg border border-line bg-surface text-ink text-xs font-medium hover:bg-surface-2 transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || uploadingIcon}
                className="h-8 px-4 rounded-lg bg-accent text-accent-ink text-xs font-semibold transition-all shadow-xs disabled:opacity-50 cursor-pointer"
              >
                {saving ? 'Saving...' : 'Save Changes'}
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================================
// DELETE SECTION CONFIRM MODAL
// ============================================================================
interface DeleteSectionConfirmModalProps {
  section: HelpSection;
  sections: HelpSection[];
  articleCount: number;
  isDeleting: boolean;
  onClose: () => void;
  onConfirm: (moveToSectionId: string | null) => Promise<void>;
}

function DeleteSectionConfirmModal({
  section,
  sections,
  articleCount,
  isDeleting,
  onClose,
  onConfirm,
}: DeleteSectionConfirmModalProps) {
  const availableSections = useMemo(
    () => sections.filter((s) => s.id !== section.id),
    [sections, section.id]
  );
  const [destinationSectionId, setDestinationSectionId] = useState<string>(
    availableSections[0]?.id || ''
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay animate-in fade-in">
      <div className="popover border border-line rounded-2xl shadow-2xl max-w-md w-full overflow-hidden animate-in zoom-in-95">
        <div className="p-6 space-y-4">
          <div className="flex items-start gap-3.5">
            <div className="w-10 h-10 rounded-xl bg-danger/10 border border-danger/20 text-danger flex items-center justify-center shrink-0">
              <Trash2 className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-ink">Delete Section?</h3>
              <p className="text-xs text-ink-3 mt-1">
                Are you sure you want to delete <strong className="text-ink">"{section.name}"</strong>?
              </p>
            </div>
          </div>

          <div className="p-3.5 rounded-xl border border-line bg-surface-2/60 space-y-3">
            <div className="flex items-center justify-between text-xs">
              <span className="text-ink-3">Articles in this section:</span>
              <span className="font-bold text-ink px-2 py-0.5 rounded bg-surface border border-line">
                {articleCount} {articleCount === 1 ? 'article' : 'articles'}
              </span>
            </div>

            {articleCount > 0 ? (
              availableSections.length > 0 ? (
                <div className="space-y-2 pt-2 border-t border-line/60">
                  <label className="text-xs font-semibold text-ink flex items-center gap-1">
                    <span>Move articles to:</span>
                    <span className="text-danger">*</span>
                  </label>
                  <select
                    value={destinationSectionId}
                    onChange={(e) => setDestinationSectionId(e.target.value)}
                    className="w-full h-8.5 px-2.5 rounded-lg border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent cursor-pointer"
                  >
                    {availableSections.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.icon || '📚'} {s.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-xs text-ink-3 leading-relaxed">
                    All {articleCount} articles will be moved into this section before deletion. Articles will never be left pointing to a deleted section.
                  </p>
                </div>
              ) : (
                <p className="text-xs text-warn leading-relaxed pt-1 border-t border-line/60">
                  This is the only section in your workspace. Deleting it will leave these {articleCount} articles in <strong>Uncategorised</strong>.
                </p>
              )
            ) : (
              <p className="text-xs text-ink-3 leading-relaxed">
                This section has no articles and will be safely removed.
              </p>
            )}
          </div>

          <div className="flex items-center justify-end gap-2.5 pt-2">
            <button
              type="button"
              disabled={isDeleting}
              onClick={onClose}
              className="h-8 px-3.5 rounded-lg border border-line bg-surface text-ink text-xs font-medium hover:bg-surface-2 transition-colors cursor-pointer disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={
                isDeleting ||
                (articleCount > 0 && availableSections.length > 0 && !destinationSectionId)
              }
              onClick={() =>
                onConfirm(
                  articleCount > 0 && availableSections.length > 0
                    ? destinationSectionId
                    : null
                )
              }
              className="h-8 px-4 rounded-lg bg-danger hover:bg-danger text-white text-xs font-semibold transition-all shadow-xs flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>
                {isDeleting
                  ? 'Deleting...'
                  : articleCount > 0 && availableSections.length > 0
                  ? 'Move & Delete Section'
                  : 'Delete Section'}
              </span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SECTIONS MANAGER MODAL COMPONENT
// ============================================================================
interface SectionsManagerModalProps {
  workspace?: Workspace | null;
  workspaceId: string;
  sections: HelpSection[];
  articleCounts: Record<string, number>;
  initialEditingSection?: HelpSection | null;
  uncategorisedCount?: number;
  onRunMigration?: () => Promise<void>;
  onClose: () => void;
  onSectionsChanged: () => void;
  onDeleteRequest: (section: HelpSection) => void;
}

function SectionsManagerModal({
  workspace,
  workspaceId,
  sections,
  articleCounts,
  initialEditingSection,
  uncategorisedCount = 0,
  onRunMigration,
  onClose,
  onSectionsChanged,
  onDeleteRequest,
}: SectionsManagerModalProps) {
  const iconGroups = useMemo(() => getSectionIconGroups(workspace), [workspace]);
  const [sectionList, setSectionList] = useState<HelpSection[]>(() => {
    return [...sections].sort((a, b) => {
      const ao = a.order_index ?? 0;
      const bo = b.order_index ?? 0;
      if (ao !== bo) return ao - bo;
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });
  });

  const [editingSec, setEditingSec] = useState<HelpSection | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [isReordering, setIsReordering] = useState(false);

  useEffect(() => {
    const sorted = [...sections].sort((a, b) => {
      const ao = a.order_index ?? 0;
      const bo = b.order_index ?? 0;
      if (ao !== bo) return ao - bo;
      return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
    });
    setSectionList(sorted);
  }, [sections]);

  useEffect(() => {
    if (initialEditingSection) {
      handleStartEdit(initialEditingSection);
    }
  }, [initialEditingSection]);

  const [name, setName] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('📚');
  const [iconTab, setIconTab] = useState<'presets' | 'custom'>('presets');
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [showSectionEmojiPicker, setShowSectionEmojiPicker] = useState(false);

  const handleStartEdit = (sec: HelpSection) => {
    setEditingSec(sec);
    setName(sec.name);
    setNameError(null);
    setDescription(sec.description || '');
    setIcon(sec.icon || '📚');
    if (sec.icon && (sec.icon.startsWith('http') || sec.icon.startsWith('/'))) {
      setIconTab('custom');
    } else {
      setIconTab('presets');
    }
  };

  const handleResetForm = () => {
    setEditingSec(null);
    setName('');
    setNameError(null);
    setDescription('');
    setIcon('📚');
    setIconTab('presets');
    setErrorMsg(null);
  };

  const handleUploadIcon = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadingIcon(true);
    try {
      const uploadData = new FormData();
      uploadData.append('file', file);
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: uploadData,
      });
      const data = await res.json();
      if (data.url) {
        setIcon(data.url);
      }
    } catch {
      setErrorMsg('Failed to upload icon image');
    } finally {
      setUploadingIcon(false);
    }
  };

  const handleSaveSection = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setNameError('Section name cannot be empty. Please enter a section name.');
      return;
    }

    setSubmitting(true);
    setErrorMsg(null);
    setNameError(null);
    try {
      if (editingSec?.id) {
        const res = await updateHelpSectionAction(workspaceId, editingSec.id, {
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim() || '📚',
        });
        if (res.section) {
          setSectionList((prev) =>
            prev.map((s) => (s.id === editingSec.id ? res.section : s))
          );
        }
      } else {
        const res = await createHelpSectionAction(workspaceId, {
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim() || '📚',
        });
        if (res.section) {
          setSectionList((prev) => [...prev, res.section]);
        }
      }
      handleResetForm();
      onSectionsChanged();
    } catch (err: any) {
      setErrorMsg(errorMessage(err, 'Failed to save section'));
    } finally {
      setSubmitting(false);
    }
  };

  const handleReorder = async (newList: HelpSection[]) => {
    setSectionList(newList);
    setIsReordering(true);
    try {
      await reorderHelpSectionsAction(
        workspaceId,
        newList.map((s) => s.id)
      );
      onSectionsChanged();
    } catch (err: any) {
      setErrorMsg(errorMessage(err, 'Failed to save section order'));
    } finally {
      setIsReordering(false);
    }
  };

  const handleMoveItem = (fromIndex: number, direction: 'up' | 'down') => {
    const toIndex = direction === 'up' ? fromIndex - 1 : fromIndex + 1;
    if (toIndex < 0 || toIndex >= sectionList.length) return;
    const copy = [...sectionList];
    const [moved] = copy.splice(fromIndex, 1);
    copy.splice(toIndex, 0, moved);
    handleReorder(copy);
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', index.toString());
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragOverIndex !== index) {
      setDragOverIndex(index);
    }
  };

  const handleDrop = (e: React.DragEvent, dropIndex: number) => {
    e.preventDefault();
    if (draggedIndex === null || draggedIndex === dropIndex) {
      setDraggedIndex(null);
      setDragOverIndex(null);
      return;
    }
    const copy = [...sectionList];
    const [moved] = copy.splice(draggedIndex, 1);
    copy.splice(dropIndex, 0, moved);
    setDraggedIndex(null);
    setDragOverIndex(null);
    handleReorder(copy);
  };

  const handleDragEnd = () => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  };

  const activePositionNum = editingSec
    ? sectionList.findIndex((s) => s.id === editingSec.id) + 1 || 1
    : sectionList.length + 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay animate-in fade-in">
      <div className="popover border border-line rounded-2xl shadow-2xl max-w-xl w-full max-h-[88vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between bg-surface-2/50">
          <div>
            <h2 className="text-base font-bold text-ink">Manage Help Sections</h2>
            <p className="text-xs text-ink-3">
              Drag to reorder, customize icons, edit descriptions, or organize articles.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface-3 flex items-center justify-center text-ink-3 hover:text-ink transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 overflow-y-auto flex-1 space-y-6">
          {/* Uncategorised Notice Banner */}
          {uncategorisedCount > 0 && (
            <div className="p-3.5 rounded-xl border border-warn/30 bg-warn/10 flex items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2.5 text-warn min-w-0">
                <AlertCircle className="w-4 h-4 shrink-0 text-warn" />
                <span className="truncate">
                  <strong>{uncategorisedCount} uncategorised {uncategorisedCount === 1 ? 'article' : 'articles'}</strong> need section assignment.
                </span>
              </div>
              {onRunMigration && (
                <button
                  type="button"
                  onClick={() => {
                    onRunMigration();
                    onClose();
                  }}
                  className="px-2.5 py-1 rounded-md bg-warn hover:bg-warn text-white text-xs font-semibold shrink-0 cursor-pointer transition-colors shadow-2xs"
                >
                  Migrate All
                </button>
              )}
            </div>
          )}

          {/* Create / Edit Form */}
          <form onSubmit={handleSaveSection} className="p-4 rounded-xl border border-line bg-surface-2/60 space-y-3.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-ink">
                {editingSec ? `Edit Section: ${editingSec.name}` : 'Add New Section'}
              </span>
              {editingSec && (
                <button
                  type="button"
                  onClick={handleResetForm}
                  className="text-2xs text-accent hover:underline cursor-pointer"
                >
                  Cancel Edit
                </button>
              )}
            </div>

            {errorMsg && (
              <p className="text-xs text-danger font-medium">{errorMsg}</p>
            )}

            {/* Live Section Preview Card */}
            <div className="p-3 rounded-xl border border-line bg-surface flex items-center gap-3">
              <SectionIconPreview
                icon={icon}
                className="w-11 h-11 rounded-xl text-xl"
                imgClassName="w-7 h-7"
              />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-2xs font-bold px-1.5 py-0.5 rounded bg-surface-2 border border-line text-ink-3 shrink-0">
                    #{String(activePositionNum).padStart(2, '0')}
                  </span>
                  <div className="text-sm font-bold text-ink truncate">
                    {name.trim() || 'Section Title Preview'}
                  </div>
                </div>
                <div className="text-xs text-ink-3 truncate mt-0.5">
                  {description.trim() || 'Short description preview will appear here'}
                </div>
              </div>
              <span className="text-2xs font-medium px-2 py-0.5 rounded bg-surface-2 border border-line text-ink-3 shrink-0">
                Live Preview
              </span>
            </div>

            {/* Section Name & Description */}
            <div className="space-y-2.5">
              <div>
                <label className="text-2xs font-semibold text-ink-2 block mb-1">
                  Section Name <span className="text-danger">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value);
                    if (nameError) setNameError(null);
                  }}
                  placeholder="e.g. Account Types, Withdrawals, Risk Limits"
                  className={cn(
                    'w-full h-8 px-3 rounded-lg border bg-surface text-xs text-ink focus:outline-none transition-colors',
                    nameError
                      ? 'border-danger focus:border-danger bg-danger/5'
                      : 'border-line focus:border-accent'
                  )}
                />
                {nameError && (
                  <p className="text-xs text-danger font-medium flex items-center gap-1 mt-1">
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                    <span>{nameError}</span>
                  </p>
                )}
              </div>

              <div>
                <label className="text-2xs font-semibold text-ink-2 block mb-1">
                  Short Description (Optional)
                </label>
                <input
                  type="text"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="e.g. Learn about live accounts, funded steps, and payout rules"
                  className="w-full h-8 px-3 rounded-lg border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
                />
              </div>
            </div>

            {/* Section Icon / Logo Picker Tabs */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <label className="text-2xs font-semibold text-ink-2">Section Icon / Logo</label>
                <div className="flex items-center gap-1 p-0.5 rounded-lg bg-surface border border-line text-2xs">
                  <button
                    type="button"
                    onClick={() => setIconTab('presets')}
                    className={`px-2 py-0.5 rounded font-medium transition-all ${
                      iconTab === 'presets'
                        ? 'bg-accent text-white shadow-xs'
                        : 'text-ink-3 hover:text-ink'
                    }`}
                  >
                    Icon Presets
                  </button>
                  <button
                    type="button"
                    onClick={() => setIconTab('custom')}
                    className={`px-2 py-0.5 rounded font-medium transition-all ${
                      iconTab === 'custom'
                        ? 'bg-accent text-white shadow-xs'
                        : 'text-ink-3 hover:text-ink'
                    }`}
                  >
                    Custom Logo / URL
                  </button>
                </div>
              </div>

              {iconTab === 'presets' ? (
                <div className="p-2.5 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={icon}
                      onChange={(e) => setIcon(e.target.value)}
                      className="w-16 h-8 px-2 text-center text-lg rounded-lg border border-line bg-surface-2 focus:outline-none focus:border-accent"
                    />
                    <button
                      type="button"
                      onClick={() => setShowSectionEmojiPicker((prev) => !prev)}
                      className="h-8 px-2.5 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs shrink-0 font-medium inline-flex items-center gap-1 cursor-pointer"
                    >
                      <span>😊</span>
                      <span>More Emojis</span>
                    </button>
                    {showSectionEmojiPicker && (
                      <div className="absolute left-10 z-50">
                        <EmojiPickerPopover
                          onSelect={(em) => {
                            setIcon(em);
                            setShowSectionEmojiPicker(false);
                          }}
                          onClose={() => setShowSectionEmojiPicker(false)}
                        />
                      </div>
                    )}
                  </div>

                  {/* Categorized Icon Presets */}
                  <div className="space-y-1.5 pt-1">
                    {iconGroups.map((grp) => (
                      <div key={grp.name} className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-2xs text-ink-3 w-28 shrink-0 font-medium">
                          {grp.name}:
                        </span>
                        {grp.icons.map((em) => (
                          <button
                            key={em}
                            type="button"
                            onClick={() => setIcon(em)}
                            className={`w-6 h-6 rounded flex items-center justify-center text-ui transition-all cursor-pointer ${
                              icon === em ? 'bg-accent text-white scale-110' : 'hover:bg-surface-2'
                            }`}
                          >
                            {em}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                /* Custom Logo / Image URL or Upload */
                <div className="p-3 rounded-xl border border-line bg-surface space-y-2.5">
                  <div className="flex items-center gap-2">
                    <label className="h-8 px-3 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer shrink-0">
                      <Upload className="w-3.5 h-3.5" />
                      <span>{uploadingIcon ? 'Uploading…' : 'Upload Section Logo'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={uploadingIcon}
                        onChange={handleUploadIcon}
                        className="hidden"
                      />
                    </label>
                    <span className="text-2xs text-ink-3">or paste image link:</span>
                  </div>

                  <input
                    type="url"
                    value={icon.startsWith('http') || icon.startsWith('/') ? icon : ''}
                    onChange={(e) => setIcon(e.target.value)}
                    placeholder="https://example.com/section-icon.png"
                    className="w-full h-8 px-3 rounded-lg border border-line bg-surface text-xs text-ink focus:outline-none focus:border-accent"
                  />
                  <p className="text-2xs text-ink-3">
                    Supports SVG, PNG, WebP, JPG. Displays directly on the section card in your Help Center.
                  </p>
                </div>
              )}
            </div>

            <button
              type="submit"
              disabled={submitting || uploadingIcon}
              className="w-full h-8 px-4 rounded-lg bg-accent text-accent-ink text-xs font-semibold transition-all shadow-xs disabled:opacity-50 cursor-pointer"
            >
              {submitting ? 'Saving...' : editingSec ? 'Update Section' : '+ Add Section'}
            </button>
          </form>

          {/* Current Sections List with Drag-to-Reorder */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink uppercase tracking-wider">
                Existing Sections ({sectionList.length})
              </span>
              <span className="text-2xs text-ink-3">
                Drag handle or use arrows to reorder
              </span>
            </div>

            {sectionList.length === 0 ? (
              <p className="text-xs text-ink-3 italic">No sections created yet.</p>
            ) : (
              <div className="border border-line rounded-xl divide-y divide-line/80 overflow-hidden bg-surface">
                {sectionList.map((sec, idx) => {
                  const displayNum = String(idx + 1).padStart(2, '0');
                  const isFirst = idx === 0;
                  const isLast = idx === sectionList.length - 1;
                  const isBeingDragged = draggedIndex === idx;
                  const isDropTarget = dragOverIndex === idx && draggedIndex !== idx;

                  return (
                    <div
                      key={sec.id}
                      draggable={!editingSec && !isReordering}
                      onDragStart={(e) => handleDragStart(e, idx)}
                      onDragOver={(e) => handleDragOver(e, idx)}
                      onDrop={(e) => handleDrop(e, idx)}
                      onDragEnd={handleDragEnd}
                      className={cn(
                        'p-3 flex items-center justify-between gap-3 transition-all select-none',
                        isBeingDragged && 'opacity-40 bg-surface-3',
                        isDropTarget && 'bg-accent/10 border-t-2 border-accent',
                        !isBeingDragged && !isDropTarget && 'hover:bg-surface-2/50'
                      )}
                    >
                      <div className="flex items-center gap-2.5 min-w-0 flex-1">
                        {/* Drag Handle & Arrow controls */}
                        <div className="flex items-center gap-0.5 shrink-0">
                          <div
                            className="p-1 rounded hover:bg-surface-3 text-ink-3/40 hover:text-ink cursor-grab active:cursor-grabbing transition-colors"
                            title="Drag to reorder"
                          >
                            <GripVertical className="w-4 h-4" />
                          </div>
                          <div className="flex flex-col">
                            <button
                              type="button"
                              disabled={isFirst || isReordering}
                              onClick={() => handleMoveItem(idx, 'up')}
                              className="w-4 h-3.5 flex items-center justify-center text-ink-3 hover:text-ink disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed"
                              title="Move up"
                            >
                              <ArrowUp className="w-3 h-3" />
                            </button>
                            <button
                              type="button"
                              disabled={isLast || isReordering}
                              onClick={() => handleMoveItem(idx, 'down')}
                              className="w-4 h-3.5 flex items-center justify-center text-ink-3 hover:text-ink disabled:opacity-20 cursor-pointer disabled:cursor-not-allowed"
                              title="Move down"
                            >
                              <ArrowDown className="w-3 h-3" />
                            </button>
                          </div>
                        </div>

                        <span className="font-mono text-2xs font-bold px-1.5 py-0.5 rounded bg-surface-2 border border-line text-ink-3 shrink-0">
                          #{displayNum}
                        </span>
                        <SectionIconPreview
                          icon={sec.icon}
                          className="w-8 h-8 rounded-lg text-base"
                          imgClassName="w-5 h-5"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="text-ui font-semibold text-ink truncate">{sec.name}</span>
                            <span className="text-2xs font-medium px-2 py-0.2 rounded-full bg-surface-2 border border-line text-ink-3 shrink-0">
                              {articleCounts[sec.id] || 0} {articleCounts[sec.id] === 1 ? 'article' : 'articles'}
                            </span>
                          </div>
                          {sec.description && (
                            <div className="text-xs text-ink-3 truncate mt-0.5">{sec.description}</div>
                          )}
                        </div>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          onClick={() => handleStartEdit(sec)}
                          className="h-7 px-2.5 rounded-lg border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer shadow-2xs"
                          title="Edit section name, description, and icon"
                        >
                          <Edit2 className="w-3 h-3 text-accent" />
                          <span>Edit</span>
                        </button>

                        <button
                          type="button"
                          onClick={() => onDeleteRequest(sec)}
                          className="h-7 px-2.5 rounded-lg border border-danger/20 bg-danger/5 hover:bg-danger/15 text-danger text-xs font-medium flex items-center gap-1.5 transition-colors cursor-pointer"
                          title="Delete section"
                        >
                          <Trash2 className="w-3 h-3" />
                          <span>Delete</span>
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-3.5 border-t border-line flex items-center justify-end bg-surface-2/40">
          <button
            onClick={onClose}
            className="h-8 px-4 rounded-lg bg-surface border border-line text-ink text-xs font-medium hover:bg-surface-2 transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

function SimpleMarkdownRenderer({ content }: { content: string }) {
  return <MarkdownArticleContent content={content} />;
}

// ============================================================================
// WIDGET TAB SETTINGS MODAL COMPONENT (Rename & Customize Tab on Website)
// ============================================================================
interface WidgetTabSettingsModalProps {
  workspace: Workspace;
  onClose: () => void;
  onUpdated: (ws: Workspace) => void;
}

function WidgetTabSettingsModal({
  workspace,
  onClose,
  onUpdated,
}: WidgetTabSettingsModalProps) {
  const [tabLabel, setTabLabel] = useState(workspace.help_center_tab_label || 'Help');
  const [showTab, setShowTab] = useState(workspace.show_help_tab !== false);
  const [tabIcon, setTabIcon] = useState(workspace.help_center_tab_icon || '📖');
  const [saving, setSaving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const SUGGESTED_NAMES = [
    'Help',
    'Help Center',
    'Knowledge Base',
    'Guides',
    'FAQs',
    'Support Docs',
    'Madad',
    'Docs',
    'Resources',
  ];

  const TAB_ICONS = ['📖', '📚', '💡', '❓', '🔍', '🎧', '⚡', '🤖', '🤝', '📌'];

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tabLabel.trim()) {
      setErrorMsg('Please enter a tab name');
      return;
    }

    setSaving(true);
    setErrorMsg(null);
    try {
      const res = await updateHelpTabSettingsAction(workspace.id, {
        label: tabLabel.trim(),
        showTab,
        icon: tabIcon,
      });
      if (res.workspace) {
        onUpdated(res.workspace);
        onClose();
      }
    } catch (err: any) {
      setErrorMsg(errorMessage(err, 'Failed to update widget tab settings'));
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-overlay animate-in fade-in">
      <div className="popover border border-line rounded-2xl shadow-2xl max-w-md w-full overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-line flex items-center justify-between bg-surface-2/50">
          <div>
            <h2 className="text-base font-bold text-ink">Customize Website Widget Tab</h2>
            <p className="text-xs text-ink-3">
              Rename the Help tab, select icon, and control visibility on your website.
            </p>
          </div>
          <button
            onClick={onClose}
            className="w-8 h-8 rounded-lg hover:bg-surface-3 flex items-center justify-center text-ink-3 hover:text-ink transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content Form */}
        <form onSubmit={handleSave} className="p-6 space-y-4">
          {errorMsg && (
            <div className="p-3 rounded-lg bg-danger/10 border border-danger/20 text-danger text-xs flex items-center gap-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              <span>{errorMsg}</span>
            </div>
          )}

          {/* Visibility Switch */}
          <div className="flex items-center justify-between p-3.5 rounded-xl border border-line bg-surface-2/40">
            <div>
              <div className="text-ui font-semibold text-ink">Show Tab on Website Widget</div>
              <div className="text-xs text-ink-3">
                Toggle whether visitors can browse articles in the chat launcher.
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={showTab}
                onChange={(e) => setShowTab(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-surface-3 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
            </label>
          </div>

          {/* Tab Label Name Input */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-ink-2">
              Tab Label Name <span className="font-normal text-ink-3">(Displayed to visitors)</span>
            </label>
            <input
              type="text"
              value={tabLabel}
              onChange={(e) => setTabLabel(e.target.value)}
              placeholder="e.g. Help Center, FAQs, Guides, Madad..."
              className="w-full h-10 px-3 rounded-xl border border-line bg-surface text-ui text-ink focus:outline-none focus:border-accent"
            />

            {/* Quick Suggestions */}
            <div className="flex items-center gap-1.5 flex-wrap pt-1">
              <span className="text-2xs text-ink-3">Presets:</span>
              {SUGGESTED_NAMES.map((name) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => setTabLabel(name)}
                  className={`px-2 py-0.5 rounded-md text-2xs font-medium transition-colors border ${
                    tabLabel === name
                      ? 'bg-accent text-accent-ink border-accent'
                      : 'bg-surface-2 border-line text-ink-2 hover:bg-surface-3 hover:text-ink'
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
          </div>

          {/* Tab Icon Selection */}
          <div className="space-y-1.5">
            <label className="text-xs font-semibold text-ink-2">Tab Icon</label>
            <div className="flex items-center gap-1.5 flex-wrap">
              {TAB_ICONS.map((icon) => (
                <button
                  key={icon}
                  type="button"
                  onClick={() => setTabIcon(icon)}
                  className={`w-9 h-9 rounded-xl flex items-center justify-center text-lg transition-transform border ${
                    tabIcon === icon
                      ? 'border-accent bg-accent/10 scale-110 shadow-xs'
                      : 'border-line bg-surface hover:bg-surface-2'
                  }`}
                >
                  {icon}
                </button>
              ))}
            </div>
          </div>

          {/* Live Visitor Preview */}
          <div className="p-3.5 rounded-xl border border-line bg-surface-2/60 space-y-2">
            <span className="text-2xs font-bold text-ink-3 uppercase tracking-wider block">
              Live Visitor Preview (Widget Bottom Bar)
            </span>
            <div className="bg-surface rounded-xl border border-line p-2 flex items-center justify-around shadow-sm max-w-xs mx-auto">
              <div className="flex flex-col items-center gap-0.5 text-ink-3 text-2xs">
                <span className="text-sm">🏠</span>
                <span>Home</span>
              </div>
              <div className="flex flex-col items-center gap-0.5 text-ink-3 text-2xs">
                <span className="text-sm">💬</span>
                <span>Messages</span>
              </div>
              <div className={`flex flex-col items-center gap-0.5 font-bold text-2xs ${showTab ? 'text-accent scale-105' : 'opacity-30 line-through'}`}>
                <span className="text-sm">{tabIcon}</span>
                <span>{tabLabel || 'Help'}</span>
              </div>
            </div>
          </div>

          {/* Footer Buttons */}
          <div className="pt-2 flex items-center justify-end gap-2.5 border-t border-line">
            <button
              type="button"
              onClick={onClose}
              className="h-9 px-4 rounded-xl border border-line bg-surface hover:bg-surface-2 text-ink text-xs font-medium"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="h-9 px-5 rounded-xl bg-accent text-accent-ink hover:opacity-90 text-xs font-semibold transition-all shadow-xs disabled:opacity-50"
            >
              {saving ? 'Saving...' : 'Save & Update Widget'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
