'use server';

import { createClient } from '@/lib/supabase/server';
import { serviceClient } from '@/lib/supabase/service';
import {
  Workspace,
  Agent,
  CannedResponse,
  BusinessHoursConfig,
  AutoAssignmentConfig,
  AISettingsConfig,
  NavbarTriggerConfig,
  SMTPSettingsConfig,
  WidgetIconType,
} from '@/types/database';
import { generateUniqueWorkspaceSlug } from '@/lib/slug';
import { getIndustryPreset } from '@/lib/onboarding-presets';
import { getWorkspaceAccess } from '@/lib/team/access';
import { assertSettingNotLocked } from '@/lib/settings/precedence';
import { LAUNCHER_ICONS, isHexColor, isWidgetColorMode, isWidgetDesign } from '@/lib/widget/launcher-icons';
import { normalizePrechat } from '@/lib/widget/prechat';
import { userError } from '@/lib/errors/user-error';
import { refreshHelpCenter } from '@/lib/help/refresh';
import { cleanHelpTheme } from '@/lib/help/theme';

/**
 * Ensures the caller is an active owner or admin of the workspace (the
 * `manage_settings` capability). Deactivated agents and light agents are refused.
 */
export async function assertAdminUser(workspaceId: string): Promise<{ user: { id: string }; agent: Agent }> {
  const { user, agent } = await getWorkspaceAccess(workspaceId, 'manage_settings');
  return { user, agent: agent as unknown as Agent };
}

/**
 * Fetch all admin settings data for the given workspace in a single round-trip.
 */
export async function getAdminDataAction(workspaceId: string) {
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const [{ data: workspace }, { data: agents }, { data: cannedResponses }] = await Promise.all([
    supabase.from('workspaces').select('*').eq('id', workspaceId).single(),
    supabase.from('agents').select('*').eq('workspace_id', workspaceId).order('name'),
    supabase
      .from('canned_responses')
      .select('*')
      .eq('workspace_id', workspaceId)
      .order('shortcut'),
  ]);

  return {
    workspace: workspace as Workspace | null,
    agents: (agents as Agent[]) || [],
    cannedResponses: (cannedResponses as CannedResponse[]) || [],
  };
}

/**
 * SECTION 1: Widget Customization
 */
