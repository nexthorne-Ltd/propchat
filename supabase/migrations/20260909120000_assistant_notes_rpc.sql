-- ============================================================================
-- Let the assistant read the notes it is allowed to read — and only those
--
-- knowledge_notes is behind row level security, so the widget's anonymous
-- session cannot read it. That is correct for the table, but it also meant the
-- assistant could not see the notes a team had explicitly marked "assistant can
-- use it": the feature was configured, and silently did nothing.
--
-- Rather than hand the assistant a service-role key — which would give it every
-- note, including the agent-only ones, and leave the privacy boundary resting
-- on application code remembering to filter — this exposes exactly the allowed
-- subset and nothing else. An agent-only note is unreachable through this
-- function no matter what the caller asks for.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_assistant_notes(p_workspace_id UUID)
RETURNS TABLE (id UUID, title TEXT, content TEXT, tags TEXT[])
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT n.id, n.title, n.content, n.tags
    FROM public.knowledge_notes n
   WHERE n.workspace_id = p_workspace_id
     -- The whole point of the function. Not a parameter, not overridable.
     AND n.visibility = 'assistant';
$$;

GRANT EXECUTE ON FUNCTION public.fn_assistant_notes(UUID)
  TO anon, authenticated, service_role;

COMMENT ON FUNCTION public.fn_assistant_notes(UUID) IS
  'Notes a workspace has cleared for customer-facing answers. Agent-only notes are never returned.';
