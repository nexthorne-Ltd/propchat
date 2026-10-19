-- ============================================================================
-- Migration: 20261109090000_widget_handover_metadata.sql
-- Description: Allow handover metadata and quick reply chips through fn_widget_message_json
-- ============================================================================

CREATE OR REPLACE FUNCTION public.fn_widget_message_json(p_message public.messages)
RETURNS JSONB
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH m AS (SELECT to_jsonb(p_message) AS j)
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
      'sender_name', j #> '{metadata,sender_name}',
      'sender_avatar', j #> '{metadata,sender_avatar}',
      'translation', CASE WHEN j #> '{metadata,translation,translated_text}' IS NULL THEN NULL
                          ELSE jsonb_build_object('translated_text', j #> '{metadata,translation,translated_text}') END
    ))
  )
  FROM m
$$;

REVOKE EXECUTE ON FUNCTION public.fn_widget_message_json(public.messages) FROM PUBLIC, anon, authenticated;