export async function updateWidgetSettingsAction(
  workspaceId: string,
  data: {
    brand_color?: string;
    logo_url?: string | null;
    show_launcher_logo?: boolean;
    widget_icon?: WidgetIconType;
    widget_design?: string;
    /** #rrggbb, or empty to go back to the automatic darker brand colour. */
    widget_secondary_color?: string;
    widget_color_mode?: string;
    widget_position?: 'right' | 'left';
    greeting_title?: string;
    greeting_message?: string;
    help_center_tab_label?: string;
    show_help_tab?: boolean;
    help_center_tab_icon?: string;
    launcher_offset_bottom?: number;
    launcher_offset_side?: number;
    widget_z_index?: number;
    enable_proactive_welcome?: boolean;
    proactive_delay_seconds?: number;
  }
) {
  await assertSettingNotLocked(workspaceId, 'widget_appearance');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const updatePayload: any = {
    brand_color: data.brand_color,
    logo_url: data.logo_url,
    widget_position: data.widget_position || 'right',
    greeting_title: data.greeting_title,
    greeting_message: data.greeting_message,
  };

  if (data.widget_design !== undefined && !isWidgetDesign(data.widget_design)) {
    throw userError('Choose one of the messenger designs.');
  }
  if (data.widget_secondary_color && !isHexColor(data.widget_secondary_color)) {
    throw userError('The second colour must be a hex colour such as #7c3aed.');
  }
  if (data.widget_color_mode !== undefined && !isWidgetColorMode(data.widget_color_mode)) {
    throw userError('Choose light, dark or match visitor.');
  }
  if (data.widget_icon !== undefined && data.widget_icon !== 'custom_logo' && !LAUNCHER_ICONS.some((i) => i.id === data.widget_icon)) {
    throw userError('Choose one of the launcher icons.');
  }

  // The icon and the design live in navbar_trigger_config, which the widget
  // already reads through fn_get_workspace_config (no migration needed).
  if (
    data.widget_icon !== undefined ||
    data.widget_design !== undefined ||
    data.widget_secondary_color !== undefined ||
    data.widget_color_mode !== undefined
  ) {
    const { data: currentWs } = await supabase
      .from('workspaces')
      .select('navbar_trigger_config')
      .eq('id', workspaceId)
      .single();
    const navConfig = (currentWs?.navbar_trigger_config || {}) as any;
    if (data.widget_icon !== undefined) navConfig.widget_icon = data.widget_icon;
    if (data.widget_design !== undefined) navConfig.widget_design = data.widget_design;
    if (data.widget_secondary_color !== undefined) {
      if (data.widget_secondary_color) navConfig.widget_secondary_color = data.widget_secondary_color;
      else delete navConfig.widget_secondary_color;
    }
    if (data.widget_color_mode !== undefined) navConfig.widget_color_mode = data.widget_color_mode;
    updatePayload.navbar_trigger_config = navConfig;
  }
  if (data.widget_icon !== undefined) {
    updatePayload.show_launcher_logo = data.widget_icon === 'custom_logo';
  } else if (data.show_launcher_logo !== undefined) {
    updatePayload.show_launcher_logo = data.show_launcher_logo;
  }
  if (data.help_center_tab_label !== undefined) {
    updatePayload.help_center_tab_label = data.help_center_tab_label;
  }
  if (data.show_help_tab !== undefined) {
    updatePayload.show_help_tab = data.show_help_tab;
  }
  if (data.help_center_tab_icon !== undefined) {
    updatePayload.help_center_tab_icon = data.help_center_tab_icon;
  }
  if (data.launcher_offset_bottom !== undefined) {
    updatePayload.launcher_offset_bottom = Math.max(0, Number(data.launcher_offset_bottom));
  }
  if (data.launcher_offset_side !== undefined) {
    updatePayload.launcher_offset_side = Math.max(0, Number(data.launcher_offset_side));
  }
  if (data.widget_z_index !== undefined) {
    updatePayload.widget_z_index = Math.max(1, Number(data.widget_z_index));
  }
  if (data.enable_proactive_welcome !== undefined) {
    updatePayload.enable_proactive_welcome = Boolean(data.enable_proactive_welcome);
  }
  if (data.proactive_delay_seconds !== undefined) {
    updatePayload.proactive_delay_seconds = Math.max(8, Number(data.proactive_delay_seconds));
  }

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update(updatePayload)
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) throw userError(error.message);
  refreshHelpCenter(workspaceId);
  return { success: true, workspace: updated as Workspace };
}

/**
 * SECTION 2: Business Hours
 */
export async function updateBusinessHoursAction(
  workspaceId: string,
  businessHours: BusinessHoursConfig
) {
  await assertSettingNotLocked(workspaceId, 'business_hours');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({
      business_hours: businessHours,
    })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) throw userError(error.message);

  // Business-hour SLA timers count against these hours, so open tickets have
  // to be re-timed. The hours are saved either way; a failure here is logged
  // and the next ticket change or the SLA cron brings the timers in line.
  const { error: slaError } = await supabase.rpc('fn_sla_reapply_workspace', { p_workspace_id: workspaceId });
  if (slaError) console.error('[SLA Error]: could not re-time tickets after a business hours change:', slaError.message);

  return { success: true, workspace: updated as Workspace };
}

/**
 * SECTION 4: Canned Responses CRUD
 */
export async function createCannedResponseAction(
  workspaceId: string,
  data: {
    shortcut: string;
    title: string;
    content: string;
    scope: 'team' | 'agent';
    agent_id?: string;
  }
) {
  const { agent: currentAgent } = await assertAdminUser(workspaceId);
  const supabase = await createClient();

  let formattedShortcut = data.shortcut.trim();
  if (!formattedShortcut.startsWith('/')) {
    formattedShortcut = `/${formattedShortcut}`;
  }

  const { data: inserted, error } = await supabase
    .from('canned_responses')
    .insert({
      workspace_id: workspaceId,
      shortcut: formattedShortcut,
      title: data.title.trim(),
      content: data.content.trim(),
      agent_id: data.scope === 'agent' ? data.agent_id || currentAgent.id : null,
    })
    .select()
    .single();

  if (error) throw userError(error.message);
  return { success: true, cannedResponse: inserted as CannedResponse };
}

