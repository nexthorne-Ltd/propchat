-- ============================================================================
-- Migration: 20261122090000_widget_agent_identity.sql
-- Description: Name the human agent on every agent message the widget reads.
--
-- After a handover the widget shows "Connecting you to the team…" until a
-- person answers, then "<name> joined the conversation" above their first
-- reply (as Intercom and the other professional inboxes do). It can only do
-- that if it knows which person wrote a message. fn_widget_message_json passes
-- metadata.sender_name only when the writer put it there, which the inbox
-- never does, and it never passes sender_id. So the name and photo are read
-- from the agent's row here. Both are already public: fn_get_workspace_config
-- hands the widget the same agents list for the avatar stack.
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_widget_message_json(p_message public.messages)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH m AS (SELECT to_jsonb(p_message) AS j),
       a AS (
         SELECT ag.name, ag.avatar_url
           FROM public.agents ag
          WHERE p_message.sender_type = 'agent'
            AND ag.id = p_message.sender_id
          LIMIT 1
       )
  SELECT jsonb_build_object(
    'id', j -> 'id',
    'conversation_id', j -> 'conversation_id',
    'sender_type', j -> 'sender_type',
    'content', j -> 'content',
    'attachment_url', j -> 'attachment_url',
    'created_at', j -> 'created_at',
    'delivered_at', j -> 'delivered_at',
    'read_at', j -> 'read_at',
    'reply_to_message_id', j -> 'reply_to_message_id',
    'metadata', jsonb_strip_nulls(jsonb_build_object(
      'system_event', j #> '{metadata,system_event}',
      'is_edited', j #> '{metadata,is_edited}',
      'is_welcome', j #> '{metadata,is_welcome}',
      'translated_text', j #> '{metadata,translated_text}',
      'quick_replies', j #> '{metadata,quick_replies}',
      'handover', j #> '{metadata,handover}',
      'assigned_agent_id', j #> '{metadata,assigned_agent_id}',
      'assigned_agent_name', j #> '{metadata,assigned_agent_name}',
      'assigned_agent_avatar', j #> '{metadata,assigned_agent_avatar}',
      'sender_name', coalesce(j #> '{metadata,sender_name}', to_jsonb((SELECT name FROM a))),
      'sender_avatar', coalesce(j #> '{metadata,sender_avatar}', to_jsonb((SELECT avatar_url FROM a))),
      'translation', CASE WHEN j #> '{metadata,translation,translated_text}' IS NULL THEN NULL
                          ELSE jsonb_build_object('translated_text', j #> '{metadata,translation,translated_text}') END
    ))
  )
  FROM m
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_message_json(public.messages) FROM PUBLIC, anon, authenticated;
