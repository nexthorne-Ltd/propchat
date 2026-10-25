'use client';

import { getWidgetOrigin } from '@/lib/domain';
import React, { useState, useMemo, useEffect, useRef } from 'react';
import { getWorkspaceAiPlanAndUsageAction, type WorkspaceAiPlanAndUsage } from '@/app/actions/knowledge';
import {
  Palette,
  Clock,
  MessageSquareText,
  Sliders,
  Code,
  Check,
  Copy,
  Plus,
  Trash2,
  Edit2,
  ShieldCheck,
  AlertCircle,
  AlertTriangle,
  Sparkles,
  Upload,
  Send,
  MessageSquare,
  X,
  Bot,
  Zap,
  Globe,
  ExternalLink,
  RefreshCw,
  RotateCcw,
  CheckCircle2,
  XCircle,
  BookOpen,
  Link as LinkIcon,
  LayoutGrid,
  Grid3X3,
  Columns4,
  Rows3,
  Mail,
  Monitor,
  Smartphone,
  Laptop,
  Eye,
  Search,
  ChevronDown,
  ImageIcon,
  Lock,
} from 'lucide-react';
import { SMTPSettingsSection } from '@/components/admin/SMTPSettingsSection';
import {
  Workspace,
  Agent,
  CannedResponse,
  BusinessHoursConfig,
  AutoAssignmentConfig,
  AISettingsConfig,
  NavbarTriggerConfig,
  WidgetIconType,
} from '@/types/database';
import { DesignPicker, LauncherIconPicker, LauncherPreview, MessengerPreview } from '@/components/admin/WidgetLookPicker';
import {
  DEFAULT_WIDGET_DESIGN,
  WIDGET_COLOR_MODES,
  isHexColor,
  isWidgetColorMode,
  isWidgetDesign,
  type WidgetColorMode,
  type WidgetDesignId,
} from '@/lib/widget/launcher-icons';
import {
  updateWidgetSettingsAction,
  updateBusinessHoursAction,
  updateAutoAssignmentRulesAction,
  updateAISettingsAction,
  updateHelpCenterBrandingAction,
  updateNavbarTriggerConfigAction,
  createCannedResponseAction,
  updateCannedResponseAction,
  deleteCannedResponseAction,
} from '@/app/actions/admin';
import {
  updateWorkspaceDomainAction,
  checkWorkspaceSlugAvailabilityAction,
  updateWorkspaceSlugAction,
} from '@/app/actions/domain';
import { CustomDomainSetup } from '@/components/settings/CustomDomainSetup';
import { HelpCenterDesigner } from '@/components/settings/HelpCenterDesigner';
import {
  getWorkspaceHelpCenterUrl,
  cleanDomain,
  getDefaultSubdomain,
  getExpectedDnsRecords,
  splitDomain,
  HELP_BASE_DOMAIN,
  CNAME_TARGET,
} from '@/lib/domain';
import { cn } from '@/lib/utils';
import { NavbarPreviewModal } from '@/components/dashboard/NavbarPreviewModal';
import { errorMessage } from '@/lib/errors/user-error';
import { DEFAULT_BRAND_COLOR } from '@/lib/brand';
import { SaveBar } from '@/components/settings/parts';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';

interface AdminSettingsPanelProps {
  workspace: Workspace;
  currentAgent: Agent;
  initialAgents: Agent[];
  initialCannedResponses: CannedResponse[];
  onWorkspaceUpdated?: (ws: Workspace) => void;
  /** Tells the Settings hub whether the visible section has unsaved edits. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Controlled section; when set the internal tab bar is bypassed. */
  tab?: AdminTab;
  /** Hides this panel's own header and tab bar (used by the Settings hub). */
  embedded?: boolean;
}

export type AdminTab =
  | 'widget'
  | 'helpcenter'
  | 'domain'
  | 'hours'
  | 'team'
  | 'canned'
  | 'assignment'
  | 'ai'
  | 'email'
  | 'snippet';

const DEFAULT_SCHEDULE: BusinessHoursConfig = {
  enabled: false,
  timezone: 'UTC',
  schedule: {
    monday: { enabled: true, start: '09:00', end: '17:00' },
    tuesday: { enabled: true, start: '09:00', end: '17:00' },
    wednesday: { enabled: true, start: '09:00', end: '17:00' },
    thursday: { enabled: true, start: '09:00', end: '17:00' },
    friday: { enabled: true, start: '09:00', end: '17:00' },
    saturday: { enabled: false, start: '09:00', end: '17:00' },
    sunday: { enabled: false, start: '09:00', end: '17:00' },
  },
};

const ALL_TIMEZONES: string[] = (() => {
  try {
    if (typeof Intl !== 'undefined' && 'supportedValuesOf' in Intl) {
      return (Intl as any).supportedValuesOf('timeZone');
    }
  } catch {
    // fallback below
  }
  return [
    'UTC',
    'Africa/Cairo',
    'Africa/Casablanca',
    'Africa/Johannesburg',
    'Africa/Lagos',
    'Africa/Nairobi',
    'America/Anchorage',
    'America/Argentina/Buenos_Aires',
    'America/Bogota',
    'America/Chicago',
    'America/Denver',
    'America/Halifax',
    'America/Los_Angeles',
    'America/Mexico_City',
    'America/New_York',
    'America/Phoenix',
    'America/Santiago',
    'America/Sao_Paulo',
    'America/Toronto',
    'America/Vancouver',
    'Asia/Bangkok',
    'Asia/Colombo',
    'Asia/Dhaka',
    'Asia/Dubai',
    'Asia/Hong_Kong',
    'Asia/Jakarta',
    'Asia/Jerusalem',
    'Asia/Karachi',
    'Asia/Kolkata',
    'Asia/Kuala_Lumpur',
    'Asia/Manila',
    'Asia/Riyadh',
    'Asia/Seoul',
    'Asia/Shanghai',
    'Asia/Singapore',
    'Asia/Taipei',
    'Asia/Tokyo',
    'Atlantic/Reykjavik',
    'Australia/Melbourne',
    'Australia/Perth',
    'Australia/Sydney',
    'Europe/Amsterdam',
    'Europe/Athens',
    'Europe/Berlin',
    'Europe/Brussels',
    'Europe/Dublin',
    'Europe/Helsinki',
    'Europe/Istanbul',
    'Europe/Lisbon',
    'Europe/London',
    'Europe/Madrid',
    'Europe/Paris',
    'Europe/Rome',
    'Europe/Stockholm',
    'Europe/Vienna',
    'Europe/Warsaw',
    'Europe/Zurich',
    'Pacific/Auckland',
    'Pacific/Honolulu',
  ];
})();

const COLOR_PRESETS = [
  DEFAULT_BRAND_COLOR, // Zen-try Blue
  '#0d9488', // Teal
  '#10b981', // Emerald
  '#8b5cf6', // Violet
  '#ec4899', // Pink
  '#f97316', // Orange
  '#0f172a', // Midnight Slate
];

