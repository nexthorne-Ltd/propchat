-- ============================================================================
-- Who answers a conversation: the bot or a person, decided by the database
--
-- The bot's on/off switch lived in three places that disagreed:
--
--   * The old inbox switched the bot off in the browser after an agent's
--     reply. The ticket screens, server actions and channel replies did not,
--     so after a reply there the bot kept answering on top of the agent.
--   * /api/ai/auto-respond switched a paused bot back on by itself after
--     20 minutes of quiet, so "turn the bot off" did not stay off.
--   * The reply was inserted after up to 35 seconds of generation, checked
--     only by a few reads beforehand. An agent who replied or paused the bot
--     during those seconds was answered over anyway.
--
-- Now:
--
--   * ai_control_version goes up on every change of who answers: the switch,
--     and every public reply from a person. The auto-responder reads it before
--     generating and fn_deliver_ai_reply refuses the reply if it moved, with
--     the conversation row locked so the check and the insert are one step.
--     A reply that was being written when control changed is never sent.
--   * A person's public reply hands the conversation to people
--     (ai_paused_reason = 'human_reply'), whoever wrote it and wherever.
--   * Only a person (or a resolution, as before) turns the bot back on. The
--     widget runs as anon, which may still update conversations (AUDIT H-3),
--     so anon cannot touch the switch at all.
--   * ai_reply_events records why the bot did or did not answer, for the
--     team to read when "the bot didn't reply" comes up.
--
-- Conversation states (derived in src/lib/ai/bot-control.ts):
--   ai_active        ai_mode autopilot/copilot
--   ai_resuming      switched back on, the bot has not answered since
--   needs_attention  bot still on, but it handed a question to the team
--   human_handling   disabled, ai_paused_reason human_reply
--   ai_paused        disabled, ai_paused_reason agent_paused / system
--   human_requested  disabled, ai_paused_reason human_requested
-- ============================================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS ai_control_version BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ai_paused_reason TEXT,
  ADD COLUMN IF NOT EXISTS ai_control_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_resumed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS ai_needs_attention_at TIMESTAMPTZ;

ALTER TABLE public.conversations DROP CONSTRAINT IF EXISTS conversations_ai_paused_reason_check;
ALTER TABLE public.conversations ADD CONSTRAINT conversations_ai_paused_reason_check
  CHECK (ai_paused_reason IS NULL OR ai_paused_reason IN ('human_reply', 'agent_paused', 'human_requested', 'needs_attention', 'system'));

-- Rows paused before this migration: a person replied (the old inbox wrote
-- last_human_reply_at) or someone flipped the switch.
UPDATE public.conversations
   SET ai_paused_reason = CASE WHEN channel_metadata ? 'last_human_reply_at' THEN 'human_reply' ELSE 'agent_paused' END
 WHERE ai_mode = 'disabled'
   AND ai_paused_reason IS NULL;

-- ----------------------------------------------------------------------------
-- 1. The widget cannot flip the switch
--
-- Named to run before trg_conversation_resolution_bookkeeping (triggers fire
-- in name order), which may itself switch the bot on when a visitor reopens
-- a resolved conversation; that change must stand.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_guard_anon_ai_mode()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF coalesce(auth.role(), '') = 'anon' AND pg_trigger_depth() <= 1 THEN
    NEW.ai_mode := OLD.ai_mode;
    NEW.ai_paused_reason := OLD.ai_paused_reason;
    NEW.ai_control_version := OLD.ai_control_version;
    NEW.ai_control_changed_at := OLD.ai_control_changed_at;
    NEW.ai_resumed_at := OLD.ai_resumed_at;
    NEW.ai_needs_attention_at := OLD.ai_needs_attention_at;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_aa_guard_anon_ai_mode ON public.conversations;
CREATE TRIGGER trg_aa_guard_anon_ai_mode
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_anon_ai_mode();

