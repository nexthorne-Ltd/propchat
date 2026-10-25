'use client';

import React, { useState } from 'react';
import {
  X,
  Sparkles,
  Globe,
  ExternalLink,
  BookOpen,
  Copy,
  Check,
  Code2,
  Sliders,
  CheckCircle2,
  AlertCircle,
  Laptop,
} from 'lucide-react';
import { NavbarTriggerConfig, Workspace } from '@/types/database';
import { updateNavbarTriggerConfigAction } from '@/app/actions/admin';
import { getWorkspaceHelpCenterUrl, cleanDomain } from '@/lib/domain';
import { cn } from '@/lib/utils';
import { errorMessage } from '@/lib/errors/user-error';
import { DEFAULT_BRAND_COLOR } from '@/lib/brand';

interface NavbarPreviewModalProps {
  isOpen: boolean;
  onClose: () => void;
  workspace: Workspace;
  onConfigSaved?: (savedWorkspace: Workspace) => void;
  showToast?: (text: string, type?: 'success' | 'error') => void;
}

export function NavbarPreviewModal({
  isOpen,
  onClose,
  workspace,
  onConfigSaved,
  showToast,
}: NavbarPreviewModalProps) {
  const currentConfig = workspace.navbar_trigger_config || {
    enabled: false,
    label: 'Help',
    action: 'help',
    auto_inject: true,
    style: 'navbar_link',
    position: 'end',
  };

  const [label, setLabel] = useState<string>(currentConfig.label || 'Help');
  const [action, setAction] = useState<'help' | 'messages' | 'redirect'>(
    currentConfig.action || 'redirect'
  );
  const [position, setPosition] = useState<'start' | 'end'>(
    (currentConfig as any).position || 'end'
  );
  const [style, setStyle] = useState<'navbar_link' | 'pill'>(
    currentConfig.style || 'navbar_link'
  );
  const [targetSelector, setTargetSelector] = useState<string>(
    currentConfig.target_selector || ''
  );
  const [showAdvanced, setShowAdvanced] = useState<boolean>(false);
  const [copiedSnippet, setCopiedSnippet] = useState<boolean>(false);
  const [isSaving, setIsSaving] = useState<boolean>(false);

  if (!isOpen) return null;

  const helpCenterUrl = getWorkspaceHelpCenterUrl(workspace);
  const siteDomain = cleanDomain(workspace.website_url) || 'yourcompany.com';
  const siteUrl = workspace.website_url
    ? workspace.website_url.startsWith('http')
      ? workspace.website_url
      : `https://${workspace.website_url}`
    : `https://${siteDomain}`;

  const copySnippetHtml = `<a href="${helpCenterUrl}" target="_blank" rel="noopener noreferrer">${label || 'Help'}</a>`;

  const handleCopySnippet = () => {
    navigator.clipboard.writeText(copySnippetHtml);
    setCopiedSnippet(true);
    setTimeout(() => setCopiedSnippet(false), 2000);
  };

  const handleSaveAndActivate = async () => {
    setIsSaving(true);
    try {
      const updatedConfig: NavbarTriggerConfig = {
        enabled: true,
        label: label.trim() || 'Help',
        action,
        style,
        position,
        auto_inject: true,
        target_selector: targetSelector.trim() || undefined,
        dismissed_prompt: true,
      };

      const res = await updateNavbarTriggerConfigAction(workspace.id, updatedConfig);
      if (res.workspace) {
        onConfigSaved?.(res.workspace);
        showToast?.('Help button added to your website navbar! Changes are live.', 'success');
        onClose();
      }
    } catch (err: any) {
      showToast?.(errorMessage(err, 'Failed to update navbar settings'), 'error');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      className="fixed inset-0 z-[9999] flex items-center justify-center p-3 sm:p-5 bg-overlay animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-4xl popover border border-line rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-line bg-surface-2/60 shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-accent/15 text-accent flex items-center justify-center">
              <Sparkles className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-base font-bold text-ink">Website Navbar Button Preview &amp; Setup</h2>
              <p className="text-xs text-ink-3">
                See exactly where your Help link will appear on your website navigation.
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-3 hover:text-ink hover:bg-surface-3 transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* Controls Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 p-4 rounded-xl bg-surface-2/50 border border-line">
            {/* 1. Label */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-ink flex items-center justify-between">
                <span>Menu Label</span>
                <span className="text-2xs text-ink-3">Default: Help</span>
              </label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="Help"
                className="input h-9 text-ui font-medium"
              />
            </div>

            {/* 2. Position */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-ink block">Position</label>
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-surface border border-line">
                <button
                  type="button"
                  onClick={() => setPosition('end')}
                  className={cn(
                    'py-1 text-xs font-medium rounded-md transition-all text-center',
                    position === 'end'
                      ? 'bg-accent text-accent-ink font-semibold shadow-xs'
                      : 'text-ink-3 hover:text-ink'
                  )}
                >
                  End of menu
                </button>
                <button
                  type="button"
                  onClick={() => setPosition('start')}
                  className={cn(
                    'py-1 text-xs font-medium rounded-md transition-all text-center',
                    position === 'start'
                      ? 'bg-accent text-accent-ink font-semibold shadow-xs'
                      : 'text-ink-3 hover:text-ink'
                  )}
                >
                  Start of menu
                </button>
              </div>
            </div>

            {/* 3. Style Variant */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-ink block">Style</label>
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-surface border border-line">
                <button
                  type="button"
                  onClick={() => setStyle('navbar_link')}
                  className={cn(
                    'py-1 text-xs font-medium rounded-md transition-all text-center truncate px-1',
                    style === 'navbar_link'
                      ? 'bg-accent text-accent-ink font-semibold shadow-xs'
                      : 'text-ink-3 hover:text-ink'
                  )}
                  title="Match existing navbar links"
                >
                  Match Links
                </button>
                <button
                  type="button"
                  onClick={() => setStyle('pill')}
                  className={cn(
                    'py-1 text-xs font-medium rounded-md transition-all text-center truncate px-1',
                    style === 'pill'
                      ? 'bg-accent text-accent-ink font-semibold shadow-xs'
                      : 'text-ink-3 hover:text-ink'
                  )}
                  title="Pill button with brand accent color"
                >
                  Pill Button
                </button>
              </div>
            </div>

            {/* 4. Action */}
            <div className="space-y-1.5">
              <label className="text-xs font-semibold text-ink block">When Clicked</label>
              <select
                value={action}
                onChange={(e) => setAction(e.target.value as any)}
                className="input h-9 text-xs font-medium"
              >
                <option value="redirect">🌐 Open Help Center in new tab</option>
                <option value="help">📖 Open Widget Help Tab</option>
              </select>
            </div>
          </div>

          {/* Simulator Mockup Frame */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-ink-3 uppercase tracking-wider flex items-center gap-1.5">
                <Laptop className="w-3.5 h-3.5" />
                <span>Live Website Navbar Simulator</span>
              </span>
              <span className="text-2xs text-success font-medium flex items-center gap-1">
                <CheckCircle2 className="w-3.5 h-3.5" />
                Main navigation detected with confidence
              </span>
            </div>

            <div className="rounded-xl border border-line-3 bg-invert overflow-hidden shadow-2xl text-invert-ink">
              {/* Browser chrome address bar */}
              <div className="px-4 py-2.5 bg-invert border-b border-line-3 flex items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-full bg-danger/80 inline-block"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-warn/80 inline-block"></span>
                  <span className="w-2.5 h-2.5 rounded-full bg-success/80 inline-block"></span>
                </div>
                <div className="flex-1 max-w-md mx-auto bg-invert/80 border border-line-3 rounded-lg px-3 py-1 text-xs text-ink-3 font-mono flex items-center gap-1.5 truncate">
                  <Globe className="w-3 h-3 text-ink-3 shrink-0" />
                  <span className="truncate">{siteUrl}</span>
                </div>
              </div>

              {/* Simulated Website Navigation Bar */}
              <div className="px-6 py-4 bg-invert/90 border-b border-line-3/80 flex items-center justify-between gap-4">
                {/* Brand */}
                <div className="flex items-center gap-2.5 shrink-0">
                  <div
                    className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-bold text-ui shadow-sm"
                    style={{ backgroundColor: workspace.brand_color || DEFAULT_BRAND_COLOR }}
                  >
                    {(workspace.name || 'C').charAt(0).toUpperCase()}
                  </div>
                  <span className="font-bold text-md tracking-tight text-white">
                    {workspace.name || 'Your Company'}
                  </span>
                </div>

                {/* Navigation Links List */}
                <nav className="flex items-center gap-5 text-ui">
                  {position === 'start' && (
                    <div className="relative group">
                      {style === 'pill' ? (
                        <span
                          className="inline-flex items-center justify-center px-3.5 py-1 rounded-full text-white text-xs font-semibold shadow-md transition-all animate-pulse"
                          style={{ backgroundColor: workspace.brand_color || DEFAULT_BRAND_COLOR }}
                        >
                          {label || 'Help'}
                        </span>
                      ) : (
                        <span className="font-semibold text-white underline decoration-accent underline-offset-4 cursor-pointer">
                          {label || 'Help'}
                        </span>
                      )}
                      <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-2xs font-bold bg-accent text-accent-ink whitespace-nowrap shadow-sm">
                        New Link
                      </span>
                    </div>
                  )}

                  <span className="text-ink-3 hover:text-invert-ink cursor-default transition-colors">
                    Products
                  </span>
                  <span className="text-ink-3 hover:text-invert-ink cursor-default transition-colors">
                    Solutions
                  </span>
                  <span className="text-ink-3 hover:text-invert-ink cursor-default transition-colors">
                    Pricing
                  </span>
                  <span className="text-ink-3 hover:text-invert-ink cursor-default transition-colors">
                    About
                  </span>

                  {position === 'end' && (
                    <div className="relative group">
                      {style === 'pill' ? (
                        <span
                          className="inline-flex items-center justify-center px-3.5 py-1 rounded-full text-white text-xs font-semibold shadow-md transition-all animate-pulse"
                          style={{ backgroundColor: workspace.brand_color || DEFAULT_BRAND_COLOR }}
                        >
                          {label || 'Help'}
                        </span>
                      ) : (
                        <span className="font-semibold text-white underline decoration-accent underline-offset-4 cursor-pointer">
                          {label || 'Help'}
                        </span>
                      )}
                      <span className="absolute -top-7 left-1/2 -translate-x-1/2 px-2 py-0.5 rounded text-2xs font-bold bg-accent text-accent-ink whitespace-nowrap shadow-sm">
                        New Link
                      </span>
                    </div>
                  )}
                </nav>

                {/* Primary CTA */}
                <div className="hidden sm:block">
                  <span
                    className="px-3.5 py-1.5 rounded-lg text-white font-semibold text-xs shadow-sm cursor-default"
                    style={{ backgroundColor: workspace.brand_color || DEFAULT_BRAND_COLOR }}
                  >
                    Get Started
                  </span>
                </div>
              </div>

              {/* Simulated Hero Section (gives authentic context) */}
              <div className="p-8 text-center bg-invert border-b border-line-3">
                <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-invert/80 border border-line-3 text-ink-3 text-2xs font-medium mb-3">
                  <Sparkles className="w-3 h-3 text-accent" />
                  <span>Welcome to {workspace.name || 'Our Website'}</span>
                </div>
                <h3 className="text-xl font-bold text-white max-w-md mx-auto">
                  Experience seamless customer support and public knowledge base
                </h3>
                <p className="text-xs text-ink-3 mt-2 max-w-sm mx-auto">
                  Visitors click your new navigation button to read help articles or chat directly with your team.
                </p>
              </div>
            </div>
          </div>

          {/* Advanced / Manual Snippet Option */}
          <div className="border border-line/60 rounded-xl overflow-hidden bg-surface-2/30">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="w-full px-4 py-3 flex items-center justify-between text-left text-xs font-semibold text-ink-2 hover:text-ink transition-colors"
            >
              <div className="flex items-center gap-2">
                <Code2 className="w-4 h-4 text-ink-3" />
                <span>Manual HTML Snippet &amp; Custom Selector (Optional)</span>
              </div>
              <span className="text-2xs text-ink-3">
                {showAdvanced ? 'Hide' : 'Show Snippet'}
              </span>
            </button>

            {showAdvanced && (
              <div className="p-4 pt-1 border-t border-line/60 space-y-3 bg-surface">
                <p className="text-xs text-ink-3">
                  If your website uses a custom CMS or Shadow DOM where automatic navbar injection isn&apos;t preferred, paste this HTML link directly into your menu:
                </p>

                <div className="flex items-center gap-2 bg-invert border border-line-3 rounded-lg p-2 font-mono text-xs text-ink-3">
                  <input
                    type="text"
                    readOnly
                    value={copySnippetHtml}
                    className="bg-transparent border-none outline-hidden flex-1 text-ink-3 font-mono"
                  />
                  <button
                    type="button"
                    onClick={handleCopySnippet}
                    className="btn btn-xs btn-primary shrink-0 gap-1"
                  >
                    {copiedSnippet ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    <span>{copiedSnippet ? 'Copied!' : 'Copy'}</span>
                  </button>
                </div>

                <div className="space-y-1 pt-1">
                  <label className="text-xs font-semibold text-ink block">
                    Optional Custom CSS Selector
                  </label>
                  <input
                    type="text"
                    value={targetSelector}
                    onChange={(e) => setTargetSelector(e.target.value)}
                    placeholder="header nav ul, #primary-menu"
                    className="input h-8 text-xs font-mono"
                  />
                  <p className="text-2xs text-ink-3">
                    Leave blank to automatically detect your main navigation menu.
                  </p>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="flex items-center justify-between px-6 py-4 border-t border-line bg-surface-2/60 shrink-0">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary px-4 text-ui"
          >
            Cancel
          </button>

          <button
            type="button"
            onClick={handleSaveAndActivate}
            disabled={isSaving}
            className="btn btn-primary px-6 gap-2 text-ui font-semibold shadow-md"
          >
            <Sparkles className="w-4 h-4" />
            <span>{isSaving ? 'Activating…' : 'Add to Website Menu'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