export function AdminSettingsPanel({
  workspace: initialWorkspace,
  currentAgent,
  initialCannedResponses,
  onWorkspaceUpdated,
  onDirtyChange,
  tab,
  embedded = false,
}: AdminSettingsPanelProps) {
  // When embedded in the Settings hub the parent owns the tab bar and header,
  // so the panel renders only the requested section.
  const [internalTab, setActiveTab] = useState<AdminTab>('widget');
  const activeTab: AdminTab = tab ?? internalTab;

  // Workspace state
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [cannedResponses, setCannedResponses] = useState<CannedResponse[]>(() =>
    (initialCannedResponses || []).filter(
      (c) => c.shortcut !== 'sla_guarantee' && c.shortcut !== '/sla_guarantee'
    )
  );

  // Status & Feedback
  const [statusMessage, setStatusMessage] = useState<{ text: string; type: 'success' | 'error' } | null>(null);
  const [saving, setSaving] = useState(false);
  const [copiedSnippet, setCopiedSnippet] = useState(false);

  const showStatus = (text: string, type: 'success' | 'error' = 'success') => {
    setStatusMessage({ text, type });
    setTimeout(() => setStatusMessage(null), 3500);
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 1: WIDGET CUSTOMIZATION STATE
  // ──────────────────────────────────────────────────────────────────────────
  const [brandColor, setBrandColor] = useState(workspace.brand_color || DEFAULT_BRAND_COLOR);
  const [logoUrl, setLogoUrl] = useState(workspace.logo_url || '');
  const [showLauncherLogo, setShowLauncherLogo] = useState(
    workspace.show_launcher_logo !== false
  );

  const initialWidgetIcon: WidgetIconType = useMemo(() => {
    const fromNav = (workspace.navbar_trigger_config as any)?.widget_icon;
    if (fromNav) return fromNav;
    if (workspace.show_launcher_logo && workspace.logo_url) return 'custom_logo';
    return 'smile_bubble';
  }, [workspace]);
  const [widgetIcon, setWidgetIcon] = useState<WidgetIconType>(initialWidgetIcon);
  const initialWidgetDesign: WidgetDesignId = useMemo(() => {
    const d = workspace.navbar_trigger_config?.widget_design;
    return isWidgetDesign(d) ? d : DEFAULT_WIDGET_DESIGN;
  }, [workspace]);
  const [widgetDesign, setWidgetDesign] = useState<WidgetDesignId>(initialWidgetDesign);
  const initialSecondaryColor = isHexColor(workspace.navbar_trigger_config?.widget_secondary_color)
    ? (workspace.navbar_trigger_config?.widget_secondary_color as string)
    : '';
  const [secondaryColor, setSecondaryColor] = useState<string>(initialSecondaryColor);
  const initialColorMode: WidgetColorMode = isWidgetColorMode(workspace.navbar_trigger_config?.widget_color_mode)
    ? (workspace.navbar_trigger_config?.widget_color_mode as WidgetColorMode)
    : 'auto';
  const [colorMode, setColorMode] = useState<WidgetColorMode>(initialColorMode);
  const logoFileInputRef = useRef<HTMLInputElement>(null);

  const [widgetPosition, setWidgetPosition] = useState<'right' | 'left'>(
    workspace.widget_position || 'right'
  );
  const [greetingTitle, setGreetingTitle] = useState(workspace.greeting_title || 'Hi there 👋');
  const [greetingMessage, setGreetingMessage] = useState(
    workspace.greeting_message || "We're here to help! Send us a message and we'll reply shortly."
  );
  const [helpTabLabel, setHelpTabLabel] = useState(workspace.help_center_tab_label || 'Help');
  const [showHelpTab, setShowHelpTab] = useState(workspace.show_help_tab !== false);
  const [launcherOffsetBottom, setLauncherOffsetBottom] = useState<number>(
    workspace.launcher_offset_bottom ?? 20
  );
  const [launcherOffsetSide, setLauncherOffsetSide] = useState<number>(
    workspace.launcher_offset_side ?? 20
  );
  const [widgetZIndex, setWidgetZIndex] = useState<number>(
    workspace.widget_z_index ?? 2147483000
  );
  const [enableProactiveWelcome, setEnableProactiveWelcome] = useState<boolean>(
    workspace.enable_proactive_welcome !== false
  );
  const [proactiveDelaySeconds, setProactiveDelaySeconds] = useState<number>(
    Math.max(8, workspace.proactive_delay_seconds ?? 8)
  );
  const [previewOpen, setPreviewOpen] = useState(true);
  const [previewDevice, setPreviewDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [widgetVisibilityDevice, setWidgetVisibilityDevice] = useState<'all' | 'desktop' | 'mobile'>('all');
  const [showOnlineStatusBadge, setShowOnlineStatusBadge] = useState<boolean>(true);

  const isWidgetDirty = useMemo(() => {
    return (
      brandColor !== (workspace.brand_color || DEFAULT_BRAND_COLOR) ||
      logoUrl !== (workspace.logo_url || '') ||
      showLauncherLogo !== (workspace.show_launcher_logo !== false) ||
      widgetIcon !== initialWidgetIcon ||
      widgetDesign !== initialWidgetDesign ||
      secondaryColor !== initialSecondaryColor ||
      colorMode !== initialColorMode ||
      widgetPosition !== (workspace.widget_position || 'right') ||
      greetingTitle !== (workspace.greeting_title || 'Hi there 👋') ||
      greetingMessage !== (workspace.greeting_message || "We're here to help! Send us a message and we'll reply shortly.") ||
      helpTabLabel !== (workspace.help_center_tab_label || 'Help') ||
      showHelpTab !== (workspace.show_help_tab !== false) ||
      launcherOffsetBottom !== (workspace.launcher_offset_bottom ?? 20) ||
      launcherOffsetSide !== (workspace.launcher_offset_side ?? 20) ||
      widgetZIndex !== (workspace.widget_z_index ?? 2147483000) ||
      enableProactiveWelcome !== (workspace.enable_proactive_welcome !== false) ||
      proactiveDelaySeconds !== Math.max(8, workspace.proactive_delay_seconds ?? 8)
    );
  }, [
    brandColor,
    logoUrl,
    showLauncherLogo,
    widgetIcon,
    initialWidgetIcon,
    widgetDesign,
    initialWidgetDesign,
    secondaryColor,
    initialSecondaryColor,
    colorMode,
    initialColorMode,
    widgetPosition,
    greetingTitle,
    greetingMessage,
    helpTabLabel,
    showHelpTab,
    launcherOffsetBottom,
    launcherOffsetSide,
    widgetZIndex,
    enableProactiveWelcome,
    proactiveDelaySeconds,
    workspace,
  ]);

  /* Save feedback lives in the save bar: an error stays until the next try.
     The bar puts "unsaved changes" ahead of "Saved", so no reset is needed. */
  const [widgetSaveError, setWidgetSaveError] = useState<string | null>(null);
  const [widgetSaved, setWidgetSaved] = useState(false);
  const [confirmWidgetReset, setConfirmWidgetReset] = useState(false);

  const GREETING_TITLE_MAX = 60;
  const brandHexValid = /^#[0-9a-f]{6}$/i.test(brandColor);
  const greetingTitleTooLong = greetingTitle.length > GREETING_TITLE_MAX;
  // The widget switches to dark text on light brand colours (luminance > 0.62
  // in widget/src/index.ts); say so here rather than let it surprise anyone.
  const brandUsesDarkText = useMemo(() => {
    if (!brandHexValid) return false;
    const n = parseInt(brandColor.slice(1), 16);
    const lin = (v: number) => {
      const c = v / 255;
      return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255) > 0.62;
  }, [brandColor, brandHexValid]);

  /** Puts every widget field back to what is saved (Discard). */
  const discardWidgetChanges = () => {
    setBrandColor(workspace.brand_color || DEFAULT_BRAND_COLOR);
    setLogoUrl(workspace.logo_url || '');
    setShowLauncherLogo(workspace.show_launcher_logo !== false);
    setWidgetIcon(initialWidgetIcon);
    setWidgetDesign(initialWidgetDesign);
    setSecondaryColor(initialSecondaryColor);
    setColorMode(initialColorMode);
    setWidgetPosition(workspace.widget_position || 'right');
    setGreetingTitle(workspace.greeting_title || 'Hi there 👋');
    setGreetingMessage(workspace.greeting_message || "We're here to help! Send us a message and we'll reply shortly.");
    setHelpTabLabel(workspace.help_center_tab_label || 'Help');
    setShowHelpTab(workspace.show_help_tab !== false);
    setLauncherOffsetBottom(workspace.launcher_offset_bottom ?? 20);
    setLauncherOffsetSide(workspace.launcher_offset_side ?? 20);
    setWidgetZIndex(workspace.widget_z_index ?? 2147483000);
    setEnableProactiveWelcome(workspace.enable_proactive_welcome !== false);
    setProactiveDelaySeconds(Math.max(8, workspace.proactive_delay_seconds ?? 8));
    setWidgetSaveError(null);
  };

  /** Design defaults, kept unsaved until Save. The logo is the customer's and stays. */
  const resetWidgetToDefaults = () => {
    setBrandColor(DEFAULT_BRAND_COLOR);
    setWidgetIcon(logoUrl && showLauncherLogo ? 'custom_logo' : 'smile_bubble');
    setWidgetDesign(DEFAULT_WIDGET_DESIGN);
    setSecondaryColor('');
    setColorMode('auto');
    setWidgetPosition('right');
    setGreetingTitle('Hi there 👋');
    setGreetingMessage("We're here to help! Send us a message and we'll reply shortly.");
    setHelpTabLabel('Help');
    setShowHelpTab(true);
    setLauncherOffsetBottom(20);
    setLauncherOffsetSide(20);
    setWidgetZIndex(2147483000);
    setEnableProactiveWelcome(true);
    setProactiveDelaySeconds(8);
    setConfirmWidgetReset(false);
  };

  const handleSaveWidget = async () => {
    if (!brandHexValid || greetingTitleTooLong) return;
    setSaving(true);
    setWidgetSaveError(null);
    try {
      const res = await updateWidgetSettingsAction(workspace.id, {
        brand_color: brandColor,
        logo_url: logoUrl,
        show_launcher_logo: showLauncherLogo,
        widget_icon: widgetIcon,
        widget_design: widgetDesign,
        widget_secondary_color: secondaryColor,
        widget_color_mode: colorMode,
        widget_position: widgetPosition,
        greeting_title: greetingTitle,
        greeting_message: greetingMessage,
        help_center_tab_label: helpTabLabel,
        show_help_tab: showHelpTab,
        launcher_offset_bottom: launcherOffsetBottom,
        launcher_offset_side: launcherOffsetSide,
        widget_z_index: widgetZIndex,
        enable_proactive_welcome: enableProactiveWelcome,
        proactive_delay_seconds: proactiveDelaySeconds,
      });
      if (res.workspace) {
        setWorkspace(res.workspace);
        onWorkspaceUpdated?.(res.workspace);
        // The server derives show_launcher_logo from the icon; take its answer
        // or the form disagrees with the saved row and reads as unsaved.
        setShowLauncherLogo(res.workspace.show_launcher_logo !== false);
        setWidgetSaved(true);
      } else {
        // A save that comes back without the row stored nothing: say so.
        setWidgetSaveError("Couldn't save: the change wasn't stored. Your changes are kept.");
      }
    } catch (err: any) {
      setWidgetSaveError(`Couldn't save: ${errorMessage(err, 'the server did not respond').replace(/\.+$/, '')}. Your changes are kept.`);
    } finally {
      setSaving(false);
    }
  };

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const uploadData = new FormData();
    uploadData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: uploadData,
      });
      const data = await res.json();
      if (data.url) {
        setLogoUrl(data.url);
        showStatus('Logo uploaded!');
      }
    } catch (err) {
      showStatus('Failed to upload logo', 'error');
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION: HELP CENTER BRANDING STATE
  // ──────────────────────────────────────────────────────────────────────────
  const [helpCenterTitle, setHelpCenterTitle] = useState(workspace.help_center_title || '');
  const [helpCenterSubtitle, setHelpCenterSubtitle] = useState(workspace.help_center_subtitle || '');
  const [helpCenterLogoUrl, setHelpCenterLogoUrl] = useState(workspace.help_center_logo_url || '');
  const [helpCenterHeaderLinks, setHelpCenterHeaderLinks] = useState<
    Array<{ label: string; url: string; target?: string }>
  >(
    Array.isArray(workspace.help_center_header_links)
      ? (workspace.help_center_header_links as any)
      : []
  );
  const [helpCenterFooterText, setHelpCenterFooterText] = useState(workspace.help_center_footer_text || '');
  const [helpCenterLayout, setHelpCenterLayout] = useState<'grid-2' | 'grid-3' | 'grid-4' | 'list'>(
    (workspace as any).help_center_layout || 'grid-2'
  );

  const isHelpCenterDirty = useMemo(() => {
    return (
      helpCenterTitle !== (workspace.help_center_title || '') ||
      helpCenterSubtitle !== (workspace.help_center_subtitle || '') ||
      helpCenterLogoUrl !== (workspace.help_center_logo_url || '') ||
      helpCenterFooterText !== (workspace.help_center_footer_text || '') ||
      helpCenterLayout !== ((workspace as any).help_center_layout || 'grid-2') ||
      JSON.stringify(helpCenterHeaderLinks) !== JSON.stringify(workspace.help_center_header_links || [])
    );
  }, [
    helpCenterTitle,
    helpCenterSubtitle,
    helpCenterLogoUrl,
    helpCenterFooterText,
    helpCenterLayout,
    helpCenterHeaderLinks,
    workspace,
  ]);
  const [savingHelpCenter, setSavingHelpCenter] = useState(false);
  const [newLinkLabel, setNewLinkLabel] = useState('');
  const [newLinkUrl, setNewLinkUrl] = useState('');
  const [newLinkTarget, setNewLinkTarget] = useState<'_blank' | '_self'>('_blank');

  const handleSaveHelpCenter = async () => {
    setSavingHelpCenter(true);
    try {
      const res = await updateHelpCenterBrandingAction(workspace.id, {
        help_center_title: helpCenterTitle.trim() || null,
        help_center_subtitle: helpCenterSubtitle.trim() || null,
        help_center_logo_url: helpCenterLogoUrl.trim() || null,
        help_center_header_links: helpCenterHeaderLinks,
        help_center_footer_text: helpCenterFooterText.trim() || null,
        help_center_layout: helpCenterLayout,
      });

      if (res.workspace) {
        setWorkspace(res.workspace);
        onWorkspaceUpdated?.(res.workspace);
        showStatus('Help Center branding saved successfully!');
      }
    } catch (err: any) {
      showStatus(errorMessage(err, 'Failed to save Help Center branding'), 'error');
    } finally {
      setSavingHelpCenter(false);
    }
  };

  const handleAddHeaderLink = () => {
    if (!newLinkLabel.trim() || !newLinkUrl.trim()) return;
    setHelpCenterHeaderLinks((prev) => [
      ...prev,
      {
        label: newLinkLabel.trim(),
        url: newLinkUrl.trim(),
        target: newLinkTarget,
      },
    ]);
    setNewLinkLabel('');
    setNewLinkUrl('');
    setNewLinkTarget('_blank');
  };

  const handleRemoveHeaderLink = (index: number) => {
    setHelpCenterHeaderLinks((prev) => prev.filter((_, i) => i !== index));
  };

  const handleHelpCenterLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const uploadData = new FormData();
    uploadData.append('file', file);

    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: uploadData,
      });
      const data = await res.json();
      if (data.url) {
        setHelpCenterLogoUrl(data.url);
        showStatus('Help Center logo uploaded!');
      } else {
        showStatus(data.error || 'Upload failed', 'error');
      }
    } catch {
      showStatus('Failed to upload logo', 'error');
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 2: BUSINESS HOURS STATE
  // ──────────────────────────────────────────────────────────────────────────
  const [businessHours, setBusinessHours] = useState<BusinessHoursConfig>(
    workspace.business_hours || DEFAULT_SCHEDULE
  );
  const [tzSearch, setTzSearch] = useState('');
  const [tzDropdownOpen, setTzDropdownOpen] = useState(false);

  const filteredTimezones = useMemo(() => {
    if (!tzSearch.trim()) return ALL_TIMEZONES.slice(0, 100);
    const q = tzSearch.toLowerCase().replace(/\s+/g, '_');
    return ALL_TIMEZONES.filter(
      (tz) =>
        tz.toLowerCase().includes(q) ||
        tz.toLowerCase().replace(/_/g, ' ').includes(tzSearch.toLowerCase())
    );
  }, [tzSearch]);

  const isHoursDirty = useMemo(() => {
    const orig = workspace.business_hours || DEFAULT_SCHEDULE;
    return JSON.stringify(businessHours) !== JSON.stringify(orig);
  }, [businessHours, workspace.business_hours]);

  const handleSaveBusinessHours = async () => {
    setSaving(true);
    try {
      const res = await updateBusinessHoursAction(workspace.id, businessHours);
      if (res.workspace) {
        setWorkspace(res.workspace);
        onWorkspaceUpdated?.(res.workspace);
        showStatus('Business hours updated successfully!');
      }
    } catch (err: any) {
      showStatus(errorMessage(err, 'Failed to update business hours'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const updateDaySchedule = (
    day: keyof BusinessHoursConfig['schedule'],
    field: 'enabled' | 'start' | 'end',
    value: any
  ) => {
    setBusinessHours((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        [day]: {
          ...prev.schedule[day],
          [field]: value,
        },
      },
    }));
  };

  const copyMondayToWeekdays = () => {
    const mon = businessHours.schedule.monday;
    setBusinessHours((prev) => ({
      ...prev,
      schedule: {
        ...prev.schedule,
        tuesday: { ...mon },
        wednesday: { ...mon },
        thursday: { ...mon },
        friday: { ...mon },
      },
    }));
    showStatus('Copied Monday schedule to Tuesday-Friday');
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 4: CANNED RESPONSES CRUD STATE
  // ──────────────────────────────────────────────────────────────────────────
  const [cannedModalOpen, setCannedModalOpen] = useState(false);
  const [editingCannedId, setEditingCannedId] = useState<string | null>(null);
  const [cannedShortcut, setCannedShortcut] = useState('');
  const [cannedTitle, setCannedTitle] = useState('');
  const [cannedContent, setCannedContent] = useState('');
  const [cannedScope, setCannedScope] = useState<'team' | 'agent'>('team');
  const [cannedSearch, setCannedSearch] = useState('');
  const [cannedFilter, setCannedFilter] = useState<'all' | 'team' | 'agent'>('all');

  const openCreateCanned = () => {
    setEditingCannedId(null);
    setCannedShortcut('/');
    setCannedTitle('');
    setCannedContent('');
    setCannedScope('team');
    setCannedModalOpen(true);
  };

  const openEditCanned = (item: CannedResponse) => {
    setEditingCannedId(item.id);
    setCannedShortcut(item.shortcut);
    setCannedTitle(item.title || '');
    setCannedContent(item.content);
    setCannedScope(item.agent_id ? 'agent' : 'team');
    setCannedModalOpen(true);
  };

  const handleSaveCanned = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!cannedShortcut || !cannedTitle || !cannedContent) return;

    try {
      if (editingCannedId) {
        const res = await updateCannedResponseAction(workspace.id, editingCannedId, {
          shortcut: cannedShortcut,
          title: cannedTitle,
          content: cannedContent,
          scope: cannedScope,
        });
        if (res.cannedResponse) {
          setCannedResponses((prev) =>
            prev.map((c) => (c.id === editingCannedId ? res.cannedResponse : c))
          );
          showStatus('Canned reply updated');
        }
      } else {
        const res = await createCannedResponseAction(workspace.id, {
          shortcut: cannedShortcut,
          title: cannedTitle,
          content: cannedContent,
          scope: cannedScope,
          agent_id: currentAgent.id,
        });
        if (res.cannedResponse) {
          setCannedResponses((prev) => [...prev, res.cannedResponse]);
          showStatus('Canned reply created');
        }
      }
      setCannedModalOpen(false);
    } catch (err: any) {
      showStatus(errorMessage(err, 'Failed to save canned reply'), 'error');
    }
  };

  const handleDeleteCanned = async (id: string, shortcut: string) => {
    if (!confirm(`Delete canned shortcut ${shortcut}?`)) return;
    try {
      await deleteCannedResponseAction(workspace.id, id);
      setCannedResponses((prev) => prev.filter((c) => c.id !== id));
      showStatus(`Deleted ${shortcut}`);
    } catch (err: any) {
      showStatus(errorMessage(err, 'Failed to delete canned reply'), 'error');
    }
  };

  const filteredCanned = cannedResponses.filter((item) => {
    if (cannedFilter === 'team' && item.agent_id !== null) return false;
    if (cannedFilter === 'agent' && item.agent_id === null) return false;
    if (cannedSearch) {
      const q = cannedSearch.toLowerCase();
      return (
        item.shortcut.toLowerCase().includes(q) ||
        (item.title || '').toLowerCase().includes(q) ||
        item.content.toLowerCase().includes(q)
      );
    }
    return true;
  });

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 5: AUTO-ASSIGNMENT RULES STATE
  // ──────────────────────────────────────────────────────────────────────────
  const [autoAssign, setAutoAssign] = useState<AutoAssignmentConfig>(
    workspace.auto_assignment || { enabled: true, max_conversations_per_agent: 5 }
  );

  const isAutoAssignDirty = useMemo(() => {
    const orig = workspace.auto_assignment || { enabled: true, max_conversations_per_agent: 5 };
    return JSON.stringify(autoAssign) !== JSON.stringify(orig);
  }, [autoAssign, workspace.auto_assignment]);

  const handleSaveAutoAssign = async () => {
    setSaving(true);
    try {
      const res = await updateAutoAssignmentRulesAction(workspace.id, autoAssign);
      if (res.workspace) {
        setWorkspace(res.workspace);
        onWorkspaceUpdated?.(res.workspace);
        showStatus('Auto-assignment rules saved!');
      }
    } catch (err: any) {
      showStatus(errorMessage(err, 'Failed to save auto-assignment rules'), 'error');
    } finally {
      setSaving(false);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 7: CLAUDE AI SETTINGS
  // ──────────────────────────────────────────────────────────────────────────
  const [aiSettings, setAiSettings] = useState<AISettingsConfig>({
    enabled: true,
    auto_response_enabled: true,
    auto_response_delay_seconds: 20,
    auto_pilot: false,
    suggested_replies_enabled: true,
    auto_tagging_enabled: true,
    summary_enabled: true,
    sentiment_enabled: true,
    require_approval_for_new_answers: false,
    system_prompt: '',
    ...(workspace.ai_settings || {}),
  });

  const [aiPlanUsage, setAiPlanUsage] = useState<WorkspaceAiPlanAndUsage | null>(null);
  const [loadingAiUsage, setLoadingAiUsage] = useState(false);

  useEffect(() => {
    let active = true;
    if (activeTab === 'ai') {
      setLoadingAiUsage(true);
      void (async () => {
        try {
          const data = await getWorkspaceAiPlanAndUsageAction(workspace.id);
          if (active) {
            setAiPlanUsage(data);
          }
        } catch (err: unknown) {
          console.warn('Could not load AI plan and usage:', err);
        } finally {
          if (active) {
            setLoadingAiUsage(false);
          }
        }
      })();
    }
    return () => {
      active = false;
    };
  }, [activeTab, workspace.id]);

  const isAiDirty = useMemo(() => {
    const orig = {
      enabled: true,
      auto_response_enabled: true,
      auto_response_delay_seconds: 20,
      auto_pilot: false,
      suggested_replies_enabled: true,
      auto_tagging_enabled: true,
      summary_enabled: true,
      sentiment_enabled: true,
      require_approval_for_new_answers: false,
      system_prompt: '',
      ...(workspace.ai_settings || {}),
    };
    const normalize = (s: any) => ({
      enabled: Boolean(s?.enabled ?? true),
      auto_response_enabled: Boolean(s?.auto_response_enabled ?? true),
      auto_response_delay_seconds: Number(s?.auto_response_delay_seconds ?? 20),
      auto_pilot: Boolean(s?.auto_pilot ?? false),
      suggested_replies_enabled: Boolean(s?.suggested_replies_enabled ?? true),
      auto_tagging_enabled: Boolean(s?.auto_tagging_enabled ?? true),
      summary_enabled: Boolean(s?.summary_enabled ?? true),
      sentiment_enabled: Boolean(s?.sentiment_enabled ?? true),
      require_approval_for_new_answers: Boolean(s?.require_approval_for_new_answers ?? false),
      system_prompt: (s?.system_prompt || '').trim(),
      answer_mode: s?.answer_mode === 'strict' ? 'strict' : 'agent',
    });
    return JSON.stringify(normalize(aiSettings)) !== JSON.stringify(normalize(orig));
  }, [aiSettings, workspace.ai_settings]);

  const activeSectionDirty =
    (activeTab === 'widget' && isWidgetDirty) ||
    (activeTab === 'helpcenter' && isHelpCenterDirty) ||
    (activeTab === 'hours' && isHoursDirty) ||
    (activeTab === 'assignment' && isAutoAssignDirty) ||
    (activeTab === 'ai' && isAiDirty);
  useEffect(() => {
    onDirtyChange?.(activeSectionDirty);
    return () => onDirtyChange?.(false);
  }, [activeSectionDirty, onDirtyChange]);

  const handleSaveAISettings = async () => {
    setSaving(true);
    try {
      const res = await updateAISettingsAction(workspace.id, aiSettings);
      if (!res.ok) {
        showStatus(res.error || 'Failed to save AI settings', 'error');
        return;
      }
      if (res.workspace) {
        setWorkspace(res.workspace);
        onWorkspaceUpdated?.(res.workspace);
        showStatus('AI settings saved successfully!');
      }
    } catch (err: unknown) {
      const msg = errorMessage(err, 'Failed to save AI settings');
      showStatus(msg, 'error');
    } finally {
      setSaving(false);
    }
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 6: INSTALL SNIPPET
  // ──────────────────────────────────────────────────────────────────────────
  const origin = getWidgetOrigin();
  // The widget tracks visits and presence itself; tracker.js is only for
  // pages without the chat (and steps aside where the widget is present).
  const installSnippetCode = `<!-- Zen-try Live Chat Widget -->
<script
  src="${origin}/widget.js"
  data-workspace-id="${workspace.id}"
  defer
></script>`;

  const copySnippet = () => {
    navigator.clipboard.writeText(installSnippetCode);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
    showStatus('Code snippet copied to clipboard!');
  };

  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 8: 1-STEP CUSTOM DOMAIN & HELP CENTER STATE & HANDLERS
  // ──────────────────────────────────────────────────────────────────────────
  const [copiedPublicUrl, setCopiedPublicUrl] = useState(false);

  // Subdomain & Slug customization state
  const [slugInput, setSlugInput] = useState(workspace.slug || '');
  const [slugAvailability, setSlugAvailability] = useState<{
    checking: boolean;
    available?: boolean;
    error?: string;
    formattedSlug?: string;
  }>({ checking: false });
  const [savingSlug, setSavingSlug] = useState(false);
  const [isEditingSlug, setIsEditingSlug] = useState(false);
  const [showSlugConfirm, setShowSlugConfirm] = useState(false);
  const isOwner = currentAgent.role === 'owner';
  const hasCustomizedSlug = (workspace.slug_changes_count ?? 0) >= 1;


  // Debounced check availability when slugInput changes
  useEffect(() => {
    const trimmed = slugInput.trim().toLowerCase();
    if (!isEditingSlug || trimmed === (workspace.slug || '').toLowerCase()) {
      setSlugAvailability({ checking: false });
      return;
    }

    if (trimmed.length < 2) {
      setSlugAvailability({ checking: false, available: false, error: 'Slug must be at least 2 characters.' });
      return;
    }

    setSlugAvailability({ checking: true });
    const timer = setTimeout(async () => {
      try {
        const res = await checkWorkspaceSlugAvailabilityAction(workspace.id, trimmed);
        setSlugAvailability({
          checking: false,
          available: res.available,
          error: res.error,
          formattedSlug: res.formattedSlug,
        });
      } catch (err: any) {
        setSlugAvailability({ checking: false, available: false, error: errorMessage(err, 'Error checking availability') });
      }
    }, 400);

    return () => clearTimeout(timer);
  }, [slugInput, isEditingSlug, workspace.id, workspace.slug]);

  const handleSaveSlug = async () => {
    if (!isOwner) {
      showStatus('Only the workspace owner can customize the subdomain slug.', 'error');
      return;
    }
    if (hasCustomizedSlug) {
      showStatus('The workspace slug can only be customized once.', 'error');
      return;
    }
    setSavingSlug(true);
    try {
      const res = await updateWorkspaceSlugAction(workspace.id, slugInput);
      if (res.success && res.data) {
        setWorkspace(res.data.workspace);
        onWorkspaceUpdated?.(res.data.workspace);
        setIsEditingSlug(false);
        setShowSlugConfirm(false);
        showStatus('Subdomain slug successfully saved! Your Help Center is live at the new address.', 'success');
      } else {
        showStatus(res.error || 'Failed to update slug', 'error');
      }
    } catch (err: any) {
      showStatus(errorMessage(err, 'Error updating slug'), 'error');
    } finally {
      setSavingSlug(false);
    }
  };


  // ──────────────────────────────────────────────────────────────────────────
  // SECTION 9: ZERO-CODE NAVBAR AUTO-TRIGGER BUTTON STATE & HANDLER
  // ──────────────────────────────────────────────────────────────────────────
  const [navbarConfig, setNavbarConfig] = useState<NavbarTriggerConfig>(
    workspace.navbar_trigger_config || {
      enabled: false,
      label: 'Help',
      action: 'help',
      auto_inject: true,
      style: 'navbar_link',
      position: 'end',
    }
  );
  const [savingNavbar, setSavingNavbar] = useState(false);
  const [isNavbarSimulatorOpen, setIsNavbarSimulatorOpen] = useState(false);

  // Requirement 4: Settings must always load and show the saved values (label, action, on/off)
  useEffect(() => {
    if (workspace.navbar_trigger_config) {
      setNavbarConfig({
        enabled: Boolean(workspace.navbar_trigger_config.enabled),
        label: workspace.navbar_trigger_config.label || 'Help',
        action: workspace.navbar_trigger_config.action || 'help',
        style: workspace.navbar_trigger_config.style || 'navbar_link',
        position: (workspace.navbar_trigger_config as any).position || 'end',
        auto_inject: workspace.navbar_trigger_config.auto_inject !== false,
        target_selector: workspace.navbar_trigger_config.target_selector || '',
        dismissed_prompt: workspace.navbar_trigger_config.dismissed_prompt,
      });
    }
  }, [workspace.navbar_trigger_config]);

  // The hand-placed version of the navbar link does what the dropdown says.
  // Panel and chat buttons are handled by the widget on any page it runs on,
  // so they need no URL; only "open help center" links out.
  const manualNavLabel = (navbarConfig.label || 'Help').replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  const manualNavSnippet =
    navbarConfig.action === 'redirect'
      ? `<a href="${getWorkspaceHelpCenterUrl(workspace)}" target="_blank" rel="noopener noreferrer">${manualNavLabel}</a>`
      : navbarConfig.action === 'messages'
      ? `<a href="#" data-zentry-open data-zentry-tab="messages">${manualNavLabel}</a>`
      : `<a href="#" data-zentry-help>${manualNavLabel}</a>`;

  const handleSaveNavbarConfig = async () => {
    setSavingNavbar(true);
    try {
      const res = await updateNavbarTriggerConfigAction(workspace.id, navbarConfig);
      if (res.workspace) {
        setWorkspace(res.workspace);
        onWorkspaceUpdated?.(res.workspace);
        showStatus('Navbar button updated! Changes are live on your website.');
      }
    } catch (err: any) {
      showStatus(errorMessage(err, 'Failed to update navbar button settings'), 'error');
    } finally {
      setSavingNavbar(false);
    }
  };

  return (
    <div
      className={
        embedded
          ? 'w-full relative'
          : 'flex-1 flex flex-col h-full bg-canvas overflow-y-auto relative'
      }
    >
      {/* Toast Notification (Visible at top-right on save across all tabs) */}
      {statusMessage && (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            'fixed top-5 right-5 z-[9999] px-4 py-2.5 rounded-lg text-xs font-semibold flex items-center gap-2.5 shadow-lg border animate-toast transition-all',
            statusMessage.type === 'success'
              ? 'bg-success-soft/95 text-success border-success-line'
              : 'bg-danger-soft/95 text-danger border-danger-line'
          )}
        >
          {statusMessage.type === 'success' ? (
            <div className="w-5 h-5 rounded-full bg-success text-ink-inv flex items-center justify-center shrink-0">
              <Check className="w-3.5 h-3.5 stroke-[3]" />
            </div>
          ) : (
            <div className="w-5 h-5 rounded-full bg-danger text-ink-inv flex items-center justify-center shrink-0">
              <AlertCircle className="w-3.5 h-3.5 stroke-[3]" />
            </div>
          )}
          <span className="text-ui">{statusMessage.text}</span>
          <button
            type="button"
            onClick={() => setStatusMessage(null)}
            className="ml-1 text-ink-3 hover:text-ink p-0.5 rounded-md"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
      {!embedded && (
      <>
      {/* Header */}
      <div className="h-16 px-8 border-b border-line flex items-center justify-between bg-surface sticky top-0 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-accent/10 text-accent flex items-center justify-center font-bold">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-lg font-bold text-ink tracking-tight">Admin settings</h1>
              <span className="text-2xs px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">
                Admin role required
              </span>
            </div>
            <p className="text-xs text-ink-3">
              Configure workspace customization, business hours, permissions, and routing.
            </p>
          </div>
        </div>

        {statusMessage && (
          <div
            className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 shadow-sm animate-rise ${
              statusMessage.type === 'success'
                ? 'bg-success-soft text-success border border-success-line'
                : 'bg-danger-soft text-danger border border-danger-line'
            }`}
          >
            {statusMessage.type === 'success' ? (
              <Check className="w-3.5 h-3.5" />
            ) : (
              <AlertCircle className="w-3.5 h-3.5" />
            )}
            {statusMessage.text}
          </div>
        )}
      </div>

      {/* Tabs Bar */}
      <div className="px-8 border-b border-line bg-surface sticky top-16 z-10 flex gap-2">
        {[
          { id: 'widget', label: 'Widget customization', icon: Palette },
          { id: 'helpcenter', label: 'Help center branding', icon: BookOpen },
          { id: 'domain', label: 'Custom domains', icon: Globe },
          { id: 'hours', label: 'Business hours', icon: Clock },
          { id: 'canned', label: 'Canned replies', icon: MessageSquareText, badge: cannedResponses.length },
          { id: 'assignment', label: 'Auto-Assignment', icon: Sliders },
          { id: 'ai', label: 'AI assistant', icon: Sparkles },
          { id: 'email', label: 'Email (SMTP)', icon: Mail },
          { id: 'snippet', label: 'Install snippet', icon: Code },
        ].map((tab) => {
          const active = activeTab === tab.id;
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as any)}
              className={`flex items-center gap-2 px-4 py-3 text-ui font-medium border-b-2 transition-colors -mb-px ${
                active
                  ? 'border-accent text-accent font-semibold'
                  : 'border-transparent text-ink-3 hover:text-ink hover:border-line-2'
              }`}
            >
              <Icon className="w-4 h-4" />
              <span>{tab.label}</span>
              {tab.badge !== undefined && (
                <span className="text-2xs px-1.5 py-0.5 rounded-full bg-surface-2 text-ink-2">
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      </>
      )}


      {/* Tab Panels */}
      <div className={embedded ? 'w-full space-y-8 pb-16' : 'p-8 max-w-6xl mx-auto w-full space-y-8 pb-20'}>
        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 1: WIDGET CUSTOMIZATION & LIVE PREVIEW */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'widget' && (
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start animate-rise">
            {/* Left Column: Form Controls */}
            <div className="lg:col-span-7 space-y-6">
              {/* Header Action Bar */}
              <div className="flex justify-end -mb-2">
                <Button variant="ghost" size="sm" onClick={() => setConfirmWidgetReset(true)}>
                  <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                  Reset to defaults
                </Button>
              </div>

              {/* Step 1: Brand Color & Visual Theme */}
              <div className="card p-6 space-y-5 border border-line">
                <div className="flex items-center gap-3 border-b border-line-2 pb-4">
                  <span className="w-7 h-7 rounded-md bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                    1
                  </span>
                  <div>
                    <h4 className="text-md font-bold text-ink">Brand colour</h4>
                    <p className="text-xs text-ink-2 mt-0.5">
                      Themes the widget header, floating launcher button, and active chat elements.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  <div className="flex items-center gap-3.5">
                    <div className="relative flex items-center">
                      <input
                        type="color"
                        value={brandColor}
                        onChange={(e) => setBrandColor(e.target.value)}
                        className="w-12 h-12 rounded-md border border-line cursor-pointer p-0.5 bg-surface-2 hover:border-accent transition-colors"
                        title="Pick custom color"
                      />
                    </div>
                    <div className="space-y-1">
                      <label htmlFor="widget-brand-hex" className="field-label mb-1">Hex code</label>
                      <input
                        id="widget-brand-hex"
                        type="text"
                        value={brandColor}
                        onChange={(e) => setBrandColor(e.target.value.trim())}
                        placeholder={DEFAULT_BRAND_COLOR}
                        spellCheck={false}
                        aria-invalid={!brandHexValid}
                        aria-describedby="widget-brand-hex-hint"
                        className="input input-sm w-36 font-mono uppercase"
                      />
                      <p
                        id="widget-brand-hex-hint"
                        role={brandHexValid ? undefined : 'alert'}
                        className={cn('text-xs', brandHexValid ? 'text-ink-3' : 'text-danger')}
                      >
                        {!brandHexValid
                          ? 'Use a 6-digit hex colour, like #2e5bff.'
                          : brandUsesDarkText
                          ? 'Light colour: the widget will put dark text on it so it stays readable.'
                          : 'Used for the header, launcher and your visitors\u2019 messages.'}
                      </p>
                    </div>
                  </div>

                  {/* Preset Swatches */}
                  <div>
                    <div className="eyebrow mb-2.5">
                      Suggested colours
                    </div>
                    <div className="flex flex-wrap items-center gap-2.5">
                      {[
                        { color: DEFAULT_BRAND_COLOR, label: 'Zen-try Blue' },
                        { color: '#0d9488', label: 'Teal' },
                        { color: '#10b981', label: 'Emerald' },
                        { color: '#8b5cf6', label: 'Violet' },
                        { color: '#ec4899', label: 'Pink' },
                        { color: '#f97316', label: 'Orange' },
                        { color: '#0f172a', label: 'Midnight slate' },
                      ].map(({ color, label }) => {
                        const isSelected = brandColor.toLowerCase() === color.toLowerCase();
                        return (
                          <button
                            key={color}
                            type="button"
                            onClick={() => setBrandColor(color)}
                            className={cn(
                              'flex items-center gap-2 px-3 py-1.5 rounded-md border text-xs font-semibold transition-colors',
                              isSelected
                                ? 'border-accent bg-accent/15 text-accent ring-2 ring-accent/30'
                                : 'border-line-2 bg-surface hover:bg-surface-2 text-ink hover:border-line-3'
                            )}
                          >
                            <span
                              className="w-3.5 h-3.5 rounded-full shrink-0 border border-black/20"
                              style={{ backgroundColor: color }}
                            />
                            <span>{label}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>

              {/* Step 2: Logo & Floating Launcher Button */}
              <div className="card p-6 space-y-6 border border-line">
                <div className="flex items-center gap-3 border-b border-line-2 pb-4">
                  <span className="w-7 h-7 rounded-md bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                    2
                  </span>
                  <div>
                    <h4 className="text-md font-bold text-ink">Design, launcher &amp; logo</h4>
                    <p className="text-xs text-ink-2 mt-0.5">
                      Pick one of four messenger designs, the button that opens it, and the logo shown inside.
                    </p>
                  </div>
                </div>

                {/* ── Messenger design ── */}
                <div className="space-y-3">
                  <div>
                    <h5 className="text-md font-semibold text-ink">Messenger design</h5>
                    <p className="text-xs text-ink-3 mt-0.5">How the chat window looks on your website. Your brand colour is used in all four.</p>
                  </div>
                  <DesignPicker value={widgetDesign} onChange={setWidgetDesign} brand={brandColor} secondary={secondaryColor} />
                </div>

                {/* ── Colours (every design uses them) ── */}
                <div className="grid gap-4 sm:grid-cols-2">
                  <div>
                    <div className="text-ui font-semibold text-ink">Second colour</div>
                    <p className="text-xs text-ink-3 mt-0.5">The other end of gradients (Messenger, Modern). Automatic uses a darker brand colour.</p>
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        type="color"
                        aria-label="Second colour"
                        value={secondaryColor || brandColor}
                        onChange={(e) => setSecondaryColor(e.target.value)}
                        className="h-9 w-12 rounded-lg border border-line bg-surface cursor-pointer"
                      />
                      <span className="text-xs font-mono text-ink-2">{secondaryColor || 'Automatic'}</span>
                      {secondaryColor && (
                        <button type="button" className="btn btn-xs btn-ghost" onClick={() => setSecondaryColor('')}>
                          Use automatic
                        </button>
                      )}
                    </div>
                  </div>
                  <div>
                    <div className="text-ui font-semibold text-ink">Window theme</div>
                    <p className="text-xs text-ink-3 mt-0.5">Light, dark, or whatever the visitor&apos;s device uses.</p>
                    <div role="radiogroup" aria-label="Window theme" className="mt-2 inline-flex p-0.5 rounded-lg border border-line bg-surface-2">
                      {WIDGET_COLOR_MODES.map((m) => (
                        <button
                          key={m.id}
                          type="button"
                          role="radio"
                          aria-checked={colorMode === m.id}
                          onClick={() => setColorMode(m.id)}
                          className={cn(
                            'h-8 px-3 rounded-md text-xs font-medium transition-colors',
                            colorMode === m.id ? 'bg-surface text-ink' : 'text-ink-3 hover:text-ink'
                          )}
                        >
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* ── Launcher icon ── */}
                <div className="space-y-3">
                  <div>
                    <h5 className="text-md font-semibold text-ink">Launcher icon</h5>
                    <p className="text-xs text-ink-3 mt-0.5">The button visitors click to open the chat, shown in the design you picked.</p>
                  </div>
                  <LauncherIconPicker
                    value={widgetIcon}
                    design={widgetDesign}
                    brand={brandColor}
                    secondary={secondaryColor}
                    logoUrl={logoUrl}
                    onChange={(icon) => {
                      setWidgetIcon(icon);
                      setShowLauncherLogo(icon === 'custom_logo');
                      if (icon === 'custom_logo' && !logoUrl) logoFileInputRef.current?.click();
                    }}
                  />
                </div>

                {/* ── Logo ── */}
                <div className="flex items-start gap-4 p-4 rounded-md border border-line bg-surface-2">
                  <div className="w-16 h-16 rounded-md border border-line bg-surface grid place-items-center overflow-hidden shrink-0">
                    {logoUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={logoUrl} alt="Your logo" className="w-full h-full object-cover" />
                    ) : (
                      <ImageIcon className="w-6 h-6 text-ink-3" aria-hidden="true" />
                    )}
                  </div>
                  <div className="space-y-2.5 flex-1 min-w-0">
                    <div>
                      <div className="text-ui font-semibold text-ink">Logo</div>
                      <p className="text-xs text-ink-3 mt-0.5">
                        Shown in the messenger header{widgetIcon === 'custom_logo' ? ' and on the launcher' : ''}. A square PNG or SVG of at least 256 × 256 px looks sharpest.
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <label className="btn btn-sm btn-secondary cursor-pointer">
                        <Upload className="w-3.5 h-3.5" />
                        <span>{logoUrl ? 'Replace logo' : 'Upload logo'}</span>
                        <input ref={logoFileInputRef} type="file" accept="image/*" onChange={handleLogoUpload} className="hidden" />
                      </label>
                      {logoUrl && (
                        <button
                          type="button"
                          onClick={() => {
                            setLogoUrl('');
                            if (widgetIcon === 'custom_logo') {
                              setWidgetIcon('smile_bubble');
                              setShowLauncherLogo(false);
                            }
                          }}
                          className="btn btn-sm btn-ghost text-danger"
                        >
                          Remove
                        </button>
                      )}
                    </div>
                    <input
                      type="url"
                      aria-label="Logo image address"
                      placeholder="Or paste an image address (https://…/logo.png)"
                      value={logoUrl}
                      onChange={(e) => setLogoUrl(e.target.value)}
                      className="input input-sm"
                    />
                  </div>
                </div>
              </div>

              {/* Step 3: Screen Placement */}
              <div className="card p-6 space-y-4 border border-line">
                <div className="flex items-center gap-3 border-b border-line-2 pb-4">
                  <span className="w-7 h-7 rounded-md bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                    3
                  </span>
                  <div>
                    <h4 className="text-md font-bold text-ink">Screen placement</h4>
                    <p className="text-xs text-ink-2 mt-0.5">
                      Position of the floating chat launcher on your website.
                    </p>
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <button
                    type="button"
                    onClick={() => setWidgetPosition('right')}
                    className={`p-4 rounded-lg border text-left transition-colors ${
                      widgetPosition === 'right'
                        ? 'border-accent bg-accent/10 ring-2 ring-accent/30 text-ink'
                        : 'border-line-2 bg-surface hover:bg-surface-2 text-ink-2'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {widgetPosition === 'right' ? (
                          <CheckCircle2 className="w-4 h-4 text-accent" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-line" />
                        )}
                        <span className="font-bold text-ui text-ink">Bottom right</span>
                      </div>
                      <span className="text-2xs px-2 py-0.5 rounded-full bg-accent text-white font-semibold">
                        Recommended
                      </span>
                    </div>
                    <div className="text-ink-2 text-xs leading-relaxed pl-6">
                      Standard placement on 95% of websites. Maximum visibility for visitors.
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setWidgetPosition('left')}
                    className={`p-4 rounded-lg border text-left transition-colors ${
                      widgetPosition === 'left'
                        ? 'border-accent bg-accent/10 ring-2 ring-accent/30 text-ink'
                        : 'border-line-2 bg-surface hover:bg-surface-2 text-ink-2'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        {widgetPosition === 'left' ? (
                          <CheckCircle2 className="w-4 h-4 text-accent" />
                        ) : (
                          <div className="w-4 h-4 rounded-full border border-line" />
                        )}
                        <span className="font-bold text-ui text-ink">Bottom left</span>
                      </div>
                      <span className="text-2xs px-2 py-0.5 rounded-full bg-surface-3 text-ink-2 font-bold border border-line-2">
                        Alternate
                      </span>
                    </div>
                    <div className="text-ink-2 text-xs leading-relaxed pl-6">
                      Great if your website already has a WhatsApp button or Back-to-Top on the right.
                    </div>
                  </button>
                </div>

                {/* Launcher Offsets & Z-index */}
                <div className="pt-4 border-t border-line-2 space-y-3.5">
                  <div>
                    <h5 className="text-ui font-bold text-ink">Launcher position and layering</h5>
                    <p className="text-xs text-ink-2">
                      Adjust exact pixel spacing and stack order so the chat button never blocks your site's navigation or buttons.
                    </p>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <div>
                      <label className="field-label text-ink font-semibold text-xs mb-1 block">
                        Bottom offset (px)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={300}
                        value={launcherOffsetBottom}
                        onChange={(e) => setLauncherOffsetBottom(Number(e.target.value))}
                        className="input text-xs border border-line focus:border-accent text-ink font-semibold"
                        placeholder="20"
                      />
                      <p className="text-2xs text-ink-2 mt-1">Default: 20px</p>
                    </div>

                    <div>
                      <label className="field-label text-ink font-semibold text-xs mb-1 block">
                        Side offset (px)
                      </label>
                      <input
                        type="number"
                        min={0}
                        max={300}
                        value={launcherOffsetSide}
                        onChange={(e) => setLauncherOffsetSide(Number(e.target.value))}
                        className="input text-xs border border-line focus:border-accent text-ink font-semibold"
                        placeholder="20"
                      />
                      <p className="text-2xs text-ink-2 mt-1">Default: 20px</p>
                    </div>

                    <div>
                      <label className="field-label text-ink font-semibold text-xs mb-1 block">
                        Z-index
                      </label>
                      <input
                        type="number"
                        min={1}
                        max={2147483647}
                        value={widgetZIndex}
                        onChange={(e) => setWidgetZIndex(Number(e.target.value))}
                        className="input text-xs border border-line focus:border-accent text-ink font-semibold"
                        placeholder="2147483000"
                      />
                      <p className="text-2xs text-ink-2 mt-1">Default: 2147483000</p>
                    </div>
                  </div>
                </div>
              </div>

              {/* Step 4: Greetings & Welcome Message */}
              <div className="card p-6 space-y-4 border border-line">
                <div className="flex items-center gap-3 border-b border-line-2 pb-4">
                  <span className="w-7 h-7 rounded-md bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                    4
                  </span>
                  <div>
                    <h4 className="text-md font-bold text-ink">Greeting and welcome message</h4>
                    <p className="text-xs text-ink-2 mt-0.5">
                      The first messages visitors read when opening the live chat.
                    </p>
                  </div>
                </div>

                <div className="space-y-3.5">
                  <div>
                    <label htmlFor="widget-greeting-title" className="field-label">Welcome title</label>
                    <input
                      id="widget-greeting-title"
                      type="text"
                      value={greetingTitle}
                      onChange={(e) => setGreetingTitle(e.target.value)}
                      placeholder="Hi there 👋"
                      aria-invalid={greetingTitleTooLong}
                      aria-describedby="widget-greeting-title-hint"
                      className="input"
                    />
                    <p
                      id="widget-greeting-title-hint"
                      role={greetingTitleTooLong ? 'alert' : undefined}
                      className={cn('mt-1 text-xs tabular-nums', greetingTitleTooLong ? 'text-danger' : 'text-ink-3')}
                    >
                      {greetingTitleTooLong
                        ? `Keep it to ${GREETING_TITLE_MAX} characters (${greetingTitle.length}/${GREETING_TITLE_MAX}).`
                        : `${greetingTitle.length}/${GREETING_TITLE_MAX}`}
                    </p>
                  </div>
                  <div>
                    <label className="field-label">Welcome text</label>
                    <textarea
                      rows={3}
                      value={greetingMessage}
                      onChange={(e) => setGreetingMessage(e.target.value)}
                      placeholder={`Welcome to ${workspace.name || 'our support'}`}
                      className="input resize-none text-ui leading-relaxed border border-line focus:border-accent text-ink"
                    />
                    <p className="text-2xs text-ink-2 mt-1">
                      Customise the welcome message sent when visitors start a conversation.
                    </p>
                  </div>

                  {/* Proactive welcome bubble Setting */}
                  <div className="p-4 rounded-md border border-line bg-surface-2/70 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="space-y-0.5 pr-4">
                        <label className="text-ui font-bold text-ink cursor-pointer" htmlFor="toggle-proactive-welcome">
                          Proactive welcome bubble
                        </label>
                        <p className="text-xs text-ink-2">
                          Show an unobtrusive bubble invitation next to the launcher. Automatically delayed and suppressed when host page modals or overlays are open.
                        </p>
                      </div>
                      <label className="relative inline-flex items-center cursor-pointer shrink-0">
                        <input
                          id="toggle-proactive-welcome"
                          type="checkbox"
                          checked={enableProactiveWelcome}
                          onChange={(e) => setEnableProactiveWelcome(e.target.checked)}
                          className="sr-only peer"
                        />
                        <div className="w-11 h-6 bg-line-2 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                      </label>
                    </div>

                    {enableProactiveWelcome && (
                      <div className="pt-2 border-t border-line-2 flex items-center justify-between gap-4">
                        <div>
                          <label className="text-xs font-semibold text-ink block">
                            Delay (seconds)
                          </label>
                          <span className="text-2xs text-ink-2">Minimum delay is 8 seconds after page load</span>
                        </div>
                        <input
                          type="number"
                          min={8}
                          max={120}
                          value={proactiveDelaySeconds}
                          onChange={(e) => setProactiveDelaySeconds(Math.max(8, Number(e.target.value)))}
                          className="input w-24 text-xs font-semibold text-center border border-line focus:border-accent text-ink"
                        />
                      </div>
                    )}
                  </div>
                </div>
              </div>

              {/* Step 5: In-Widget Self-Service Help Desk Tab */}
              <div className="card p-6 space-y-4 border border-line">
                <div className="flex items-center gap-3 border-b border-line-2 pb-4">
                  <span className="w-7 h-7 rounded-md bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                    5
                  </span>
                  <div>
                    <h4 className="text-md font-bold text-ink">Help center tab</h4>
                    <p className="text-xs text-ink-2 mt-0.5">
                      Allow visitors to browse knowledge base articles directly inside the chat window.
                    </p>
                  </div>
                </div>

                <div className="space-y-3.5">
                  <div className="flex items-center justify-between p-4 rounded-md border border-line bg-surface-2/70">
                    <div>
                      <div className="text-ui font-bold text-ink">Show the help tab</div>
                      <p className="text-xs text-ink-2">
                        Visitors can search helpful articles without leaving the chat launcher.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={showHelpTab}
                        onChange={(e) => setShowHelpTab(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-line-2 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>

                  <div>
                    <label className="field-label">Help tab label</label>
                    <input
                      type="text"
                      value={helpTabLabel}
                      onChange={(e) => setHelpTabLabel(e.target.value)}
                      placeholder="e.g. Help, FAQs, Guides"
                      className="input text-sm border border-line focus:border-accent text-ink font-semibold"
                    />
                  </div>
                </div>
              </div>

              {/* Step 6: Widget Visibility & Device Display Rules */}
              <div className="card p-6 space-y-4 border border-line">
                <div className="flex items-center gap-3 border-b border-line-2 pb-4">
                  <span className="w-7 h-7 rounded-md bg-accent-soft text-accent font-semibold text-xs flex items-center justify-center shrink-0">
                    6
                  </span>
                  <div>
                    <h4 className="text-md font-bold text-ink">Visibility and devices</h4>
                    <p className="text-xs text-ink-2 mt-0.5">
                      Control which devices show the widget and configure live presence visibility.
                    </p>
                  </div>
                </div>

                <div className="space-y-4">
                  {/* Device Visibility Selector */}
                  <div>
                    <label className="field-label mb-2.5 flex items-center justify-between">
                      <span>Show on</span>
                      <span className="text-xs text-accent font-semibold">Active: {widgetVisibilityDevice === 'all' ? 'All devices' : widgetVisibilityDevice === 'desktop' ? 'Desktop only' : 'Mobile only'}</span>
                    </label>
                    <div className="grid grid-cols-3 gap-2.5">
                      {[
                        { id: 'all', label: 'All devices', sub: 'Desktop + Mobile', icon: Monitor },
                        { id: 'desktop', label: 'Desktop only', sub: 'Laptops & PCs', icon: Laptop },
                        { id: 'mobile', label: 'Mobile only', sub: 'Phones & Tablets', icon: Smartphone },
                      ].map((item) => {
                        const Icon = item.icon;
                        const isSelected = widgetVisibilityDevice === item.id;
                        return (
                          <button
                            key={item.id}
                            type="button"
                            onClick={() => {
                              setWidgetVisibilityDevice(item.id as any);
                              if (item.id === 'mobile') setPreviewDevice('mobile');
                              if (item.id === 'desktop') setPreviewDevice('desktop');
                            }}
                            className={cn(
                              'p-3 rounded-md border text-center flex flex-col items-center gap-1.5 transition-colors',
                              isSelected
                                ? 'border-accent bg-accent-soft text-accent font-bold'
                                : 'border-line-2 bg-surface hover:bg-surface-2 text-ink-2 hover:text-ink'
                            )}
                          >
                            <Icon className="w-5 h-5" />
                            <div className="text-xs font-bold leading-tight">{item.label}</div>
                            <div className="text-2xs text-ink-2 leading-none font-medium">{item.sub}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  {/* Online Presence Status Toggle */}
                  <div className="flex items-center justify-between p-4 rounded-md border border-line bg-surface-2/80">
                    <div>
                      <div className="text-ui font-bold text-ink flex items-center gap-2">
                        <span>Show online status</span>
                        <span className="w-2 h-2 rounded-full bg-success animate-pulse inline-block" />
                      </div>
                      <p className="text-xs text-ink-2 mt-0.5">
                        Display a green &ldquo;We reply immediately&rdquo; status badge in the chat window header.
                      </p>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer shrink-0">
                      <input
                        type="checkbox"
                        checked={showOnlineStatusBadge}
                        onChange={(e) => setShowOnlineStatusBadge(e.target.checked)}
                        className="sr-only peer"
                      />
                      <div className="w-11 h-6 bg-line-2 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>
                </div>
              </div>

              <div className="relative z-20">
                <SaveBar
                  dirty={isWidgetDirty}
                  saving={saving}
                  saved={widgetSaved}
                  error={
                    widgetSaveError ??
                    (!brandHexValid ? 'Fix the brand colour before saving.' : greetingTitleTooLong ? 'Shorten the welcome title before saving.' : null)
                  }
                  onSave={handleSaveWidget}
                  onDiscard={discardWidgetChanges}
                  disabled={!brandHexValid || greetingTitleTooLong}
                  saveLabel={widgetSaveError ? 'Try again' : 'Save changes'}
                />
              </div>
              <Modal
                open={confirmWidgetReset}
                title="Reset the widget to its defaults?"
                onClose={() => setConfirmWidgetReset(false)}
                footer={
                  <>
                    <Button variant="ghost" size="sm" onClick={() => setConfirmWidgetReset(false)}>Cancel</Button>
                    <Button variant="primary" size="sm" onClick={resetWidgetToDefaults}>Reset to defaults</Button>
                  </>
                }
              >
                <p className="text-sm text-ink-2">
                  Colour, design, launcher, position and greeting go back to the defaults. Your logo stays.
                  Nothing changes on your site until you save.
                </p>
              </Modal>
            </div>

            {/* Right Column: Interactive Live Preview with Realistic Browser Frame */}
            <div className="lg:col-span-5 sticky top-28 space-y-3">
              <div className="panel p-4 space-y-3 bg-surface border border-line">
                <div className="flex items-center justify-between border-b border-line-2 pb-2.5">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-accent" />
                    <span className="text-sm font-semibold text-ink">Live preview</span>
                  </div>

                  {/* Device Toggle + Open/Close */}
                  <div className="flex items-center gap-2">
                    <div className="flex items-center bg-surface-2 p-0.5 rounded-lg border border-line-2">
                      <button
                        type="button"
                        onClick={() => setPreviewDevice('desktop')}
                        className={cn(
                          'p-1 rounded-md text-2xs font-bold transition-all flex items-center gap-1',
                          previewDevice === 'desktop'
                            ? 'bg-surface text-accent'
                            : 'text-ink-2 hover:text-ink'
                        )}
                        title="Desktop view"
                      >
                        <Laptop className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Desktop</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewDevice('mobile')}
                        className={cn(
                          'p-1 rounded-md text-2xs font-bold transition-all flex items-center gap-1',
                          previewDevice === 'mobile'
                            ? 'bg-surface text-accent'
                            : 'text-ink-2 hover:text-ink'
                        )}
                        title="Mobile view"
                      >
                        <Smartphone className="w-3.5 h-3.5" />
                        <span className="hidden sm:inline">Mobile</span>
                      </button>
                    </div>

                    <button
                      type="button"
                      onClick={() => setPreviewOpen(!previewOpen)}
                      className="text-xs font-bold text-accent hover:underline px-2.5 py-1 rounded-md hover:bg-accent/10 border border-accent/20"
                    >
                      {previewOpen ? 'Minimize' : 'Open'}
                    </button>
                  </div>
                </div>

                {/* Realistic Simulated Webpage Canvas */}
                <div
                  className={cn(
                    'relative h-[530px] rounded-2xl bg-canvas border border-line overflow-hidden flex flex-col justify-between transition-all duration-300',
                    previewDevice === 'mobile' ? 'max-w-[340px] mx-auto ring-4 ring-black/10' : 'w-full'
                  )}
                >
                  {/* Browser Window Title Bar */}
                  <div className="h-8.5 bg-surface border-b border-line-2 px-3 flex items-center gap-2 shrink-0 select-none">
                    <div className="flex items-center gap-1.5">
                      <span className="w-2.5 h-2.5 rounded-full bg-danger inline-block" />
                      <span className="w-2.5 h-2.5 rounded-full bg-warn inline-block" />
                      <span className="w-2.5 h-2.5 rounded-full bg-success inline-block" />
                    </div>
                    <div className="flex-1 max-w-[220px] mx-auto h-5.5 rounded-md bg-surface-2 border border-line-2 px-2.5 flex items-center justify-center gap-1.5 text-2xs font-mono text-ink font-semibold truncate">
                      <Globe className="w-3 h-3 text-accent shrink-0" />
                      <span className="truncate">{cleanDomain(workspace.website_url) || 'yourwebsite.com'}</span>
                    </div>
                  </div>

                  {/* Simulated Website Hero Mockup (Crisp & High Contrast) */}
                  <div className="p-4 space-y-3.5 select-none overflow-hidden">
                    <div className="flex items-center justify-between pb-2 border-b-2 border-line-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-6 h-6 rounded-lg flex items-center justify-center text-2xs text-white font-semibold"
                          style={{ backgroundColor: brandColor }}
                        >
                          {(workspace.name || 'W').charAt(0)}
                        </div>
                        <span className="font-semibold text-ui text-ink">{workspace.name}</span>
                      </div>
                      <div className="flex gap-2.5 text-2xs text-ink-2 font-semibold">
                        <span className="text-ink font-bold border-b border-ink">Home</span>
                        <span>Catalog</span>
                        <span>Support</span>
                      </div>
                    </div>

                    <div className="p-4 rounded-md bg-surface border border-line space-y-2 mt-2">
                      <div className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-success/15 border border-success/30 text-2xs font-bold text-success">
                        <span className="w-1.5 h-1.5 rounded-full bg-success inline-block" />
                        <span>Support team available</span>
                      </div>
                      <div className="font-semibold text-sm text-ink leading-tight">Welcome to our Online Store</div>
                      <p className="text-xs text-ink-2 leading-relaxed font-normal">
                        Have a question about an order, shipment, or feature? Chat with our team in real-time.
                      </p>
                      <div className="pt-1 flex gap-2">
                        <div
                          className="px-3 py-1.5 rounded-lg text-2xs font-bold text-white cursor-default"
                          style={{ backgroundColor: brandColor }}
                        >
                          Explore Products
                        </div>
                        <div className="px-3 py-1.5 rounded-lg text-2xs font-bold bg-surface-2 border border-line-2 text-ink cursor-default">
                          Contact Sales
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* The messenger as the chosen design draws it */}
                  {previewOpen && (
                    <MessengerPreview
                      design={widgetDesign}
                      brand={brandColor}
                      secondary={secondaryColor}
                      mode={colorMode}
                      logoUrl={logoUrl}
                      name={workspace.name}
                      greetingTitle={greetingTitle}
                      greetingMessage={greetingMessage}
                      showHelpTab={showHelpTab}
                      helpTabLabel={helpTabLabel}
                      onClose={() => setPreviewOpen(false)}
                      className={cn(
                        'absolute z-20 animate-rise',
                        previewDevice === 'mobile'
                          ? 'inset-0 w-full h-full !rounded-none'
                          : widgetPosition === 'right'
                          ? 'right-3 bottom-[76px] w-[300px] h-[400px]'
                          : 'left-3 bottom-[76px] w-[300px] h-[400px]'
                      )}
                    />
                  )}

                  {/* The launcher */}
                  <div
                    className={cn(
                      'absolute bottom-3 z-10',
                      previewDevice === 'mobile' && previewOpen ? 'hidden' : 'block',
                      previewDevice === 'mobile' ? 'right-3' : widgetPosition === 'right' ? 'right-4' : 'left-4'
                    )}
                  >
                    <LauncherPreview
                      design={widgetDesign}
                      brand={brandColor}
                      secondary={secondaryColor}
                      icon={widgetIcon}
                      logoUrl={logoUrl}
                      open={previewOpen}
                      onClick={() => setPreviewOpen(!previewOpen)}
                      label={previewOpen ? 'Close widget preview' : 'Open widget preview'}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB: HELP CENTER BRANDING & LIVE PREVIEW */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'helpcenter' && (
          <div className="space-y-8 animate-rise">
          {/* Look and layout of the public help center, with a live preview. */}
          <HelpCenterDesigner
            workspace={workspace}
            onWorkspaceUpdated={(w) => {
              setWorkspace(w);
              onWorkspaceUpdated?.(w);
            }}
          />
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-start">
            {/* Left Column: Form Controls */}
            <div className="lg:col-span-7 space-y-6">
              {/* Card 1: Identity & Messaging */}
              <div className="card p-6 space-y-5">
                <div className="flex items-center justify-between border-b border-line pb-4">
                  <div>
                    <h3 className="text-md font-semibold text-ink">Help center identity</h3>
                    <p className="text-xs text-ink-3">
                      Customize your public knowledge base branding, titles, and messaging.
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <a
                      href={getWorkspaceHelpCenterUrl(workspace)}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-xs btn-secondary gap-1"
                    >
                      <ExternalLink className="w-3 h-3" />
                      <span>Live site</span>
                    </a>
                    <button
                      onClick={handleSaveHelpCenter}
                      disabled={!isHelpCenterDirty || savingHelpCenter}
                      className="btn btn-sm btn-primary gap-1.5 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      {savingHelpCenter ? 'Saving…' : 'Save changes'}
                    </button>
                  </div>
                </div>

                {/* Help Center Title */}
                <div>
                  <label className="field-label">Help center title</label>
                  <input
                    type="text"
                    value={helpCenterTitle}
                    onChange={(e) => setHelpCenterTitle(e.target.value)}
                    placeholder={`${workspace.name} Help Center`}
                    className="input"
                  />
                  <p className="text-xs text-ink-3 mt-1">
                    Appears in the header navigation, browser tab, and search engine previews.
                  </p>
                </div>

                {/* Help Center Subtitle / Tagline */}
                <div>
                  <label className="field-label">Hero Search Subtitle / Tagline</label>
                  <textarea
                    rows={2}
                    value={helpCenterSubtitle}
                    onChange={(e) => setHelpCenterSubtitle(e.target.value)}
                    placeholder="Search our guides, troubleshooting steps, and documentation for instant answers."
                    className="input resize-none"
                  />
                  <p className="text-xs text-ink-3 mt-1">
                    Displayed prominently below the main heading in the hero search area.
                  </p>
                </div>

                {/* Custom Logo */}
                <div>
                  <label className="field-label">Help center logo</label>
                  <div className="flex items-start gap-4">
                    <div className="w-14 h-14 rounded-2xl border border-line bg-surface-2 flex items-center justify-center overflow-hidden shrink-0">
                      {helpCenterLogoUrl || logoUrl ? (
                        <img
                          src={helpCenterLogoUrl || logoUrl}
                          alt="Logo"
                          className="w-full h-full object-contain p-1"
                        />
                      ) : (
                        <div
                          className="w-full h-full flex items-center justify-center text-white font-bold text-base"
                          style={{ backgroundColor: brandColor }}
                        >
                          {workspace.name.slice(0, 1).toUpperCase()}
                        </div>
                      )}
                    </div>
                    <div className="space-y-2 flex-1">
                      <div className="flex items-center gap-2">
                        <label className="btn btn-xs btn-secondary cursor-pointer inline-flex items-center gap-1.5">
                          <Upload className="w-3.5 h-3.5" />
                          <span>Upload logo</span>
                          <input
                            type="file"
                            accept="image/*"
                            onChange={handleHelpCenterLogoUpload}
                            className="hidden"
                          />
                        </label>
                        {logoUrl && (
                          <button
                            type="button"
                            onClick={() => setHelpCenterLogoUrl(logoUrl)}
                            className="btn btn-xs btn-ghost text-ink-3 hover:text-ink text-2xs"
                          >
                            Use main workspace logo
                          </button>
                        )}
                        {helpCenterLogoUrl && (
                          <button
                            type="button"
                            onClick={() => setHelpCenterLogoUrl('')}
                            className="btn btn-xs btn-ghost text-danger hover:text-danger text-2xs"
                          >
                            Reset
                          </button>
                        )}
                      </div>
                      <input
                        type="url"
                        placeholder="Or enter image URL: https://example.com/logo.png"
                        value={helpCenterLogoUrl}
                        onChange={(e) => setHelpCenterLogoUrl(e.target.value)}
                        className="input text-xs"
                      />
                    </div>
                  </div>
                </div>

                {/* Collections Layout Variation (Intercom-style) */}
                <div>
                  <label className="field-label">Default Section Layout (Intercom Style)</label>
                  <p className="text-xs text-ink-3 mb-2.5">
                    Choose how collections and sections are displayed on your public Help Center.
                  </p>
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                    {[
                      {
                        id: 'list',
                        label: 'Row-wise',
                        desc: 'Full-width stacked rows (1 per row)',
                        icon: Rows3,
                      },
                      {
                        id: 'grid-2',
                        label: '2 Columns',
                        desc: 'Spacious 2 in a line cards',
                        icon: LayoutGrid,
                      },
                      {
                        id: 'grid-3',
                        label: '3 Columns',
                        desc: 'Classic 3 in a line grid',
                        icon: Grid3X3,
                      },
                      {
                        id: 'grid-4',
                        label: '4 Columns',
                        desc: 'Compact 4 in a line grid',
                        icon: Columns4,
                      },
                    ].map((opt) => {
                      const Icon = opt.icon;
                      const active = helpCenterLayout === opt.id;
                      return (
                        <button
                          key={opt.id}
                          type="button"
                          onClick={() => setHelpCenterLayout(opt.id as any)}
                          className={`p-3 rounded-xl border text-left transition-all cursor-pointer ${
                            active
                              ? 'border-accent bg-accent/5 ring-2 ring-accent/20'
                              : 'border-line bg-surface hover:border-ink-3/30'
                          }`}
                        >
                          <div className="flex items-center gap-2 mb-1.5">
                            <div
                              className={`w-7 h-7 rounded-lg grid place-items-center ${
                                active
                                  ? 'bg-accent text-white'
                                  : 'bg-surface-2 text-ink-2'
                              }`}
                            >
                              <Icon className="w-4 h-4" />
                            </div>
                            <span className="text-xs font-semibold text-ink">
                              {opt.label}
                            </span>
                          </div>
                          <p className="text-2xs text-ink-3 leading-tight">
                            {opt.desc}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Custom Footer Text */}
                <div>
                  <label className="field-label">Custom Footer Text / Copyright</label>
                  <input
                    type="text"
                    value={helpCenterFooterText}
                    onChange={(e) => setHelpCenterFooterText(e.target.value)}
                    placeholder={`© ${new Date().getFullYear()} ${workspace.name}. Powered by Zen-try.`}
                    className="input"
                  />
                  <p className="text-xs text-ink-3 mt-1">
                    Displayed at the bottom of every Help Center page and article.
                  </p>
                </div>
              </div>

              {/* Card 2: Header Navigation Links */}
              <div className="card p-6 space-y-5">
                <div className="border-b border-line pb-4">
                  <h3 className="text-md font-semibold text-ink">Header navigation links</h3>
                  <p className="text-xs text-ink-3">
                    Add custom links in the Help Center navigation bar (e.g. to your main website, API docs, or status page).
                  </p>
                </div>

                {/* Current Links List */}
                <div className="space-y-2">
                  {helpCenterHeaderLinks.length === 0 ? (
                    <div className="p-4 rounded-xl border border-dashed border-line text-center text-xs text-ink-3">
                      No custom header links added yet. Use the form below to add navigation links.
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {helpCenterHeaderLinks.map((link, idx) => (
                        <div
                          key={idx}
                          className="flex items-center justify-between p-3 rounded-xl border border-line bg-surface-2/60 text-ui"
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <LinkIcon className="w-3.5 h-3.5 text-ink-3 shrink-0" />
                            <span className="font-semibold text-ink truncate">{link.label}</span>
                            <span className="text-ink-3 text-xs truncate font-mono">
                              ({link.url})
                            </span>
                            <span className="text-2xs px-1.5 py-0.5 rounded bg-surface border border-line text-ink-3 font-mono">
                              {link.target === '_self' ? 'Same tab' : 'New tab'}
                            </span>
                          </div>
                          <button
                            type="button"
                            onClick={() => handleRemoveHeaderLink(idx)}
                            className="text-ink-3 hover:text-danger p-1 transition-colors"
                            title="Remove Link"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                {/* Add Link Form */}
                <div className="pt-2 border-t border-line/60 space-y-3">
                  <h4 className="text-ui font-semibold text-ink">Add navigation link</h4>
                  <div className="grid grid-cols-1 sm:grid-cols-12 gap-2.5 items-end">
                    <div className="sm:col-span-4 space-y-1">
                      <label className="text-2xs font-medium text-ink-3">Link label</label>
                      <input
                        type="text"
                        value={newLinkLabel}
                        onChange={(e) => setNewLinkLabel(e.target.value)}
                        placeholder="e.g. Main Website"
                        className="input text-xs"
                      />
                    </div>
                    <div className="sm:col-span-5 space-y-1">
                      <label className="text-2xs font-medium text-ink-3">URL</label>
                      <input
                        type="url"
                        value={newLinkUrl}
                        onChange={(e) => setNewLinkUrl(e.target.value)}
                        placeholder="https://mycompany.com"
                        className="input text-xs font-mono"
                      />
                    </div>
                    <div className="sm:col-span-3">
                      <button
                        type="button"
                        onClick={handleAddHeaderLink}
                        disabled={!newLinkLabel.trim() || !newLinkUrl.trim()}
                        className="btn btn-sm btn-secondary w-full gap-1 text-xs"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Add link</span>
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Right Column: Live Interactive Preview */}
            <div className="lg:col-span-5 sticky top-32 space-y-3">
              <div className="flex items-center justify-between px-1">
                <span className="text-xs font-semibold text-ink uppercase tracking-wider">
                  Live preview
                </span>
                <span className="text-2xs font-medium px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">
                  Updates in Real Time
                </span>
              </div>

              {/* Mock Browser Container */}
              <div className="card overflow-hidden text-xs">
                {/* Browser Top Bar */}
                <div className="px-3 py-2 bg-surface-2 border-b border-line flex items-center gap-2">
                  <div className="flex items-center gap-1.5">
                    <div className="w-2.5 h-2.5 rounded-full bg-danger" />
                    <div className="w-2.5 h-2.5 rounded-full bg-warn" />
                    <div className="w-2.5 h-2.5 rounded-full bg-success" />
                  </div>
                  <div className="flex-1 px-2 py-0.5 rounded bg-surface border border-line text-2xs font-mono text-ink-3 truncate text-center">
                    {getWorkspaceHelpCenterUrl(workspace)}
                  </div>
                </div>

                {/* Help Center Navigation Bar */}
                <div className="px-4 py-3 border-b border-line bg-surface flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    {helpCenterLogoUrl || logoUrl ? (
                      <img
                        src={helpCenterLogoUrl || logoUrl}
                        alt="Logo"
                        className="w-6 h-6 rounded-lg object-contain bg-surface-2 p-0.5 border border-line shrink-0"
                      />
                    ) : (
                      <div
                        className="w-6 h-6 rounded-lg flex items-center justify-center text-white font-bold text-2xs shadow-xs shrink-0"
                        style={{ backgroundColor: brandColor }}
                      >
                        {workspace.name.slice(0, 1).toUpperCase()}
                      </div>
                    )}
                    <div className="min-w-0">
                      <span className="text-xs font-bold text-ink truncate block">
                        {helpCenterTitle || workspace.name}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {helpCenterHeaderLinks.slice(0, 2).map((l, i) => (
                      <span key={i} className="text-2xs text-ink-3 font-medium truncate max-w-[80px]">
                        {l.label}
                      </span>
                    ))}
                    <span
                      className="px-2 py-1 rounded-md text-white text-2xs font-semibold"
                      style={{ backgroundColor: brandColor }}
                    >
                      Ask support
                    </span>
                  </div>
                </div>

                {/* Help Center Hero Section */}
                <div
                  className="px-5 py-8 text-center relative overflow-hidden"
                  style={{
                    background: `radial-gradient(ellipse 90% 60% at 50% -20%, ${brandColor}25, transparent 80%)`,
                  }}
                >
                  <h4 className="text-base font-semibold text-ink tracking-tight">
                    Advice and answers from the {helpCenterTitle || workspace.name} Team
                  </h4>
                  <p className="text-xs text-ink-2 mt-1.5 max-w-xs mx-auto leading-relaxed">
                    {helpCenterSubtitle ||
                      'Search our guides, troubleshooting steps, and documentation for instant answers.'}
                  </p>

                  <div className="mt-4 max-w-xs mx-auto">
                    <div className="h-8 rounded-xl border border-line bg-surface text-ink-3 text-2xs flex items-center px-3 gap-2 shadow-xs">
                      <span>🔍</span>
                      <span>Search for articles, features...</span>
                    </div>
                  </div>
                </div>

                {/* Mock Sample Collections Grid */}
                <div className="p-4 bg-surface-2/40 border-t border-line space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 rounded-xl border border-line bg-surface space-y-1">
                      <div className="text-sm">📚</div>
                      <div className="text-2xs font-bold text-ink truncate">Getting started</div>
                      <div className="text-2xs text-ink-3">3 articles</div>
                    </div>
                    <div className="p-2.5 rounded-xl border border-line bg-surface space-y-1">
                      <div className="text-sm">💳</div>
                      <div className="text-2xs font-bold text-ink truncate">Account & Billing</div>
                      <div className="text-2xs text-ink-3">2 articles</div>
                    </div>
                  </div>
                </div>

                {/* Mock Footer */}
                <div className="px-4 py-2.5 bg-surface border-t border-line text-center text-2xs text-ink-3">
                  {helpCenterFooterText || `© ${new Date().getFullYear()} ${workspace.name}. Powered by Zen-try.`}
                </div>
              </div>
            </div>
          </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 2: BUSINESS HOURS */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'hours' && (
          <div className="space-y-6 animate-rise">
            <div className="card p-6 space-y-6">
              <div className="flex items-start justify-between border-b border-line pb-4">
                <div>
                  <h3 className="text-base font-semibold text-ink">Operational business hours</h3>
                  <p className="text-xs text-ink-3 mt-0.5">
                    Define when your support agents are active. Outside these hours, the chat widget automatically displays an "Offline" message and prompts visitors to leave their email.
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={copyMondayToWeekdays}
                    className="btn btn-sm btn-secondary text-xs"
                  >
                    Copy Mon &rarr; Fri
                  </button>
                  <button
                    onClick={handleSaveBusinessHours}
                    disabled={!isHoursDirty || saving}
                    className="btn btn-sm btn-primary gap-1.5 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving…' : 'Save schedule'}
                  </button>
                </div>
              </div>

              {/* Master Toggle */}
              <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2 border border-line">
                <div className="space-y-0.5">
                  <div className="text-ui font-semibold text-ink">Enforce business hours</div>
                  <div className="text-xs text-ink-3">
                    Automatically switch widget status to Offline outside the scheduled times.
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={businessHours.enabled}
                    onChange={(e) =>
                      setBusinessHours({ ...businessHours, enabled: e.target.checked })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-line-2 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent" />
                </label>
              </div>

              {/* Timezone Selector with Full IANA Search */}
              <div className="space-y-1.5 max-w-md">
                <label className="field-label mb-0">Workspace Timezone (Full IANA List)</label>
                <div className="relative">
                  <div
                    onClick={() => setTzDropdownOpen(!tzDropdownOpen)}
                    className="input flex items-center justify-between cursor-pointer text-xs font-mono select-none"
                  >
                    <span className="truncate">{businessHours.timezone || 'UTC'}</span>
                    <ChevronDown className={cn("w-4 h-4 text-ink-3 transition-transform", tzDropdownOpen && "rotate-180")} />
                  </div>

                  {tzDropdownOpen && (
                    <div className="popover absolute left-0 top-full mt-1.5 w-full z-30 p-2 space-y-2 animate-fade">
                      <div className="relative">
                        <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
                        <input
                          type="text"
                          autoFocus
                          placeholder="Search IANA timezone (e.g. New York, Karachi, London, Tokyo)…"
                          value={tzSearch}
                          onChange={(e) => setTzSearch(e.target.value)}
                          className="input pl-8 py-1.5 text-xs w-full font-sans"
                          onClick={(e) => e.stopPropagation()}
                        />
                      </div>
                      <div className="max-h-56 overflow-y-auto divide-y divide-line/40 text-xs font-mono">
                        {filteredTimezones.length === 0 ? (
                          <div className="p-3 text-center text-ink-3 font-sans">No matching timezone found</div>
                        ) : (
                          filteredTimezones.map((tz) => {
                            const isSelected = businessHours.timezone === tz;
                            return (
                              <button
                                key={tz}
                                type="button"
                                onClick={() => {
                                  setBusinessHours({ ...businessHours, timezone: tz });
                                  setTzDropdownOpen(false);
                                  setTzSearch('');
                                }}
                                className={cn(
                                  "w-full text-left px-2.5 py-1.5 rounded-lg flex items-center justify-between hover:bg-surface-2 transition-colors",
                                  isSelected ? "bg-accent/10 text-accent font-semibold" : "text-ink"
                                )}
                              >
                                <span>{tz.replace(/_/g, ' ')}</span>
                                {isSelected && <Check className="w-3.5 h-3.5 text-accent" />}
                              </button>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <p className="text-2xs text-ink-3">
                  All active business hour evaluations run against this local timezone.
                </p>
              </div>

              {/* 7 Days Schedule Table */}
              <div className="divide-y divide-line border border-line rounded-xl overflow-hidden">
                {(
                  [
                    ['monday', 'Monday'],
                    ['tuesday', 'Tuesday'],
                    ['wednesday', 'Wednesday'],
                    ['thursday', 'Thursday'],
                    ['friday', 'Friday'],
                    ['saturday', 'Saturday'],
                    ['sunday', 'Sunday'],
                  ] as const
                ).map(([dayKey, dayLabel]) => {
                  const schedule = businessHours.schedule[dayKey];
                  return (
                    <div
                      key={dayKey}
                      className={`p-3.5 px-5 flex items-center justify-between transition-colors ${
                        schedule.enabled ? 'bg-surface' : 'bg-surface-2 opacity-60'
                      }`}
                    >
                      <div className="flex items-center gap-3 w-36">
                        <input
                          type="checkbox"
                          checked={schedule.enabled}
                          onChange={(e) =>
                            updateDaySchedule(dayKey, 'enabled', e.target.checked)
                          }
                          className="w-4 h-4 accent-accent rounded cursor-pointer"
                        />
                        <span className="text-ui font-medium text-ink">{dayLabel}</span>
                      </div>

                      {schedule.enabled ? (
                        <div className="flex items-center gap-2">
                          <input
                            type="time"
                            value={schedule.start}
                            onChange={(e) =>
                              updateDaySchedule(dayKey, 'start', e.target.value)
                            }
                            className="input w-28 text-center text-xs font-mono py-1"
                          />
                          <span className="text-ink-3 text-xs">to</span>
                          <input
                            type="time"
                            value={schedule.end}
                            onChange={(e) =>
                              updateDaySchedule(dayKey, 'end', e.target.value)
                            }
                            className="input w-28 text-center text-xs font-mono py-1"
                          />
                        </div>
                      ) : (
                        <span className="text-xs font-medium text-ink-3 italic">
                          Closed / Offline All Day
                        </span>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'canned' && (
          <div className="space-y-6 animate-rise">
            <div className="card p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-line pb-4">
                <div>
                  <h3 className="text-base font-semibold text-ink">Canned Responses & Shortcuts</h3>
                  <p className="text-xs text-ink-3 mt-0.5">
                    Create reusable canned messages. Agents can type <code className="font-mono text-accent">/shortcut</code> in any active chat thread to quickly paste them.
                  </p>
                </div>
                <button
                  onClick={openCreateCanned}
                  className="btn btn-sm btn-primary gap-1.5 shadow-xs"
                >
                  <Plus className="w-4 h-4" />
                  <span>New canned reply</span>
                </button>
              </div>

              {/* Search & Filter Strip */}
              <div className="flex items-center justify-between gap-4">
                <input
                  type="text"
                  placeholder="Search shortcuts or replies…"
                  value={cannedSearch}
                  onChange={(e) => setCannedSearch(e.target.value)}
                  className="input max-w-xs text-xs"
                />

                <div className="flex items-center gap-1 bg-surface-2 p-1 rounded-xl border border-line text-xs font-medium">
                  {(['all', 'team', 'agent'] as const).map((filter) => (
                    <button
                      key={filter}
                      onClick={() => setCannedFilter(filter)}
                      className={`px-3 py-1 rounded-lg capitalize transition-colors ${
                        cannedFilter === filter
                          ? 'bg-surface text-ink shadow-xs font-semibold'
                          : 'text-ink-3 hover:text-ink'
                      }`}
                    >
                      {filter === 'agent' ? 'Personal' : filter}
                    </button>
                  ))}
                </div>
              </div>

              {/* Canned Responses Table */}
              <div className="border border-line rounded-xl overflow-hidden divide-y divide-line">
                {filteredCanned.length === 0 ? (
                  <div className="p-8 text-center text-ink-3 text-xs">
                    No canned replies found matching your search.
                  </div>
                ) : (
                  filteredCanned.map((canned) => {
                    const isTeam = canned.agent_id === null;
                    return (
                      <div
                        key={canned.id}
                        className="p-4 px-6 flex items-start justify-between gap-4 hover:bg-surface-2/40 transition-colors"
                      >
                        <div className="space-y-1 max-w-xl">
                          <div className="flex items-center gap-2.5">
                            <span className="font-mono font-bold text-accent text-xs px-2 py-0.5 rounded bg-accent/10">
                              {canned.shortcut}
                            </span>
                            <span className="font-semibold text-ui text-ink">
                              {canned.title}
                            </span>
                            <span
                              className={`text-2xs px-2 py-0.5 rounded-full font-semibold ${
                                isTeam
                                  ? 'bg-accent/10 text-accent'
                                  : 'bg-warn/10 text-warn'
                              }`}
                            >
                              {isTeam ? 'Team-Wide' : 'Personal'}
                            </span>
                          </div>
                          <p className="text-xs text-ink-3 line-clamp-2 leading-relaxed">
                            {canned.content}
                          </p>
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={() => openEditCanned(canned)}
                            title="Edit shortcut"
                            className="p-1.5 rounded-lg text-ink-3 hover:text-ink hover:bg-surface-2"
                          >
                            <Edit2 className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeleteCanned(canned.id, canned.shortcut)}
                            title="Delete shortcut"
                            className="p-1.5 rounded-lg text-ink-3 hover:text-danger hover:bg-danger-soft"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {/* Create/Edit Modal */}
            {cannedModalOpen && (
              <div className="fixed inset-0 bg-overlay flex items-center justify-center p-4 z-50 animate-fade">
                <div className="card max-w-lg w-full p-6 space-y-5 animate-pop shadow-xl rounded-2xl">
                  <div className="flex items-center justify-between border-b border-line pb-3">
                    <h3 className="text-base font-semibold text-ink">
                      {editingCannedId ? 'Edit canned response' : 'New canned response'}
                    </h3>
                    <button
                      onClick={() => setCannedModalOpen(false)}
                      className="text-ink-3 hover:text-ink"
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>

                  <form onSubmit={handleSaveCanned} className="space-y-4">
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <label className="field-label">Shortcut</label>
                        <input
                          type="text"
                          required
                          value={cannedShortcut}
                          onChange={(e) => setCannedShortcut(e.target.value)}
                          placeholder="/pricing"
                          className="input font-mono text-sm"
                        />
                      </div>
                      <div>
                        <label className="field-label">Scope</label>
                        <select
                          value={cannedScope}
                          onChange={(e) => setCannedScope(e.target.value as any)}
                          className="input font-medium"
                        >
                          <option value="team">Team-Wide (All Agents)</option>
                          <option value="agent">Personal (Only You)</option>
                        </select>
                      </div>
                    </div>

                    <div>
                      <label className="field-label">Internal title</label>
                      <input
                        type="text"
                        required
                        value={cannedTitle}
                        onChange={(e) => setCannedTitle(e.target.value)}
                        placeholder="Pricing plan details"
                        className="input"
                      />
                    </div>

                    <div>
                      <label className="field-label">Message content</label>
                      <textarea
                        rows={4}
                        required
                        value={cannedContent}
                        onChange={(e) => setCannedContent(e.target.value)}
                        placeholder="Our standard plan starts at $29/mo and includes unlimited chat history..."
                        className="input resize-none"
                      />
                    </div>

                    <div className="flex justify-end gap-2 pt-2">
                      <button
                        type="button"
                        onClick={() => setCannedModalOpen(false)}
                        className="btn btn-sm btn-ghost"
                      >
                        Cancel
                      </button>
                      <button type="submit" className="btn btn-sm btn-primary">
                        {editingCannedId ? 'Save changes' : 'Create shortcut'}
                      </button>
                    </div>
                  </form>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 5: AUTO-ASSIGNMENT RULES */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'assignment' && (
          <div className="space-y-6 animate-rise">
            <div className="card p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-line pb-4">
                <div>
                  <h3 className="text-base font-semibold text-ink">
                    Round-Robin Auto-Assignment rules
                  </h3>
                  <p className="text-xs text-ink-3 mt-0.5">
                    Automatically balance incoming customer conversations among online team members.
                  </p>
                </div>
                <button
                  onClick={handleSaveAutoAssign}
                  disabled={!isAutoAssignDirty || saving}
                  className="btn btn-sm btn-primary gap-1.5 shadow-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? 'Saving…' : 'Save rules'}
                </button>
              </div>

              {/* Master Round-Robin Toggle */}
              <div className="flex items-center justify-between p-4 rounded-xl bg-surface-2 border border-line">
                <div className="space-y-0.5">
                  <div className="text-ui font-semibold text-ink">
                    Enable Round-Robin distribution
                  </div>
                  <div className="text-xs text-ink-3">
                    New unassigned conversations are assigned to the online agent with the lowest open ticket count.
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={autoAssign.enabled}
                    onChange={(e) =>
                      setAutoAssign({ ...autoAssign, enabled: e.target.checked })
                    }
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-line-2 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent" />
                </label>
              </div>

              {/* Max Active Conversations Cap */}
              <div className="space-y-2">
                <label className="field-label">Max active conversations per agent</label>
                <div className="flex items-center gap-3">
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={autoAssign.max_conversations_per_agent}
                    onChange={(e) =>
                      setAutoAssign({
                        ...autoAssign,
                        max_conversations_per_agent: parseInt(e.target.value) || 5,
                      })
                    }
                    className="input w-32 text-sm font-semibold"
                  />
                  <span className="text-xs text-ink-3">
                    Limits concurrent open chats to prevent agent overload. Additional tickets stay in the Unassigned queue.
                  </span>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 7: AI ASSISTANT & KNOWLEDGE BASE AGENT */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'ai' && (
          <div className="space-y-6 animate-rise">
            <div className="card p-6 space-y-6">
              <div className="flex items-center justify-between border-b border-line pb-4">
                <div>
                  <h3 className="text-base font-semibold text-ink flex items-center gap-2">
                    <Sparkles className="w-5 h-5 text-accent" />
                    AI assistant & knowledge base agent
                  </h3>
                  <p className="text-xs text-ink-3 mt-0.5">
                    Unified AI support assistant and autonomous knowledge base agent across website live chat and omnichannel integrations.
                  </p>
                </div>
              </div>

              {/* Master Switch */}
              <div className="flex items-center justify-between p-4 rounded-xl border border-line bg-surface-2">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center">
                    <Bot className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="text-sm font-semibold text-ink flex items-center gap-2">
                      Master AI agent
                      {aiSettings.enabled ? (
                        <span className="text-2xs px-2 py-0.5 rounded-full bg-success-soft text-success font-bold">
                          ACTIVE
                        </span>
                      ) : (
                        <span className="text-2xs px-2 py-0.5 rounded-full bg-surface-3 text-ink-3 font-medium">
                          DISABLED
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-ink-3">
                      Master toggle for this workspace. Formulates responses directly from your published help desk articles and notes.
                    </p>
                  </div>
                </div>
                <label className="relative inline-flex items-center cursor-pointer">
                  <input
                    type="checkbox"
                    checked={aiSettings.enabled}
                    onChange={(e) => setAiSettings({ ...aiSettings, enabled: e.target.checked })}
                    className="sr-only peer"
                  />
                  <div className="w-11 h-6 bg-surface-3 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>

              {/* System Prompt */}
              <div className="card p-5 space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <h4 className="text-ui font-semibold text-ink">System prompt & agent persona</h4>
                    <p className="text-xs text-ink-3">
                      Defines who the assistant is, its tone, and response constraints. Facts are always anchored in your published articles.
                    </p>
                  </div>
                  <span className="text-2xs text-ink-3 font-mono shrink-0">
                    {(aiSettings.system_prompt || '').length.toLocaleString()} chars
                  </span>
                </div>
                <textarea
                  value={aiSettings.system_prompt || ''}
                  onChange={(e) => setAiSettings({ ...aiSettings, system_prompt: e.target.value })}
                  rows={8}
                  placeholder="You are the support assistant for… Answer only from the knowledge base…"
                  className="w-full px-3 py-2.5 rounded-xl border border-line bg-surface-2 text-xs leading-relaxed font-mono text-ink resize-y focus:outline-none focus:ring-1 focus:ring-accent"
                />
                <p className="text-2xs text-ink-3">
                  Leave empty to use the built-in default. Applies to web widget, WhatsApp, Messenger, Instagram, and LinkedIn.
                </p>
              </div>

              {/* Answer mode */}
              <div className="card p-5 space-y-3">
                <div>
                  <h4 className="text-ui font-semibold text-ink">How the assistant answers</h4>
                  <p className="text-xs text-ink-3">
                    Agent mode reads your whole published help center on every question and hands over only when a person has to act.
                  </p>
                </div>
                <div role="radiogroup" aria-label="Answer mode" className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  {([
                    {
                      value: 'agent',
                      title: 'Agent (recommended)',
                      body: 'Understands short, misspelt and Roman Urdu questions, combines rules from several articles, asks a clarifying question when needed.',
                    },
                    {
                      value: 'strict',
                      title: 'Strict',
                      body: 'Answers only from the few passages search finds; anything uncertain goes straight to your team.',
                    },
                  ] as const).map((opt) => {
                    const selected = (aiSettings.answer_mode === 'strict' ? 'strict' : 'agent') === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setAiSettings({ ...aiSettings, answer_mode: opt.value })}
                        className={cn(
                          'text-left p-3 rounded-xl border transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-accent',
                          selected ? 'border-accent bg-accent/5' : 'border-line bg-surface-2 hover:border-line-2'
                        )}
                      >
                        <span className="block text-xs font-semibold text-ink">{opt.title}</span>
                        <span className="block text-2xs text-ink-3 mt-1 leading-relaxed">{opt.body}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Automation Modes */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {/* 1. Auto First-Reply with Delay */}
                <div className="card p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-warn/10 text-warn flex items-center justify-center">
                        <Zap className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-ui font-semibold text-ink">Auto first reply</h4>
                        <p className="text-xs text-ink-3">Answers incoming questions if no agent claims the chat</p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiSettings.auto_response_enabled}
                        onChange={(e) => setAiSettings({ ...aiSettings, auto_response_enabled: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-surface-3 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-line">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-ink-2 font-medium">Auto-reply delay (seconds unassigned):</span>
                      <span className="font-bold text-accent px-2 py-0.5 rounded bg-surface-2 border border-line">
                        {aiSettings.auto_response_delay_seconds}s
                      </span>
                    </div>
                    <input
                      type="range"
                      min={5}
                      max={60}
                      step={5}
                      value={aiSettings.auto_response_delay_seconds}
                      onChange={(e) =>
                        setAiSettings({
                          ...aiSettings,
                          auto_response_delay_seconds: parseInt(e.target.value, 10),
                        })
                      }
                      className="w-full accent-accent cursor-pointer"
                    />
                    <p className="text-2xs text-ink-3">
                      Waits this many seconds before consulting knowledge base articles to draft and send the first answer.
                    </p>
                  </div>
                </div>

                {/* 2. Full Autopilot */}
                <div className="card p-5 space-y-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-accent/10 text-accent flex items-center justify-center">
                        <Sparkles className="w-4 h-4" />
                      </div>
                      <div>
                        <h4 className="text-ui font-semibold text-ink">Full autopilot</h4>
                        <p className="text-xs text-ink-3">Continuously answers follow-up visitor messages</p>
                      </div>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiSettings.auto_pilot ?? false}
                        onChange={(e) => setAiSettings({ ...aiSettings, auto_pilot: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-9 h-5 bg-surface-3 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>

                  <div className="space-y-2 pt-2 border-t border-line text-xs">
                    <p className="text-xs text-ink-2 leading-relaxed">
                      Operates the AI as an autonomous knowledge agent throughout conversation lifecycles. Automatically yields back to human agents when escalated or claimed.
                    </p>
                  </div>
                </div>
              </div>

              {/* Agent Copilot Enhancements */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-1">
                {/* Suggested Replies */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <MessageSquare className="w-4 h-4 text-accent" />
                      <span className="text-ui font-semibold text-ink">Suggested replies</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiSettings.suggested_replies_enabled}
                        onChange={(e) => setAiSettings({ ...aiSettings, suggested_replies_enabled: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4 bg-surface-3 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>
                  <p className="text-2xs text-ink-3">Clickable pills above composer for agents.</p>
                </div>

                {/* Auto-Tagging */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Check className="w-4 h-4 text-success" />
                      <span className="text-ui font-semibold text-ink">Auto-Tagging</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiSettings.auto_tagging_enabled}
                        onChange={(e) => setAiSettings({ ...aiSettings, auto_tagging_enabled: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4 bg-surface-3 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>
                  <p className="text-2xs text-ink-3">Categorizes threads by intent (#Billing, #Bug).</p>
                </div>

                {/* Sentiment & Summary */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Sparkles className="w-4 h-4 text-accent" />
                      <span className="text-ui font-semibold text-ink">Sentiment & Summary</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={aiSettings.sentiment_enabled}
                        onChange={(e) => setAiSettings({ ...aiSettings, sentiment_enabled: e.target.checked, summary_enabled: e.target.checked })}
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4 bg-surface-3 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>
                  <p className="text-2xs text-ink-3">Mood flags and quick summaries on long threads.</p>
                </div>

                {/* Require Admin Approval for New Answers */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Lock className="w-4 h-4 text-accent" />
                      <span className="text-ui font-semibold text-ink">Require admin approval</span>
                    </div>
                    <label className="relative inline-flex items-center cursor-pointer">
                      <input
                        type="checkbox"
                        checked={Boolean(aiSettings.require_approval_for_new_answers)}
                        onChange={(e) =>
                          setAiSettings({ ...aiSettings, require_approval_for_new_answers: e.target.checked })
                        }
                        className="sr-only peer"
                      />
                      <div className="w-8 h-4 bg-surface-3 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[1px] after:left-[1px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-3.5 after:w-3.5 after:transition-all peer-checked:bg-accent"></div>
                    </label>
                  </div>
                  <p className="text-2xs text-ink-3">
                    Answers created by team members stay pending until approved by an admin before training the bot.
                  </p>
                </div>
              </div>

              {/* Platform AI Access & Usage (Read-Only Workspace Card) */}
              <div className="card p-5 space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 pb-3 border-b border-line">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-accent/10 text-accent flex items-center justify-center shrink-0">
                      <Zap className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h4 className="text-sm font-semibold text-ink">AI is included in your plan</h4>
                        {aiPlanUsage?.planName && (
                          <span className="text-2xs font-semibold px-2 py-0.5 rounded-full bg-accent/10 text-accent uppercase tracking-wider">
                            {aiPlanUsage.planName}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-ink-3">
                        Model infrastructure and API keys are securely managed at the platform level.
                      </p>
                    </div>
                  </div>

                  {aiPlanUsage && (!aiPlanUsage.aiEnabled || (aiPlanUsage.monthlyLimit !== null && aiPlanUsage.repliesUsed >= aiPlanUsage.monthlyLimit)) && (
                    <a
                      href="?tab=billing"
                      className="btn btn-sm btn-primary gap-1.5 self-start sm:self-auto shrink-0 text-xs shadow-xs"
                    >
                      <span>Upgrade plan</span>
                      <ExternalLink className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>

                {loadingAiUsage ? (
                  <div className="py-4 flex items-center gap-2 text-xs text-ink-3">
                    <RefreshCw className="w-4 h-4 animate-spin text-accent" />
                    <span>Loading AI plan details & quota usage…</span>
                  </div>
                ) : aiPlanUsage ? (
                  <div className="space-y-4">
                    {!aiPlanUsage.aiEnabled ? (
                      <div className="p-3.5 rounded-xl border border-warn-line bg-warn-soft flex items-start gap-3 text-xs text-warn">
                        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                        <div className="flex-1">
                          <p className="font-semibold text-ink">AI Disabled on Current Plan</p>
                          <p className="text-ink-3 mt-0.5">
                            AI assistant capabilities are inactive for the {aiPlanUsage.planName} plan. Upgrade to a plan with AI access to activate autonomous bot replies.
                          </p>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <div className="flex items-center justify-between text-xs">
                            <span className="font-medium text-ink">Monthly AI replies</span>
                            <span className="text-ink-2 font-mono">
                              {aiPlanUsage.repliesUsed.toLocaleString()} / {aiPlanUsage.monthlyLimit === null ? '∞ Unlimited' : aiPlanUsage.monthlyLimit.toLocaleString()}
                            </span>
                          </div>

                          {aiPlanUsage.monthlyLimit !== null ? (
                            <div className="w-full h-2.5 bg-surface-2 rounded-full overflow-hidden border border-line">
                              <div
                                className={cn(
                                  'h-full transition-all duration-300 rounded-full',
                                  aiPlanUsage.percentUsed >= 100
                                    ? 'bg-danger'
                                    : aiPlanUsage.percentUsed >= 80
                                    ? 'bg-warn'
                                    : 'bg-accent'
                                )}
                                style={{ width: `${Math.min(100, Math.max(2, aiPlanUsage.percentUsed))}%` }}
                              />
                            </div>
                          ) : (
                            <div className="text-2xs text-ink-3 flex items-center gap-1.5">
                              <CheckCircle2 className="w-3.5 h-3.5 text-success" />
                              <span>Unlimited autonomous replies included under your enterprise subscription.</span>
                            </div>
                          )}

                          {aiPlanUsage.monthlyLimit !== null && (
                            <div className="flex items-center justify-between text-2xs text-ink-3">
                              <span>
                                {aiPlanUsage.percentUsed >= 100
                                  ? 'Monthly reply limit reached.'
                                  : `${Math.max(0, aiPlanUsage.monthlyLimit - aiPlanUsage.repliesUsed).toLocaleString()} replies remaining this month`}
                              </span>
                              <span>Period resets monthly</span>
                            </div>
                          )}
                        </div>

                        {aiPlanUsage.monthlyLimit !== null && aiPlanUsage.repliesUsed >= aiPlanUsage.monthlyLimit && (
                          <div className="p-3.5 rounded-xl border border-danger-line bg-danger-soft flex items-start gap-3 text-xs text-danger">
                            <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                            <div className="flex-1">
                              <p className="font-semibold text-danger">Monthly limit reached</p>
                              <p className="text-danger/90 mt-0.5">
                                Your workspace has reached its AI reply quota for this month. Inbound conversations will automatically route to human agents until the cycle resets or you upgrade.
                              </p>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                  </div>
                ) : (
                  <div className="text-xs text-ink-3">
                    AI plan and usage information is temporarily unavailable.
                  </div>
                )}
              </div>

              {/* Slim Sticky Footer Bar */}
              <div className="sticky bottom-0 z-20 px-6 py-3 border-t border-line bg-surface flex items-center justify-between gap-4 shadow-sm -mx-6 md:-mx-8">
                <div className="flex items-center gap-2 text-xs text-ink-2 truncate">
                  <Sparkles className="w-3.5 h-3.5 text-accent shrink-0" />
                  <span className="truncate">Changes to AI assistant settings take effect immediately.</span>
                </div>
                <button
                  type="button"
                  onClick={handleSaveAISettings}
                  disabled={!isAiDirty || saving}
                  className="btn btn-sm btn-primary gap-2 shadow-xs font-semibold px-4 py-2 shrink-0 text-xs disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {saving ? (
                    <>
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      <span>Saving…</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>Save AI settings</span>
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB: EMAIL & HOSTINGER SMTP */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'email' && (
          <div className="space-y-6 animate-rise">
            <SMTPSettingsSection
              workspace={workspace}
              onWorkspaceUpdated={(ws) => {
                setWorkspace(ws);
                onWorkspaceUpdated?.(ws);
              }}
            />
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 6: INSTALL SNIPPET */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'snippet' && (
          <div className="space-y-6 animate-rise">
            <div className="card p-6 space-y-6">
              <div className="flex items-start justify-between border-b border-line pb-4">
                <div>
                  <h3 className="text-base font-semibold text-ink">Live chat embed snippet</h3>
                  <p className="text-xs text-ink-3 mt-0.5">
                    Embed this script tag into the <code className="font-mono text-accent">&lt;head&gt;</code> or bottom of the <code className="font-mono text-accent">&lt;body&gt;</code> of any website.
                  </p>
                </div>
                <button
                  onClick={copySnippet}
                  className="btn btn-sm btn-primary gap-1.5 shadow-xs"
                >
                  {copiedSnippet ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
                  <span>{copiedSnippet ? 'Copied!' : 'Copy snippet'}</span>
                </button>
              </div>

              {/* Code Snippet Card */}
              <div className="relative code-block p-5">
                <pre>{installSnippetCode}</pre>
              </div>

              {/* Platform Guides */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
                <div className="p-4 rounded-xl border border-line bg-surface-2 space-y-1.5">
                  <div className="font-semibold text-ui text-ink">Custom HTML / Next.js</div>
                  <p className="text-xs text-ink-3">
                    Paste right before the closing <code className="font-mono text-ink">&lt;/body&gt;</code> tag in your layout or HTML file.
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-line bg-surface-2 space-y-1.5">
                  <div className="font-semibold text-ui text-ink">Shopify / Webflow</div>
                  <p className="text-xs text-ink-3">
                    Paste into Project Settings &rarr; Custom Code &rarr; Footer Code.
                  </p>
                </div>
                <div className="p-4 rounded-xl border border-line bg-surface-2 space-y-1.5">
                  <div className="font-semibold text-ui text-ink">WordPress</div>
                  <p className="text-xs text-ink-3">
                    Use any "Insert Headers and Footers" plugin to add the snippet into the footer.
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 8: CUSTOM DOMAINS & PUBLIC HELP CENTER */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'domain' && (
          <div className="space-y-6 animate-rise">
            {/* 1. Live Ready-Made Help Center URL & Subdomain Slug */}
            <div className="card p-6 space-y-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-4">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-xl bg-accent-soft text-accent flex items-center justify-center font-bold">
                    <Globe className="w-5 h-5" />
                  </div>
                  <div>
                    <h3 className="text-md font-semibold text-ink">Ready-Made public help center URL</h3>
                    <p className="text-xs text-ink-3">
                      Every workspace has a live, ready-made Help Center with zero setup required.
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  <span className="px-2.5 py-1 rounded-full text-2xs font-bold tracking-wide uppercase flex items-center gap-1.5 bg-success/10 text-success border border-success/20">
                    <span className="w-1.5 h-1.5 rounded-full bg-success animate-pulse" />
                    <span>Live</span>
                  </span>
                </div>
              </div>

              {/* Resolved URL Display */}
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-surface-2 border border-line">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs text-ink-3 shrink-0 font-medium">Public URL:</span>
                  <a
                    href={getWorkspaceHelpCenterUrl(workspace)}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-ui font-semibold text-accent hover:underline truncate"
                  >
                    {getWorkspaceHelpCenterUrl(workspace)}
                  </a>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => {
                      navigator.clipboard.writeText(getWorkspaceHelpCenterUrl(workspace));
                      setCopiedPublicUrl(true);
                      setTimeout(() => setCopiedPublicUrl(false), 2000);
                      showStatus('Help Center URL copied to clipboard!');
                    }}
                    className="btn btn-sm btn-secondary gap-1.5"
                  >
                    {copiedPublicUrl ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                    <span>{copiedPublicUrl ? 'Copied' : 'Copy'}</span>
                  </button>

                  <a
                    href={getWorkspaceHelpCenterUrl(workspace)}
                    target="_blank"
                    rel="noreferrer"
                    className="btn btn-sm btn-primary gap-1.5"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                    <span>Open</span>
                  </a>
                </div>
              </div>

              {/* Workspace Subdomain Slug Configuration */}
              <div className="pt-4 border-t border-line space-y-3">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                  <div>
                    <h4 className="text-ui font-semibold text-ink flex items-center gap-2">
                      <span>Subdomain slug</span>
                      {hasCustomizedSlug ? (
                        <span className="px-2 py-0.5 rounded-md text-2xs font-semibold bg-surface-3 text-ink-3 border border-line">
                          Slug Customized (Locked)
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-md text-2xs font-semibold bg-accent-soft text-accent border border-accent/20">
                          1 Customization Allowed
                        </span>
                      )}
                    </h4>
                    <p className="text-xs text-ink-3 mt-0.5">
                      {hasCustomizedSlug
                        ? 'Your subdomain slug has already been customized. It is locked to prevent broken links.'
                        : 'You can customize your ready-made subdomain slug once. Choose a permanent, unique name.'}
                    </p>
                  </div>

                  {!hasCustomizedSlug && isOwner && !isEditingSlug && (
                    <button
                      type="button"
                      onClick={() => {
                        setSlugInput(workspace.slug || '');
                        setIsEditingSlug(true);
                      }}
                      className="btn btn-sm btn-secondary text-xs"
                    >
                      Customize slug
                    </button>
                  )}
                </div>

                {isEditingSlug && !hasCustomizedSlug && isOwner ? (
                  <div className="p-4 rounded-xl bg-surface-2 border border-line space-y-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium text-ink-2">
                        Choose Subdomain Slug:
                      </label>
                      <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                        <div className="relative flex-1 flex items-center rounded-xl bg-surface border border-line focus-within:border-accent focus-within:ring-2 focus-within:ring-accent/20 overflow-hidden">
                          <input
                            type="text"
                            value={slugInput}
                            onChange={(e) => setSlugInput(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
                            placeholder="my-company"
                            maxLength={48}
                            className="flex-1 px-3 py-2 text-ui font-mono bg-transparent text-ink placeholder:text-ink-3 outline-none"
                          />
                          <span className="px-3 py-2 text-xs font-mono text-ink-3 bg-surface-2 border-l border-line select-none">
                            .{HELP_BASE_DOMAIN}
                          </span>
                        </div>

                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setIsEditingSlug(false);
                              setSlugInput(workspace.slug || '');
                              setShowSlugConfirm(false);
                            }}
                            disabled={savingSlug}
                            className="btn btn-sm btn-secondary"
                          >
                            Cancel
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowSlugConfirm(true)}
                            disabled={
                              savingSlug ||
                              slugAvailability.checking ||
                              slugAvailability.available === false ||
                              !slugInput.trim() ||
                              slugInput.trim().toLowerCase() === (workspace.slug || '').toLowerCase()
                            }
                            className="btn btn-sm btn-primary"
                          >
                            {savingSlug ? 'Saving...' : 'Save slug'}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Availability Status Feedback */}
                    <div className="text-xs">
                      {slugAvailability.checking ? (
                        <div className="flex items-center gap-1.5 text-ink-3">
                          <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                          <span>Checking availability...</span>
                        </div>
                      ) : slugAvailability.available === true ? (
                        <div className="flex items-center gap-1.5 text-success font-medium">
                          <CheckCircle2 className="w-3.5 h-3.5" />
                          <span>https://{slugAvailability.formattedSlug}.{HELP_BASE_DOMAIN} is available!</span>
                        </div>
                      ) : slugAvailability.error ? (
                        <div className="flex items-center gap-1.5 text-danger font-medium">
                          <AlertCircle className="w-3.5 h-3.5" />
                          <span>{slugAvailability.error}</span>
                        </div>
                      ) : (
                        <span className="text-ink-3">
                          Only lowercase letters, numbers, and hyphens (min 2 chars).
                        </span>
                      )}
                    </div>

                    {/* Confirmation Modal / Alert */}
                    {showSlugConfirm && (
                      <div className="p-3.5 rounded-lg border border-warn/30 bg-warn/10 text-warn text-xs space-y-2.5">
                        <div className="font-semibold flex items-center gap-2">
                          <AlertTriangle className="w-4 h-4 text-warn shrink-0" />
                          <span>Are you sure you want to change your slug?</span>
                        </div>
                        <p className="text-xs opacity-90 leading-relaxed">
                          Your Help Center will be permanently moved to <strong className="font-mono text-ink">https://{slugInput.trim().toLowerCase()}.{HELP_BASE_DOMAIN}</strong>. You can only customize this once.
                        </p>
                        <div className="flex items-center gap-2 pt-1">
                          <button
                            type="button"
                            onClick={handleSaveSlug}
                            disabled={savingSlug}
                            className="btn btn-sm btn-primary bg-warn hover:bg-warn text-ink-inv border-none"
                          >
                            {savingSlug ? 'Saving...' : 'Yes, Permanently Save Slug'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setShowSlugConfirm(false)}
                            className="btn btn-sm btn-secondary"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center gap-2 text-ui font-mono text-ink-2 bg-surface-2 px-3 py-2 rounded-lg border border-line">
                    <span className="text-ink font-semibold">{workspace.slug || workspace.id}</span>
                    <span className="text-ink-3">.{HELP_BASE_DOMAIN}</span>
                  </div>
                )}
              </div>
            </div>

            {/* 2. Custom domain: two steps, records with live ticks (CustomDomainSetup). */}
            <CustomDomainSetup
              workspace={workspace}
              onWorkspaceUpdated={(w) => {
                setWorkspace(w);
                onWorkspaceUpdated?.(w);
              }}
            />

            {/* 3. Website Navbar Launcher Button (Zero-Code) */}
            <div className="card p-6 space-y-5 border border-accent/30 bg-surface">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-line pb-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded text-2xs font-bold uppercase tracking-wider bg-accent/10 text-accent border border-accent/20">
                      Zero-Code automation
                    </span>
                    <h3 className="text-base font-semibold text-ink flex items-center gap-1.5">
                      <span>Website navbar button Auto-Injector</span>
                    </h3>
                  </div>
                  <p className="text-xs text-ink-3">
                    Adds a link to the top menu of your website (e.g. <code className="font-mono text-ink">{cleanDomain(workspace.website_url) || 'yourbrand.com'}</code>), on desktop and in the mobile menu, wherever the chat widget is installed. No website code changes. It never goes in the footer, and the Help options need at least one published article.
                  </p>
                </div>

                {/* Main Toggle */}
                <label className="relative inline-flex items-center cursor-pointer shrink-0">
                  <input
                    type="checkbox"
                    className="sr-only peer"
                    checked={navbarConfig.enabled}
                    onChange={(e) => setNavbarConfig({ ...navbarConfig, enabled: e.target.checked })}
                  />
                  <div className="w-11 h-6 bg-surface-3 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-line-2 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-accent"></div>
                </label>
              </div>

              {navbarConfig.enabled && (
                <div className="space-y-5 pt-1 animate-in fade-in">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                    {/* Button Name Input */}
                    <div className="space-y-1.5">
                      <label className="field-label flex items-center justify-between">
                        <span>Button Text / Name in Navbar</span>
                        <span className="text-2xs text-ink-3">Default: Help</span>
                      </label>
                      <input
                        type="text"
                        value={navbarConfig.label}
                        onChange={(e) => setNavbarConfig({ ...navbarConfig, label: e.target.value })}
                        placeholder="Help"
                        className="input font-semibold text-sm"
                      />
                      <p className="text-2xs text-ink-3">
                        Always adds a new link with this text into your website menu. Never alters or hijacks existing website links.
                      </p>
                    </div>

                    {/* Action Selector */}
                    <div className="space-y-1.5">
                      <label className="field-label">When clicked by visitor</label>
                      <select
                        value={navbarConfig.action}
                        onChange={(e) =>
                          setNavbarConfig({
                            ...navbarConfig,
                            action: e.target.value as 'help' | 'messages' | 'redirect',
                          })
                        }
                        className="input text-ui"
                      >
                        <option value="redirect">
                          🌐 Open Help Center in new tab (Recommended)
                        </option>
                        <option value="help">📖 Open Help &amp; FAQs Slide-out Panel</option>
                        <option value="messages">💬 Open Live Chat Messenger</option>
                      </select>
                      <p className="text-2xs text-ink-3">
                        Opens your Help Center ({getWorkspaceHelpCenterUrl(workspace)}) or slides open the chat widget.
                      </p>
                    </div>
                  </div>

                  {/* Position & Styling Row */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-3 border-t border-line/60">
                    <div className="space-y-1.5 p-3.5 rounded-xl border border-line bg-surface-2">
                      <label className="text-xs font-semibold text-ink block">Placement position</label>
                      <div className="grid grid-cols-2 gap-2 mt-1">
                        <button
                          type="button"
                          onClick={() => setNavbarConfig({ ...navbarConfig, position: 'end' })}
                          className={cn(
                            'px-3 py-1.5 rounded-lg border text-center text-xs font-medium transition-all',
                            navbarConfig.position !== 'start'
                              ? 'border-accent bg-accent/10 text-accent font-semibold'
                              : 'border-line bg-surface text-ink-2 hover:bg-surface-3'
                          )}
                        >
                          End of Menu (Default)
                        </button>
                        <button
                          type="button"
                          onClick={() => setNavbarConfig({ ...navbarConfig, position: 'start' })}
                          className={cn(
                            'px-3 py-1.5 rounded-lg border text-center text-xs font-medium transition-all',
                            navbarConfig.position === 'start'
                              ? 'border-accent bg-accent/10 text-accent font-semibold'
                              : 'border-line bg-surface text-ink-2 hover:bg-surface-3'
                          )}
                        >
                          Start of menu
                        </button>
                      </div>
                      <p className="text-2xs text-ink-3 mt-1">
                        Appends the link at the end of your main navigation bar or prepends it as the first item.
                      </p>
                    </div>

                    <div className="space-y-1.5 p-3.5 rounded-xl border border-line bg-surface-2">
                      <label className="text-xs font-semibold text-ink block">Button styling variant</label>
                      <div className="grid grid-cols-2 gap-2 mt-1">
                        <button
                          type="button"
                          onClick={() => setNavbarConfig({ ...navbarConfig, style: 'navbar_link' })}
                          className={cn(
                            'px-3 py-1.5 rounded-lg border text-center text-xs font-medium transition-all',
                            navbarConfig.style === 'navbar_link'
                              ? 'border-accent bg-accent/10 text-accent font-semibold'
                              : 'border-line bg-surface text-ink-2 hover:bg-surface-3'
                          )}
                        >
                          Auto-Match nav links
                        </button>
                        <button
                          type="button"
                          onClick={() => setNavbarConfig({ ...navbarConfig, style: 'pill' })}
                          className={cn(
                            'px-3 py-1.5 rounded-lg border text-center text-xs font-medium transition-all',
                            navbarConfig.style === 'pill'
                              ? 'border-accent bg-accent/10 text-accent font-semibold'
                              : 'border-line bg-surface text-ink-2 hover:bg-surface-3'
                          )}
                        >
                          Modern pill button
                        </button>
                      </div>
                      <p className="text-2xs text-ink-3 mt-1">
                        Copies fonts and spacing from existing menu links or styles as a prominent pill badge.
                      </p>
                    </div>
                  </div>

                  {/* Simulator Preview & Trigger */}
                  <div className="p-4 rounded-xl border border-line bg-surface-2/40 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div className="space-y-0.5">
                      <span className="text-ui font-semibold text-ink flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-accent" />
                        <span>Interactive website simulator</span>
                      </span>
                      <p className="text-xs text-ink-3">
                        Test and see how your menu link looks live on your site layout.
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => setIsNavbarSimulatorOpen(true)}
                      className="btn btn-sm btn-secondary gap-1.5 shrink-0"
                    >
                      <Laptop className="w-3.5 h-3.5" />
                      <span>Preview in Simulator</span>
                    </button>
                  </div>

                  {/* HTML Snippet & Optional Selector Fallback */}
                  <div className="p-4 rounded-xl border border-line/80 bg-surface-2/20 space-y-3">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-ink flex items-center gap-1.5">
                        <Code className="w-3.5 h-3.5 text-ink-3" />
                        <span>Manual HTML Snippet (If Automatic Detection is not preferred)</span>
                      </span>
                    </div>
                    <p className="text-2xs text-ink-3">
                      Paste it into your menu yourself; the automatic link then stays away, so there is never a second one. To keep the automatic link off a page, add <code className="font-mono text-ink">&lt;div data-zentry-no-nav&gt;&lt;/div&gt;</code> to it.
                    </p>

                    <div className="flex items-center gap-2 bg-invert border border-line-3 rounded-lg p-2 font-mono text-xs text-ink-3">
                      <input
                        type="text"
                        readOnly
                        value={manualNavSnippet}
                        className="bg-transparent border-none outline-hidden flex-1 text-ink-3 font-mono text-xs"
                      />
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard.writeText(manualNavSnippet);
                          showStatus('HTML snippet copied to clipboard!');
                        }}
                        className="btn btn-xs btn-primary shrink-0 gap-1"
                      >
                        <Copy className="w-3 h-3" />
                        <span>Copy HTML</span>
                      </button>
                    </div>

                    <div className="space-y-1 pt-1">
                      <label className="text-xs font-semibold text-ink block">
                        Optional custom CSS selector
                      </label>
                      <input
                        type="text"
                        value={navbarConfig.target_selector || ''}
                        onChange={(e) => setNavbarConfig({ ...navbarConfig, target_selector: e.target.value })}
                        placeholder="header nav ul, #primary-navigation"
                        className="input h-8 text-xs font-mono"
                      />
                      <p className="text-2xs text-ink-3">
                        Leave blank to detect the menu automatically. Use this only if the link lands in the wrong place.
                      </p>
                    </div>
                  </div>

                  {/* Save Button */}
                  <div className="flex items-center justify-between pt-2">
                    <span className="text-xs text-success flex items-center gap-1.5 font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>Zero-code: Updates live on your website instantly upon saving.</span>
                    </span>

                    <button
                      type="button"
                      onClick={handleSaveNavbarConfig}
                      disabled={savingNavbar}
                      className="btn btn-primary px-5 gap-1.5"
                    >
                      <Sparkles className="w-3.5 h-3.5" />
                      <span>{savingNavbar ? 'Saving…' : 'Save & Activate on Website'}</span>
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ─────────────────────────────────────────────────────────────────── */}
        {/* TAB 9: INSTALL SNIPPET & EMBED CODE HELPER */}
        {/* ─────────────────────────────────────────────────────────────────── */}
        {activeTab === 'snippet' && (
          <div className="space-y-8 animate-rise max-w-5xl">
            {/* Header Banner */}
            <div className="card p-6 border-accent/20 bg-accent-soft">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
                <div className="space-y-1">
                  <div className="flex items-center gap-2.5">
                    <div className="w-9 h-9 rounded-xl bg-accent/10 border border-accent/20 flex items-center justify-center text-accent">
                      <Code className="w-5 h-5" />
                    </div>
                    <div>
                      <h3 className="text-lg font-bold text-ink">Install Zen-try &amp; Help Center Widget</h3>
                      <p className="text-xs text-ink-3">
                        Embed live chat, knowledge base search, and custom Help buttons onto any website or app.
                      </p>
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <a
                    href={`/demo.html?workspaceId=${workspace.id}&name=${encodeURIComponent(workspace.name)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="btn btn-sm btn-primary gap-1.5 shadow-sm shrink-0"
                  >
                    <span>Test in Simulator</span>
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </div>

            {/* Step 1: Base Script Tag */}
            <div className="card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-bold">
                    1
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-ink">Add the Widget Script Tag</h4>
                    <p className="text-xs text-ink-3">
                      Paste this script right before the closing <code className="font-mono text-accent text-xs">&lt;/body&gt;</code> tag on your HTML pages.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const host = getWidgetOrigin();
                    const snippet = `<script\n  src="${host}/widget.js"\n  data-workspace-id="${workspace.id}"\n  data-color="${workspace.brand_color || DEFAULT_BRAND_COLOR}"\n  data-title="${workspace.name} Support"\n  async>\n</script>`;
                    navigator.clipboard.writeText(snippet);
                    setCopiedSnippet(true);
                    setTimeout(() => setCopiedSnippet(false), 2000);
                    showStatus('Widget embed script copied to clipboard!');
                  }}
                  className="btn btn-sm btn-secondary gap-1.5 shadow-xs"
                >
                  {copiedSnippet ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
                  <span>{copiedSnippet ? 'Copied!' : 'Copy script tag'}</span>
                </button>
              </div>

              {/* Code Display */}
              {(() => {
                const host = getWidgetOrigin();
                const snippet = `<script\n  src="${host}/widget.js"\n  data-workspace-id="${workspace.id}"\n  data-color="${workspace.brand_color || DEFAULT_BRAND_COLOR}"\n  data-title="${workspace.name} Support"\n  async>\n</script>`;
                return (
                  <div className="relative rounded-xl border border-line bg-surface-2 p-4 font-mono text-xs text-ink overflow-x-auto leading-relaxed">
                    <pre><code>{snippet}</code></pre>
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 text-xs text-ink-3">
                <div className="p-3 rounded-xl border border-line/60 bg-surface">
                  <div className="font-semibold text-ink text-xs">Workspace ID</div>
                  <div className="font-mono text-xs text-accent mt-0.5 truncate">{workspace.id}</div>
                </div>
                <div className="p-3 rounded-xl border border-line/60 bg-surface">
                  <div className="font-semibold text-ink text-xs">Brand color</div>
                  <div className="font-mono text-xs text-ink mt-0.5">{workspace.brand_color || DEFAULT_BRAND_COLOR}</div>
                </div>
                <div className="p-3 rounded-xl border border-line/60 bg-surface">
                  <div className="font-semibold text-ink text-xs">Bundle optimization</div>
                  <div className="text-xs text-ink mt-0.5">Asynchronous zero-blocking loading</div>
                </div>
              </div>
            </div>

            {/* Step 2: Help Button & Trigger Triggers */}
            <div className="card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-bold">
                    2
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-ink">Add a Help Button to Your Website Navbar</h4>
                    <p className="text-xs text-ink-3">
                      Use declarative HTML data attributes to trigger the widget tabs without writing any JavaScript.
                    </p>
                  </div>
                </div>
              </div>

              <div className="space-y-4">
                {/* Help Trigger */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-ui font-semibold text-ink">1. Dedicated Help &amp; FAQs Button</span>
                      <span className="text-2xs px-2 py-0.5 rounded-full bg-accent/10 text-accent font-semibold">Recommended</span>
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        const code = `<button data-zentry-help class="help-btn">\n  📖 Help & FAQs\n</button>`;
                        navigator.clipboard.writeText(code);
                        showStatus('Help button trigger copied!');
                      }}
                      className="btn btn-xs btn-secondary gap-1"
                    >
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </button>
                  </div>
                  <p className="text-xs text-ink-3">
                    Clicking this element opens the widget directly into the Help tab and focuses the article search bar.
                  </p>
                  <div className="rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink overflow-x-auto">
                    <code>&lt;button data-zentry-help class=&quot;help-btn&quot;&gt;&#10;  📖 Help &amp; FAQs&#10;&lt;/button&gt;</code>
                  </div>
                </div>

                {/* Specific Article Trigger */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-ui font-semibold text-ink">2. Deep Link to a Specific Article</span>
                    <button
                      type="button"
                      onClick={() => {
                        const code = `<button data-zentry-article="your-article-slug">\n  Read Getting Started Guide ↗\n</button>`;
                        navigator.clipboard.writeText(code);
                        showStatus('Article trigger copied!');
                      }}
                      className="btn btn-xs btn-secondary gap-1"
                    >
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </button>
                  </div>
                  <p className="text-xs text-ink-3">
                    Directly opens and expands an article accordion inside the widget using its slug or ID.
                  </p>
                  <div className="rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink overflow-x-auto">
                    <code>&lt;button data-zentry-article=&quot;your-article-slug&quot;&gt;&#10;  Read Getting Started Guide ↗&#10;&lt;/button&gt;</code>
                  </div>
                </div>

                {/* Open Chat Trigger */}
                <div className="p-4 rounded-xl border border-line bg-surface space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-ui font-semibold text-ink">3. Open Live Chat Directly</span>
                    <button
                      type="button"
                      onClick={() => {
                        const code = `<button data-zentry-open data-zentry-tab="messages">\n  Chat with Support\n</button>`;
                        navigator.clipboard.writeText(code);
                        showStatus('Live chat trigger copied!');
                      }}
                      className="btn btn-xs btn-secondary gap-1"
                    >
                      <Copy className="w-3 h-3" />
                      <span>Copy</span>
                    </button>
                  </div>
                  <p className="text-xs text-ink-3">
                    Opens the widget straight into the live chat messenger screen.
                  </p>
                  <div className="rounded-lg bg-surface-2 p-3 font-mono text-xs text-ink overflow-x-auto">
                    <code>&lt;button data-zentry-open data-zentry-tab=&quot;messages&quot;&gt;&#10;  Chat with Support&#10;&lt;/button&gt;</code>
                  </div>
                </div>
              </div>
            </div>

            {/* Step 3: JavaScript SDK API */}
            <div className="card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-bold">
                    3
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-ink">JavaScript SDK API (`window.Zentry`)</h4>
                    <p className="text-xs text-ink-3">
                      Control the widget programmatically in your frontend framework (React, Vue, Angular, Next.js).
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const jsCode = `// Open Help Center Tab directly\nwindow.Zentry.openHelp();\n\n// Open Live Chat screen\nwindow.Zentry.openMessages();\n\n// Search articles programmatically\nwindow.Zentry.search('billing');\n\n// Open specific article by slug\nwindow.Zentry.openArticle('how-to-reset-password');\n\n// Toggle widget\nwindow.Zentry.toggle();\n\n// Check if widget is open\nconsole.log(window.Zentry.isOpen());`;
                    navigator.clipboard.writeText(jsCode);
                    showStatus('JavaScript SDK cheat-sheet copied!');
                  }}
                  className="btn btn-sm btn-secondary gap-1.5 shadow-xs"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy SDK code</span>
                </button>
              </div>

              <div className="rounded-xl border border-line bg-surface-2 p-4 font-mono text-xs text-ink overflow-x-auto leading-relaxed">
                <pre><code>{`// 1. Open Help Center Tab directly
window.Zentry.openHelp();

// 2. Open Live Chat screen
window.Zentry.openMessages();

// 3. Search articles programmatically
window.Zentry.search('billing');

// 4. Open specific article by slug
window.Zentry.openArticle('how-to-reset-password');

// 5. Toggle or close widget
window.Zentry.toggle();
window.Zentry.close();`}</code></pre>
              </div>
            </div>

            {/* Step 4: Next.js & React Frameworks */}
            <div className="card p-6 space-y-4">
              <div className="flex items-center justify-between border-b border-line pb-3">
                <div className="flex items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-accent text-white flex items-center justify-center text-xs font-bold">
                    4
                  </span>
                  <div>
                    <h4 className="text-sm font-semibold text-ink">Next.js &amp; React Integration</h4>
                    <p className="text-xs text-ink-3">
                      Using Next.js App Router or Pages Router? Use the <code className="font-mono text-accent text-xs">next/script</code> component.
                    </p>
                  </div>
                </div>

                <button
                  type="button"
                  onClick={() => {
                    const host = getWidgetOrigin();
                    const nextSnippet = `import Script from 'next/script';\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Script\n          src="${host}/widget.js"\n          data-workspace-id="${workspace.id}"\n          strategy="afterInteractive"\n        />\n      </body>\n    </html>\n  );\n}`;
                    navigator.clipboard.writeText(nextSnippet);
                    showStatus('Next.js component snippet copied!');
                  }}
                  className="btn btn-sm btn-secondary gap-1.5 shadow-xs"
                >
                  <Copy className="w-3.5 h-3.5" />
                  <span>Copy Next.js Snippet</span>
                </button>
              </div>

              {(() => {
                const host = getWidgetOrigin();
                const nextSnippet = `import Script from 'next/script';\n\nexport default function RootLayout({ children }) {\n  return (\n    <html lang="en">\n      <body>\n        {children}\n        <Script\n          src="${host}/widget.js"\n          data-workspace-id="${workspace.id}"\n          strategy="afterInteractive"\n        />\n      </body>\n    </html>\n  );\n}`;
                return (
                  <div className="rounded-xl border border-line bg-surface-2 p-4 font-mono text-xs text-ink overflow-x-auto leading-relaxed">
                    <pre><code>{nextSnippet}</code></pre>
                  </div>
                );
              })()}
            </div>
          </div>
        )}
        {/* WEBSITE NAVBAR BUTTON SIMULATOR & PREVIEW MODAL */}
        {isNavbarSimulatorOpen && (
          <NavbarPreviewModal
            isOpen={isNavbarSimulatorOpen}
            onClose={() => setIsNavbarSimulatorOpen(false)}
            workspace={workspace}
            onConfigSaved={(updatedWs) => {
              setWorkspace(updatedWs);
              onWorkspaceUpdated?.(updatedWs);
              showStatus('Navbar settings saved! Live on your website.');
            }}
            showToast={(msg, type) => showStatus(msg, type)}
          />
        )}
      </div>
    </div>
  );
}
