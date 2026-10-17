-- Migration: 20260904120000_workspace_domains.sql
-- Add custom domain and per-workspace routing fields to workspaces

ALTER TABLE public.workspaces
ADD COLUMN IF NOT EXISTS slug text,
ADD COLUMN IF NOT EXISTS custom_domain text,
ADD COLUMN IF NOT EXISTS custom_domain_status text DEFAULT 'pending',
ADD COLUMN IF NOT EXISTS custom_domain_verified_at timestamptz,
ADD COLUMN IF NOT EXISTS custom_domain_verification_token text;

-- Populate slug and verification tokens for existing workspaces
DO $$
DECLARE
    r RECORD;
    new_slug text;
    base_slug text;
    i int;
BEGIN
    FOR r IN SELECT id, name, website_url FROM public.workspaces LOOP
        -- Generate clean base slug from name or website
        base_slug := lower(regexp_replace(coalesce(r.name, 'workspace'), '[^a-zA-Z0-9]+', '-', 'g'));
        base_slug := trim(both '-' from base_slug);
        IF base_slug = '' THEN
            base_slug := 'workspace';
        END IF;

        new_slug := base_slug;
        i := 1;
        WHILE EXISTS (SELECT 1 FROM public.workspaces WHERE slug = new_slug AND id <> r.id) LOOP
            new_slug := base_slug || '-' || i;
            i := i + 1;
        END LOOP;

        UPDATE public.workspaces
        SET slug = coalesce(slug, new_slug),
            custom_domain_verification_token = coalesce(custom_domain_verification_token, 'chatify_tok_' || substr(md5(random()::text || r.id::text), 1, 16)),
            custom_domain_status = coalesce(custom_domain_status, 'pending')
        WHERE id = r.id;
    END LOOP;
END $$;

-- Add unique constraints/indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_slug ON public.workspaces (slug);
CREATE UNIQUE INDEX IF NOT EXISTS idx_workspaces_custom_domain ON public.workspaces (lower(custom_domain)) WHERE custom_domain IS NOT NULL;
