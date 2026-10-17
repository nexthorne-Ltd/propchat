-- ============================================================================
-- Visitor local time & language
--
-- The agent panel wants to show the visitor's own wall-clock time ("2:16pm
-- (Asia/Kolkata)") and their browser language. Neither can be derived safely
-- from what we already store: `location` holds either "City, Country" from the
-- IP lookup OR the IANA timezone when that lookup is blocked, never both, and
-- guessing a zone from a country name is wrong for the US, Russia, Australia
-- and Brazil.
--
-- This migration is purely additive. It does not touch fn_upsert_visitor, so
-- the existing widget flow keeps working untouched whether or not this runs.
-- ============================================================================

ALTER TABLE public.visitors
  ADD COLUMN IF NOT EXISTS timezone TEXT,
  ADD COLUMN IF NOT EXISTS language TEXT;

-- Written straight after the main upsert rather than folded into it: the
-- existing fn_upsert_visitor is overloaded, and adding parameters to it would
-- make PostgREST unable to choose a candidate.
CREATE OR REPLACE FUNCTION public.fn_update_visitor_meta(
  p_id UUID,
  p_timezone TEXT DEFAULT NULL,
  p_language TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.visitors
     SET timezone = COALESCE(NULLIF(p_timezone, ''), timezone),
         language = COALESCE(NULLIF(p_language, ''), language)
   WHERE id = p_id;
$$;

GRANT EXECUTE ON FUNCTION public.fn_update_visitor_meta(UUID, TEXT, TEXT)
  TO anon, authenticated;