export async function updateCannedResponseAction(
  workspaceId: string,
  id: string,
  data: {
    shortcut?: string;
    title?: string;
    content?: string;
    scope?: 'team' | 'agent';
    agent_id?: string | null;
  }
) {
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  let formattedShortcut = data.shortcut?.trim();
  if (formattedShortcut && !formattedShortcut.startsWith('/')) {
    formattedShortcut = `/${formattedShortcut}`;
  }

  const updatePayload: any = {};
  if (formattedShortcut) updatePayload.shortcut = formattedShortcut;
  if (data.title) updatePayload.title = data.title.trim();
  if (data.content) updatePayload.content = data.content.trim();
  if (data.scope !== undefined) {
    updatePayload.agent_id = data.scope === 'team' ? null : data.agent_id;
  }

  const { data: updated, error } = await supabase
    .from('canned_responses')
    .update(updatePayload)
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select()
    .maybeSingle();

  if (error) throw userError(error.message);
  if (!updated) throw userError('That saved reply was not found.');
  return { success: true, cannedResponse: updated as CannedResponse };
}

export async function deleteCannedResponseAction(workspaceId: string, id: string) {
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: deleted, error } = await supabase
    .from('canned_responses')
    .delete()
    .eq('id', id)
    .eq('workspace_id', workspaceId)
    .select('id');

  if (error) throw userError(error.message);
  if (!deleted || (Array.isArray(deleted) && deleted.length === 0)) {
    throw userError('That saved reply was not found.');
  }
  return { success: true };
}

/**
 * SECTION 5: Auto-Assignment Rules
 */
export async function updateAutoAssignmentRulesAction(
  workspaceId: string,
  rules: AutoAssignmentConfig
) {
  await assertSettingNotLocked(workspaceId, 'auto_assignment');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({
      auto_assignment: rules,
    })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) throw userError(error.message);
  return { success: true, workspace: updated as Workspace };
}

/**
 * SECTION 7: Claude AI Settings
 */
export async function updateAISettingsAction(
  workspaceId: string,
  settings: AISettingsConfig
): Promise<{ ok: boolean; success: boolean; error?: string; workspace?: Workspace }> {
  try {
    await assertSettingNotLocked(workspaceId, 'ai_settings');
    await assertAdminUser(workspaceId);
    const supabase = await createClient();

    const { data: existing, error: fetchError } = await supabase
      .from('workspaces')
      .select('ai_settings')
      .eq('id', workspaceId)
      .maybeSingle();

    if (fetchError) {
      return { ok: false, success: false, error: fetchError.message };
    }

    const prevAi = (existing?.ai_settings && typeof existing.ai_settings === 'object')
      ? { ...(existing.ai_settings as Record<string, unknown>) }
      : {};
    delete prevAi.api_key;
    delete prevAi.anthropic_api_key;
    delete prevAi.provider;
    delete prevAi.model;
    delete prevAi.base_url;

    const incoming = { ...((settings || {}) as unknown as Record<string, unknown>) };
    delete incoming.api_key;
    delete incoming.anthropic_api_key;
    delete incoming.provider;
    delete incoming.model;
    delete incoming.base_url;

    const finalSettings = {
      ...prevAi,
      ...incoming,
    } as unknown as AISettingsConfig;

    const { data: updated, error } = await supabase
      .from('workspaces')
      .update({
        ai_settings: finalSettings,
      })
      .eq('id', workspaceId)
      .select()
      .maybeSingle();

    if (error) {
      return { ok: false, success: false, error: error.message };
    }

    if (!updated) {
      return { ok: false, success: false, error: 'Workspace not found or update not permitted.' };
    }

    try {
      const adminClient = serviceClient();
      await adminClient
        .from('workspace_integrations')
        .update({
          langgraph_enabled: finalSettings.enabled,
          langgraph_auto_pilot: finalSettings.auto_pilot ?? finalSettings.auto_response_enabled,
          langgraph_system_prompt: finalSettings.system_prompt || null,
        })
        .eq('workspace_id', workspaceId);
    } catch (syncErr) {
      console.warn('[updateAISettingsAction] Non-fatal integrations sync error:', syncErr);
    }

    return { ok: true, success: true, workspace: updated as Workspace };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Failed to save AI settings.';
    return { ok: false, success: false, error: msg };
  }
}

