-- The bot was only ever asked to reply by the visitor's browser: the widget
-- POSTs /api/ai/auto-respond after saving a message. When that call never
-- arrives (an embed pointing at an old host, a blocked cross-site request,
-- the visitor closing the tab, an ad blocker), the message is saved, nothing
-- is logged in ai_reply_events, and the bot simply never answers. Settings →
-- AI bot → Health check showed exactly that: model fine, zero bot activity.
--
-- This asks for the reply from the database as well, through pg_net, for
-- every public visitor message on a web-chat conversation. The route is
-- already safe to call twice: fn_deliver_ai_reply locks the conversation and
-- refuses a second answer to the same visitor message, so the widget's call
-- and this one can both arrive. Other channels (WhatsApp, email, social, API)
-- already call the route from the server and are left alone.
--
-- It uses the Vault secret 'zentry_app_url' that the cron schedule already
-- reads (20261104090000). Until it is set, nothing is sent and the insert is
-- never blocked: any failure here is logged and swallowed.

CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION public.fn_request_ai_reply()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url TEXT;
  v_conv RECORD;
BEGIN
  SELECT id, workspace_id, channel, channel_metadata
    INTO v_conv
    FROM public.conversations
   WHERE id = NEW.conversation_id;

  IF v_conv.id IS NULL OR v_conv.workspace_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF coalesce(v_conv.channel, 'web') NOT IN ('web', 'chat', 'widget', 'live_chat') THEN
    RETURN NEW;
  END IF;
  IF coalesce(v_conv.channel_metadata ->> 'source', '') = 'api' THEN
    RETURN NEW;
  END IF;

  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'zentry_app_url' LIMIT 1;
  IF coalesce(v_url, '') = '' THEN
    RAISE LOG 'fn_request_ai_reply: vault secret zentry_app_url is not set';
    RETURN NEW;
  END IF;

  PERFORM net.http_post(
    url := rtrim(v_url, '/') || '/api/ai/auto-respond',
    headers := jsonb_build_object('Content-Type', 'application/json'),
    body := jsonb_build_object(
      'conversation_id', NEW.conversation_id,
      'workspace_id', v_conv.workspace_id,
      'message_id', NEW.id
    ),
    timeout_milliseconds := 60000
  );
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE LOG 'fn_request_ai_reply failed for message %: %', NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_request_ai_reply() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_request_ai_reply ON public.messages;
CREATE TRIGGER trg_request_ai_reply
  AFTER INSERT ON public.messages
  FOR EACH ROW
  WHEN (NEW.sender_type = 'visitor' AND NOT coalesce(NEW.is_internal, false))
  EXECUTE FUNCTION public.fn_request_ai_reply();

-- For the health check: is the server-side request set up? Says only whether
-- the pieces exist, never the URL itself. Service role only.
CREATE OR REPLACE FUNCTION public.fn_bot_reply_trigger_status()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_has_url BOOLEAN := false;
BEGIN
  BEGIN
    SELECT coalesce(decrypted_secret, '') <> '' INTO v_has_url
      FROM vault.decrypted_secrets WHERE name = 'zentry_app_url' LIMIT 1;
  EXCEPTION WHEN OTHERS THEN
    v_has_url := false;
  END;
  RETURN jsonb_build_object(
    'trigger', EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'trg_request_ai_reply' AND NOT tgisinternal),
    'pg_net', EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_net'),
    'app_url', coalesce(v_has_url, false)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.fn_bot_reply_trigger_status() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_bot_reply_trigger_status() TO service_role;
