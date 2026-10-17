-- Migration: 20260911120000_smtp_and_unread_email_alerts.sql
-- Description: Add workspace SMTP configuration and unread message email notification tracking

ALTER TABLE public.workspaces 
ADD COLUMN IF NOT EXISTS smtp_settings JSONB DEFAULT NULL;

ALTER TABLE public.messages 
ADD COLUMN IF NOT EXISTS email_notified_at TIMESTAMPTZ DEFAULT NULL;

CREATE INDEX IF NOT EXISTS idx_messages_unread_email_alert 
ON public.messages (conversation_id, created_at) 
WHERE read_at IS NULL AND email_notified_at IS NULL AND sender_type != 'visitor';
