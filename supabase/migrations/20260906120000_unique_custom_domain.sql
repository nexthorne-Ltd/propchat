-- ============================================================================
-- One hostname, one workspace
--
-- Host-based routing resolves a request's Host header to a single workspace
-- row. Nothing stopped two workspaces from storing the same custom_domain —
-- onboarding claimed `help.<website>` with no uniqueness check at all — and
-- once that happened the lookup was ambiguous: the help centre served whichever
-- row came back first, or errored.
--
-- Onboarding and the Settings action both check for a clash now. This makes the
-- database the guarantee rather than the application, so the two cannot drift.
-- ============================================================================

-- Any pre-existing duplicates: keep the workspace that connected the domain
-- first and release it from the others, so they can connect a different one.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY lower(custom_domain)
           ORDER BY created_at, id
         ) AS rn
    FROM public.workspaces
   WHERE custom_domain IS NOT NULL
     AND custom_domain <> ''
)
UPDATE public.workspaces w
   SET custom_domain = NULL,
       custom_domain_status = NULL,
       custom_domain_verified_at = NULL,
       custom_domain_verification_token = NULL
  FROM ranked r
 WHERE w.id = r.id
   AND r.rn > 1;

-- Empty strings are not a domain; normalise them away so the index below does
-- not treat them as a claimed hostname.
UPDATE public.workspaces
   SET custom_domain = NULL
 WHERE custom_domain = '';

CREATE UNIQUE INDEX IF NOT EXISTS workspaces_custom_domain_unique
    ON public.workspaces (lower(custom_domain))
 WHERE custom_domain IS NOT NULL;
