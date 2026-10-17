-- Migration: Widget Polish Settings (Offsets, Z-Index, Proactive Welcome)
-- Description: Adds widget placement settings and proactive welcome controls to workspaces

ALTER TABLE public.workspaces
  ADD COLUMN IF NOT EXISTS launcher_offset_bottom integer DEFAULT 20,
  ADD COLUMN IF NOT EXISTS launcher_offset_side integer DEFAULT 20,
  ADD COLUMN IF NOT EXISTS widget_z_index integer DEFAULT 2147483000,
  ADD COLUMN IF NOT EXISTS enable_proactive_welcome boolean DEFAULT true,
  ADD COLUMN IF NOT EXISTS proactive_delay_seconds integer DEFAULT 8;

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
    'launcher_offset_bottom', coalesce(v_ws.launcher_offset_bottom, 20),
    'launcher_offset_side', coalesce(v_ws.launcher_offset_side, 20),
    'widget_z_index', coalesce(v_ws.widget_z_index, 2147483000),
    'enable_proactive_welcome', coalesce(v_ws.enable_proactive_welcome, true),
    'proactive_delay_seconds', coalesce(v_ws.proactive_delay_seconds, 8),
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