/**
 * SECTION 8: Help Center Branding & Appearance
 */
export async function updateHelpCenterBrandingAction(
  workspaceId: string,
  data: {
    help_center_title?: string | null;
    help_center_subtitle?: string | null;
    help_center_logo_url?: string | null;
    help_center_header_links?: Array<{ label: string; url: string; target?: string }>;
    help_center_footer_text?: string | null;
    help_center_layout?: 'grid-2' | 'grid-3' | 'grid-4' | 'list' | null;
  }
) {
  await assertSettingNotLocked(workspaceId, 'help_center');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const updatePayload: Record<string, any> = {};
  if (data.help_center_title !== undefined) {
    updatePayload.help_center_title = data.help_center_title ? data.help_center_title.trim() : null;
  }
  if (data.help_center_subtitle !== undefined) {
    updatePayload.help_center_subtitle = data.help_center_subtitle ? data.help_center_subtitle.trim() : null;
  }
  if (data.help_center_logo_url !== undefined) {
    updatePayload.help_center_logo_url = data.help_center_logo_url ? data.help_center_logo_url.trim() : null;
  }
  if (data.help_center_header_links !== undefined) {
    updatePayload.help_center_header_links = data.help_center_header_links;
  }
  if (data.help_center_footer_text !== undefined) {
    updatePayload.help_center_footer_text = data.help_center_footer_text ? data.help_center_footer_text.trim() : null;
  }
  if (data.help_center_layout !== undefined) {
    updatePayload.help_center_layout = data.help_center_layout || 'grid-2';
  }

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update(updatePayload)
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) throw userError(error.message);
  refreshHelpCenter(workspaceId);
  return { success: true, workspace: updated as Workspace };
}

/**
 * Help center design (Settings → Help Center → Design). Cleaned to known keys
 * and valid values first, so the public page never meets a value it does not
 * understand.
 */
export async function updateHelpCenterThemeAction(workspaceId: string, theme: unknown) {
  await assertSettingNotLocked(workspaceId, 'help_center');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({ help_center_theme: cleanHelpTheme(theme) })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) {
    console.error('[Help Center Theme]:', error);
    throw userError(
      /help_center_theme/.test(error.message)
        ? 'The help center design could not be saved yet: its database update has not been applied.'
        : error.message
    );
  }
  refreshHelpCenter(workspaceId);
  return { success: true, workspace: updated as Workspace };
}

/**
 * SECTION 8: Zero-Code Navbar Trigger Button
 */
export async function updateNavbarTriggerConfigAction(
  workspaceId: string,
  config: NavbarTriggerConfig
) {
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({
      navbar_trigger_config: config,
    })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) throw userError(error.message);
  return { success: true, workspace: updated as Workspace };
}

/**
 * Settings → Chat widget → Pre-chat form. Stored inside navbar_trigger_config
 * (merged, so the widget's other settings stay), which the widget already
 * reads; fn_set_conversation_topic reads the topics from the same place.
 */
export async function updatePrechatAction(workspaceId: string, prechat: unknown) {
  await assertSettingNotLocked(workspaceId, 'widget_appearance');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();
  const clean = normalizePrechat(prechat);

  const { data: current, error: readError } = await supabase
    .from('workspaces')
    .select('navbar_trigger_config')
    .eq('id', workspaceId)
    .single();
  if (readError) throw userError(readError.message);

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({ navbar_trigger_config: { ...((current?.navbar_trigger_config as Record<string, unknown>) || {}), prechat: clean } })
    .eq('id', workspaceId)
    .select()
    .single();
  if (error) throw userError(error.message);
  return { success: true, workspace: updated as Workspace, prechat: clean };
}

