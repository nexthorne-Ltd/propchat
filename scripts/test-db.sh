#!/usr/bin/env bash
# Runs the database tests (src/**/*.db.test.ts) against a throwaway Postgres.
#
# Boots a temporary cluster, loads a stub of the Supabase pieces migrations
# rely on (supabase/tests/), applies the real migrations the ticketing rules
# interact with, then every migration from the ticketing one onwards, and runs
# Vitest with TEST_DATABASE_URL pointing at it. Needs Postgres 15+ binaries
# (initdb, pg_ctl) on the machine; nothing touches a real Supabase project.
#
#   npm run test:db
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$(pg_config --bindir 2>/dev/null || ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)"
if [ ! -x "$BIN/initdb" ]; then
  echo "test-db: Postgres binaries (initdb, pg_ctl) not found; install Postgres 15+ to run the database tests." >&2
  exit 1
fi

TMP="$(mktemp -d)"
PORT="${TEST_DB_PORT:-54329}"
RUN=()
if [ "$(id -u)" = "0" ]; then
  # initdb refuses to run as root.
  chown postgres "$TMP"
  RUN=(runuser -u postgres --)
fi

cleanup() {
  "${RUN[@]}" "$BIN/pg_ctl" -D "$TMP/data" -m immediate stop >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

"${RUN[@]}" "$BIN/initdb" -D "$TMP/data" -U postgres -A trust >/dev/null
"${RUN[@]}" "$BIN/pg_ctl" -D "$TMP/data" -l "$TMP/log" -w \
  -o "-p $PORT -k $TMP -c listen_addresses='' -c fsync=off -c wal_level=logical" start >/dev/null

export PGHOST="$TMP" PGPORT="$PORT" PGUSER=postgres PGOPTIONS="-c client_min_messages=warning"
psql_run() { psql -v ON_ERROR_STOP=1 -q -X "$@"; }
psql_run -d postgres -c 'CREATE DATABASE zentry_test' >/dev/null

load() { psql_run -d zentry_test -f "$1" >/dev/null || { echo "test-db: failed loading $1" >&2; exit 1; }; }

load "$ROOT/supabase/tests/00_supabase_stub.sql"
load "$ROOT/supabase/migrations/20260902000000_init_intercom_schema.sql"
load "$ROOT/supabase/tests/10_production_extras.sql"
# The existing migrations that define behaviour or columns tickets depend on:
# visitor details, receipts, auto assignment, the conversation/message/
# visitor/agent RLS, the super-admin helper, and resolution bookkeeping.
# Others need pgvector or seed live data.
for m in \
  20260903120000_visitor_timezone_language.sql \
  20260904120000_message_delivery_receipts.sql \
  20261002010000_auto_assignment_and_first_reply.sql \
  20261002030000_super_admin_lockdown_and_rls.sql \
  20261004000000_super_admin_data_correctness_and_orphans.sql \
  20261008000000_bot_resume_after_resolve.sql; do
  load "$ROOT/supabase/migrations/$m"
done
# Everything from the ticketing work onwards.
for m in "$ROOT"/supabase/migrations/2026100909*.sql "$ROOT"/supabase/migrations/202610091*.sql "$ROOT"/supabase/migrations/2026101*.sql; do
  [ -e "$m" ] && load "$m"
done
# Later migrations whose rules the tests cover.
for m in 20261031090000_ai_reply_authorization.sql 20261105090000_tags_webhooks_ticket_fields.sql 20261106090000_widget_visitor_sessions.sql 20261107090000_widget_anon_lockdown.sql 20261020090000_live_visitor_tracking.sql 20261108090000_widget_tracking_tokens.sql 20261109090000_jev_decisions.sql 20261110090000_jev_platform_level.sql 20261114090000_widget_session_workspace_status.sql 20261115090000_rate_limiting.sql 20261116090000_help_center_theme.sql 20261117090000_inbox_speed.sql 20261118090000_team_chat.sql 20261120090000_trader_data_lookup.sql; do
  load "$ROOT/supabase/migrations/$m"
done
psql_run -d zentry_test -c 'GRANT ALL ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role' >/dev/null

export TEST_DATABASE_URL="postgresql://postgres@localhost/zentry_test?host=$TMP&port=$PORT"
cd "$ROOT"
npx vitest run "${@:-.db.test.ts}"