-- ----------------------------------------------------------------------------
-- 2. Every change of the switch is versioned and explained
--
-- Runs last among the BEFORE triggers, so it sees the resolution trigger's
-- change too. A writer that names a reason (the bot handing over, the
-- human-reply trigger) keeps it; a person flipping the switch is
-- 'agent_paused'.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_conversation_ai_control()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.ai_mode IS DISTINCT FROM OLD.ai_mode THEN
    IF NEW.ai_control_version = OLD.ai_control_version THEN
      NEW.ai_control_version := OLD.ai_control_version + 1;
    END IF;
    NEW.ai_control_changed_at := now();
    IF NEW.ai_mode = 'disabled' THEN
      IF NEW.ai_paused_reason IS NULL OR NEW.ai_paused_reason IS NOT DISTINCT FROM OLD.ai_paused_reason THEN
        NEW.ai_paused_reason := CASE WHEN public.fn_is_direct_user_write() THEN 'agent_paused' ELSE 'system' END;
      END IF;
    ELSE
      NEW.ai_paused_reason := NULL;
      NEW.ai_resumed_at := now();
      NEW.ai_needs_attention_at := NULL;
    END IF;
  ELSIF NEW.ai_mode = 'disabled' AND NEW.ai_paused_reason IS DISTINCT FROM OLD.ai_paused_reason
        AND NEW.ai_control_version = OLD.ai_control_version THEN
    NEW.ai_control_version := OLD.ai_control_version + 1;
    NEW.ai_control_changed_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_zz_conversation_ai_control ON public.conversations;
CREATE TRIGGER trg_zz_conversation_ai_control
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.fn_conversation_ai_control();

-- ----------------------------------------------------------------------------
-- 3. A person's public reply takes the conversation over
--
-- Whoever wrote it and from wherever: old inbox, ticket screen, server action,
-- channel. The welcome line the widget writes has no sender and is not a
-- person. The version goes up even when the bot was already off, so a reply
-- generated before this message cannot be delivered after it.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_human_reply_takes_over()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.sender_type = 'agent'
     AND NEW.sender_id IS NOT NULL
     AND NOT coalesce(NEW.is_internal, false)
     AND coalesce(NEW.metadata ->> 'is_welcome', '') <> 'true' THEN
    UPDATE public.conversations
       SET ai_mode = 'disabled',
           ai_paused_reason = 'human_reply',
           ai_control_version = ai_control_version + 1,
           ai_control_changed_at = now(),
           ai_needs_attention_at = NULL,
           channel_metadata = coalesce(channel_metadata, '{}'::jsonb)
             || jsonb_build_object('last_human_reply_at', to_jsonb(coalesce(NEW.created_at, now())))
     WHERE id = NEW.conversation_id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_human_reply_takes_over() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_human_reply_takes_over ON public.messages;
CREATE TRIGGER trg_human_reply_takes_over
  AFTER INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.fn_human_reply_takes_over();

