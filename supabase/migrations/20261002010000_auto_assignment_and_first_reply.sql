-- ============================================================================
-- Auto-Assignment on Conversation Creation & Auto-Assign on First Agent Reply
-- ============================================================================

-- 1. Function and Trigger for Round-Robin Auto-Assignment on Conversation Creation
CREATE OR REPLACE FUNCTION public.fn_auto_assign_conversation_on_create()
RETURNS TRIGGER AS $$
DECLARE
  v_auto_assign jsonb;
  v_enabled boolean;
  v_chosen_agent_id uuid;
BEGIN
  -- If conversation already has an assigned agent, do not overwrite
  IF NEW.assigned_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  -- If workspace_id is null, attempt to infer from visitor
  IF NEW.workspace_id IS NULL AND NEW.visitor_id IS NOT NULL THEN
    SELECT workspace_id INTO NEW.workspace_id FROM public.visitors WHERE id = NEW.visitor_id;
  END IF;

  IF NEW.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- Check workspace auto-assignment setting
  SELECT auto_assignment INTO v_auto_assign
  FROM public.workspaces
  WHERE id = NEW.workspace_id;

  v_enabled := COALESCE((v_auto_assign->>'enabled')::boolean, true);

  IF NOT v_enabled THEN
    RETURN NEW;
  END IF;

  -- Only assign if at least one agent is online in this workspace:
  -- Pick the online agent with the fewest active/open conversations (round-robin / load balance)
  SELECT a.id INTO v_chosen_agent_id
  FROM public.agents a
  LEFT JOIN public.conversations c ON c.assigned_agent_id = a.id AND c.status = 'open'
  WHERE a.workspace_id = NEW.workspace_id
    AND a.status = 'online'
  GROUP BY a.id, a.created_at
  ORDER BY count(c.id) ASC, a.created_at ASC
  LIMIT 1;

  IF v_chosen_agent_id IS NOT NULL THEN
    NEW.assigned_agent_id := v_chosen_agent_id;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_auto_assign_conversation_on_create
  BEFORE INSERT ON public.conversations
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_auto_assign_conversation_on_create();

-- 2. Update handle_new_message to automatically assign unassigned conversation to replying agent
CREATE OR REPLACE FUNCTION public.handle_new_message()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sender_type = 'agent' AND (NEW.is_internal IS FALSE OR NEW.is_internal IS NULL) AND NEW.sender_id IS NOT NULL THEN
    UPDATE public.conversations
    SET 
      updated_at = NEW.created_at,
      assigned_agent_id = COALESCE(assigned_agent_id, NEW.sender_id)
    WHERE id = NEW.conversation_id;
  ELSIF NEW.sender_type = 'visitor' THEN
    UPDATE public.conversations
    SET 
      updated_at = NEW.created_at,
      status = 'open',
      closed_at = NULL,
      snoozed_until = NULL
    WHERE id = NEW.conversation_id;
  ELSE
    UPDATE public.conversations
    SET updated_at = NEW.created_at
    WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 3. Backfill assignee for existing open conversations using the agent who sent the most recent human reply
WITH latest_agent_replies AS (
  SELECT DISTINCT ON (conversation_id)
    conversation_id,
    sender_id AS agent_id
  FROM public.messages
  WHERE sender_type = 'agent'
    AND is_internal = false
    AND sender_id IS NOT NULL
  ORDER BY conversation_id, created_at DESC
)
UPDATE public.conversations c
SET assigned_agent_id = lar.agent_id
FROM latest_agent_replies lar
WHERE c.id = lar.conversation_id
  AND c.status = 'open'
  AND c.assigned_agent_id IS NULL;