export async function dismissNavbarPromptAction(workspaceId: string) {
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: ws } = await supabase
    .from('workspaces')
    .select('navbar_trigger_config')
    .eq('id', workspaceId)
    .single();

  const current = (ws?.navbar_trigger_config || {}) as NavbarTriggerConfig;
  const updatedConfig: NavbarTriggerConfig = {
    ...current,
    dismissed_prompt: true,
  };

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({
      navbar_trigger_config: updatedConfig,
    })
    .eq('id', workspaceId)
    .select()
    .single();

  if (error) throw userError(error.message);
  return { success: true, workspace: updated as Workspace };
}

/**
 * SECTION 9: Hostinger / Custom SMTP Settings & 5-minute unread email alerts
 */
export async function updateSMTPSettingsAction(
  workspaceId: string,
  settings: SMTPSettingsConfig
) {
  await assertSettingNotLocked(workspaceId, 'smtp_settings');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const sanitized: SMTPSettingsConfig = {
    ...settings,
    host: (settings.host || '').trim(),
    port: Number(settings.port) || 465,
    user: (settings.user || '').trim(),
    pass: settings.pass || '',
    from_name: (settings.from_name || '').trim(),
    from_email: (settings.from_email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(settings.from_email.trim()))
      ? settings.from_email.trim()
      : (settings.user || '').trim(),
    secure: settings.secure !== undefined ? settings.secure : Number(settings.port) === 465,
    unread_threshold_minutes: Number(settings.unread_threshold_minutes) || 5,
  };

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({
      smtp_settings: sanitized,
    })
    .eq('id', workspaceId)
    .select()
    .single();
  if (error) throw userError(error.message);
  return { success: true, workspace: updated as Workspace };
}

/**
 * Disconnects the workspace's mail server: the settings and the stored
 * password both go. Mail that needs it (customer reply alerts, team invites
 * and alerts, ticket replies by email) then stops until SMTP is set up again;
 * invitations can still be shared as a link.
 */
export async function removeSMTPSettingsAction(workspaceId: string) {
  await assertSettingNotLocked(workspaceId, 'smtp_settings');
  await assertAdminUser(workspaceId);
  const supabase = await createClient();

  const { data: updated, error } = await supabase
    .from('workspaces')
    .update({ smtp_settings: null })
    .eq('id', workspaceId)
    .select()
    .single();
  if (error) throw userError(error.message);

  // The password lives in workspace_secrets (service role only). Before that
  // migration has run the table does not exist, which is fine: the password
  // was inside smtp_settings and is already gone.
  const { error: secretError } = await serviceClient().from('workspace_secrets').delete().eq('workspace_id', workspaceId);
  if (secretError && secretError.code !== '42P01' && secretError.code !== 'PGRST205') {
    console.error('[SMTP Remove] Could not delete the stored password:', secretError.message);
    throw userError('The settings were removed, but the saved password could not be deleted. Try again.');
  }

  return { success: true, workspace: updated as Workspace };
}

/**
 * SECTION 10: Create Workspace & Link Agent
 */
