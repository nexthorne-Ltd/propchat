-- Migration: Visitor conversation history for the widget Home tab
-- Returns a visitor's recent conversations (visible messages only) so the
-- widget can list them and let the visitor reopen one.

CREATE OR REPLACE FUNCTION public.fn_get_visitor_conversations(p_visitor_id uuid, p_workspace_id uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
declare
  v_result jsonb;
begin
  select coalesce(jsonb_agg(conv_row), '[]'::jsonb) into v_result
  from (
    select
      c.id, c.status, c.created_at, c.updated_at, c.workspace_id, c.csat_rating,
      (select jsonb_build_object('id', m.id, 'content', m.content, 'sender_type', m.sender_type, 'created_at', m.created_at, 'attachment_url', m.attachment_url)
         from public.messages m
        where m.conversation_id = c.id and (m.is_internal is null or m.is_internal = false)
        order by m.created_at desc limit 1) as last_message,
      (select count(*) from public.messages m
        where m.conversation_id = c.id and (m.is_internal is null or m.is_internal = false)
          and m.sender_type != 'visitor' and m.read_at is null) as unread_count
    from public.conversations c
    where c.visitor_id = p_visitor_id
      and (p_workspace_id is null or c.workspace_id = p_workspace_id)
    order by c.updated_at desc
    limit 20
  ) conv_row;
  return v_result;
end;
$$;

GRANT EXECUTE ON FUNCTION public.fn_get_visitor_conversations(uuid, uuid) TO anon, authenticated, service_role;
