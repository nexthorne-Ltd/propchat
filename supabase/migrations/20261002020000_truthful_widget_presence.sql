-- Migration: 20261002020000_truthful_widget_presence.sql
-- Description: Include agents in fn_get_workspace_config and business_hours in public_workspaces view

-- 1. Add business_hours to public_workspaces view (appended to preserve existing column order)
CREATE OR REPLACE VIEW public.public_workspaces AS
SELECT id,
    name,
    website_url,
    brand_color,
    logo_url,
    widget_position,
    greeting_title,
    greeting_message,
    help_center_tab_label,
    show_help_tab,
    help_center_tab_icon,
    slug,
    custom_domain,
    custom_domain_status,
    help_center_title,
    help_center_subtitle,
    help_center_logo_url,
    help_center_header_links,
    help_center_footer_text,
    created_at,
    help_center_layout,
    business_hours
FROM public.workspaces;

-- 2. Update fn_get_workspace_config to include workspace agents for truthful widget presence and avatar rendering
CREATE OR REPLACE FUNCTION public.fn_get_workspace_config(p_workspace_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_ws public.workspaces;
begin
  select * into v_ws from public.workspaces where id = p_workspace_id;
  if not found then
    return null;
  end if;

  return jsonb_build_object(
    'id', v_ws.id,
    'name', v_ws.name,
    'website_url', v_ws.website_url,
    'brand_color', v_ws.brand_color,
    'logo_url', v_ws.logo_url,
    'show_launcher_logo', coalesce(v_ws.show_launcher_logo, true),
    'widget_position', coalesce(v_ws.widget_position, 'right'),
    'greeting_title', v_ws.greeting_title,
    'greeting_message', v_ws.greeting_message,
    'business_hours', v_ws.business_hours,
    'auto_assignment', v_ws.auto_assignment,
    'help_center_tab_label', coalesce(v_ws.help_center_tab_label, 'Help'),
    'show_help_tab', coalesce(v_ws.show_help_tab, true),
    'help_center_tab_icon', coalesce(v_ws.help_center_tab_icon, '📖'),
    'custom_domain', v_ws.custom_domain,
    'custom_domain_status', v_ws.custom_domain_status,
    'navbar_trigger_config', coalesce(v_ws.navbar_trigger_config, '{"enabled": false, "label": "FAQ", "action": "help", "auto_inject": false, "style": "navbar_link"}'::jsonb),
    'agents', (
      SELECT coalesce(jsonb_agg(jsonb_build_object('id', a.id, 'name', a.name, 'avatar_url', a.avatar_url, 'status', a.status)), '[]'::jsonb)
      FROM public.agents a
      WHERE a.workspace_id = v_ws.id
    )
  );
end;
$$;