export async function createWorkspaceAction(input: {
  businessName: string;
  websiteUrl?: string | null;
  brandColor: string;
  greetingTitle: string;
  greetingMessage: string;
  slug: string;
  industry?: string | null;
  customDomain?: string | null;
  verificationToken?: string | null;
}) {
  const supabase = await createClient();
  const {
    data: { user },
    error: authErr,
  } = await supabase.auth.getUser();

  if (authErr || !user) {
    throw userError('Unauthorized: Authentication required.');
  }

  // Require email verification before the workspace becomes active
  const isEmailConfirmed = Boolean(user.email_confirmed_at || (user as any).confirmed_at);
  if (!isEmailConfirmed) {
    throw userError('Email verification required: Please verify your email address before creating or activating a workspace.');
  }

  // 1. Generate clean, unique slug from workspace name
  const slug = await generateUniqueWorkspaceSlug(
    supabase,
    input.slug || input.businessName
  );

  const industry = input.industry?.toLowerCase()?.trim() || 'generic';
  const preset = getIndustryPreset(industry);

  // 2. Insert Workspace
  const { data: ws, error: wsError } = await supabase
    .from('workspaces')
    .insert({
      name: input.businessName,
      website_url: input.websiteUrl || null,
      brand_color: input.brandColor,
      greeting_title: input.greetingTitle || preset.greetingTitle,
      greeting_message: input.greetingMessage || preset.greetingPlaceholder,
      owner_id: user.id,
      slug,
      slug_changes_count: 0,
      slug_changed_at: null,
      custom_domain: input.customDomain || null,
      custom_domain_status: input.customDomain ? 'pending' : null,
      custom_domain_verification_token: input.customDomain ? input.verificationToken : null,
      industry,
    })
    .select()
    .single();

  if (wsError || !ws) {
    throw userError(wsError?.message || 'Failed to create workspace.');
  }

  // 3. Link current agent to workspace
  await supabase
    .from('agents')
    .upsert({
      id: user.id,
      name: user.user_metadata?.name || user.email?.split('@')[0] || 'Owner',
      email: user.email || '',
      workspace_id: ws.id,
      role: 'owner',
      status: 'online',
    });

  // 4. Seed two generic saved replies (greeting, "we're checking")
  await supabase.from('canned_responses').insert([
    {
      workspace_id: ws.id,
      title: 'Greeting',
      shortcut: 'hello',
      content: 'Hi there! Thanks for reaching out. How can I help you today?',
    },
    {
      workspace_id: ws.id,
      title: "We're checking",
      shortcut: 'checking',
      content: "Thanks for your patience! I'm looking into this for you right now and will update you shortly.",
    },
  ]);

  // 5. Seed industry first help section & 3 article blueprints
  try {
    const { data: section } = await supabase
      .from('help_sections')
      .insert({
        workspace_id: ws.id,
        name: preset.sectionName,
        slug: preset.sectionSlug,
        icon: preset.icon,
        description: preset.sectionDescription,
        order_index: 1,
      })
      .select('id')
      .maybeSingle();

    if (section?.id && preset.articles?.length) {
      const articleInserts = preset.articles.map((art, idx) => ({
        workspace_id: ws.id,
        section_id: section.id,
        title: art.title,
        slug: art.slug,
        category: preset.sectionName,
        summary: art.summary,
        content: art.content,
        status: 'published',
        author_id: user.id,
        views_count: 0,
        order_index: idx + 1,
      }));

      await supabase.from('articles').insert(articleInserts);
    }
  } catch (seedErr) {
    console.warn('Could not seed help blueprints:', seedErr);
  }

  // 6. Initialize default plan trial subscription (Safety Requirement 10)
  try {
    const adminClient = serviceClient();
    const { data: defaultPlan } = await adminClient
      .from('platform_plans')
      .select('id, slug, trial_days, version')
      .eq('is_default', true)
      .limit(1)
      .maybeSingle();

    if (defaultPlan) {
      const trialDays = defaultPlan.trial_days || 14;
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + trialDays * 24 * 60 * 60 * 1000).toISOString();
      const periodEnd = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString();

      await adminClient.from('workspace_subscriptions').insert({
        workspace_id: ws.id,
        plan_id: defaultPlan.id,
        plan_version: defaultPlan.version,
        status: 'trialing',
        billing_period: 'monthly',
        current_period_start: now.toISOString(),
        current_period_end: periodEnd,
        trial_ends_at: trialEndsAt,
        admin_note: 'Initial 14-day trial of Starter plan.',
      });

      await adminClient.from('workspaces').update({ plan: defaultPlan.slug }).eq('id', ws.id);
      ws.plan = defaultPlan.slug;
    }
  } catch (subErr) {
    console.warn('[Workspace Subscription Init Warning]:', subErr);
  }

  return { success: true, workspace: ws as Workspace };
}