-- ----------------------------------------------------------------------------
-- 4. Why the bot did or did not answer
--
-- Concise decisions only: no message text, no model reasoning. Written by
-- server code (service role) and fn_deliver_ai_reply; readable by the
-- workspace's own team.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.ai_reply_events (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  workspace_id UUID NOT NULL REFERENCES public.workspaces(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  visitor_message_id UUID,
  event TEXT NOT NULL,
  reason TEXT,
  detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ai_reply_events_conversation
  ON public.ai_reply_events (conversation_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_reply_events_workspace
  ON public.ai_reply_events (workspace_id, created_at DESC);

ALTER TABLE public.ai_reply_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Workspace members read bot decisions" ON public.ai_reply_events;
CREATE POLICY "Workspace members read bot decisions" ON public.ai_reply_events
  FOR SELECT TO authenticated
  USING (workspace_id IN (SELECT public.current_user_workspace_ids()));

REVOKE ALL ON public.ai_reply_events FROM anon;
REVOKE INSERT, UPDATE, DELETE ON public.ai_reply_events FROM authenticated;
GRANT SELECT ON public.ai_reply_events TO authenticated;
GRANT ALL ON public.ai_reply_events TO service_role;

-- ----------------------------------------------------------------------------
-- 5. Delivering a bot reply
--
-- The last check before a visitor sees anything, with the conversation row
-- locked so a person's reply or a flip of the switch cannot slip in between
-- the check and the insert (both of those update this row, so they wait for
-- us or we wait for them). Refuses when:
--
--   conversation_closed  someone closed it while the reply was written
--   ai_<reason>          the bot is off (human_reply, agent_paused, ...)
--   control_changed      who answers changed since generation started
--   human_replied        a person answered this visitor message already
--   already_answered     a retry, or another worker, got there first
--   superseded           the visitor wrote again; that run answers both
--
-- p_expected_version is the conversation's ai_control_version when
-- generation started; NULL skips only that check.
--
-- Service role only. The unique index from 20261002000000 still backs up the
-- already_answered check.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_deliver_ai_reply(
  p_conversation_id UUID,
  p_visitor_message_id UUID,
  p_expected_version BIGINT,
  p_content TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_conv public.conversations%ROWTYPE;
  v_visitor_at TIMESTAMPTZ;
  v_reason TEXT;
  v_message public.messages%ROWTYPE;
BEGIN
  SELECT * INTO v_conv FROM public.conversations WHERE id = p_conversation_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('delivered', false, 'reason', 'conversation_not_found');
  END IF;

  SELECT created_at INTO v_visitor_at
    FROM public.messages
   WHERE id = p_visitor_message_id
     AND conversation_id = p_conversation_id
     AND sender_type = 'visitor';
  IF NOT FOUND THEN
    v_reason := 'visitor_message_not_found';
  ELSIF coalesce(trim(p_content), '') = '' THEN
    v_reason := 'empty_reply';
  ELSIF v_conv.status = 'closed' THEN
    v_reason := 'conversation_closed';
  ELSIF v_conv.ai_mode = 'disabled' THEN
    v_reason := 'ai_' || coalesce(v_conv.ai_paused_reason, 'paused');
  ELSIF p_expected_version IS NOT NULL AND v_conv.ai_control_version <> p_expected_version THEN
    v_reason := 'control_changed';
  ELSIF EXISTS (
    SELECT 1 FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND sender_type = 'agent' AND sender_id IS NOT NULL AND NOT coalesce(is_internal, false)
       AND created_at >= v_visitor_at
  ) THEN
    v_reason := 'human_replied';
  ELSIF EXISTS (
    SELECT 1 FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND sender_type = 'ai' AND NOT coalesce(is_internal, false)
       AND (reply_to_message_id = p_visitor_message_id
            OR metadata ->> 'answered_message_id' = p_visitor_message_id::text)
  ) THEN
    v_reason := 'already_answered';
  ELSIF EXISTS (
    SELECT 1 FROM public.messages
     WHERE conversation_id = p_conversation_id
       AND sender_type = 'visitor' AND NOT coalesce(is_internal, false)
       AND id <> p_visitor_message_id
       AND created_at > v_visitor_at
  ) THEN
    v_reason := 'superseded';
  END IF;

  IF v_reason IS NOT NULL THEN
    IF v_conv.workspace_id IS NOT NULL THEN
      INSERT INTO public.ai_reply_events (workspace_id, conversation_id, visitor_message_id, event, reason, detail)
      VALUES (v_conv.workspace_id, p_conversation_id, p_visitor_message_id, 'reply_suppressed', v_reason,
              jsonb_build_object('expected_version', p_expected_version, 'current_version', v_conv.ai_control_version));
    END IF;
    RETURN jsonb_build_object('delivered', false, 'reason', v_reason);
  END IF;

  BEGIN
    INSERT INTO public.messages (conversation_id, sender_type, sender_id, content, is_internal, reply_to_message_id, metadata)
    VALUES (p_conversation_id, 'ai', NULL, p_content, false, p_visitor_message_id, coalesce(p_metadata, '{}'::jsonb))
    RETURNING * INTO v_message;
  EXCEPTION WHEN unique_violation THEN
    RETURN jsonb_build_object('delivered', false, 'reason', 'already_answered');
  END;

  IF v_conv.workspace_id IS NOT NULL THEN
    INSERT INTO public.ai_reply_events (workspace_id, conversation_id, visitor_message_id, event, reason, detail)
    VALUES (v_conv.workspace_id, p_conversation_id, p_visitor_message_id, 'reply_delivered', NULL,
            jsonb_build_object('message_id', v_message.id, 'version', v_conv.ai_control_version));
  END IF;

  RETURN jsonb_build_object('delivered', true, 'message', to_jsonb(v_message));
END;
$$;

REVOKE ALL ON FUNCTION public.fn_deliver_ai_reply(UUID, UUID, BIGINT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_deliver_ai_reply(UUID, UUID, BIGINT, TEXT, JSONB) TO service_role;
