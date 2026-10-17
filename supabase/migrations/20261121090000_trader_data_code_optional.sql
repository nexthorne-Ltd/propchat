-- Trader data: the email code becomes a per-workspace choice, off by default.
--
-- 20261120090000 looked up nothing personal until the visitor proved their
-- email with a 6-digit code. Firms found the extra step slows every
-- "how many accounts do I have?" chat, and asked for the record to be read
-- straight from the email the trader gives (or the one on the pre-chat
-- form). That is the default now. The code stays available: a workspace
-- that wants it switches it on in Settings -> AI bot -> Trader data
-- ("Verify the email with a code"), because without it anyone who types
-- another trader's email sees that trader's accounts.

ALTER TABLE public.trader_data_connections
  ADD COLUMN IF NOT EXISTS require_code BOOLEAN NOT NULL DEFAULT false;
