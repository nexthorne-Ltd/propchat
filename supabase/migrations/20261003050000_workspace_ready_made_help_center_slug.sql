-- Migration: 20261003050000_workspace_ready_made_help_center_slug.sql
-- Description: Add slug_changes_count and slug_changed_at to workspaces table and expose in public_workspaces view

ALTER TABLE public.workspaces 
ADD COLUMN IF NOT EXISTS slug_changes_count integer DEFAULT 0;

ALTER TABLE public.workspaces 
ADD COLUMN IF NOT EXISTS slug_changed_at timestamp with time zone;

-- Update public_workspaces view to include slug_changes_count
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
    business_hours,
    slug_changes_count
FROM public.workspaces;

GRANT SELECT ON public.public_workspaces TO public, authenticated, anon, service_role;
