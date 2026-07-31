#!/usr/bin/env bash
# Build a compact fixture DB from a real T3 state.sqlite, keeping only a few
# large threads (and their project) so we can reproduce slow large-thread loads
# without shipping the whole (private) database.
#
# Disk-light: creates a fresh small DB (schema-only) and copies ONLY the target
# rows via ATTACH + INSERT..SELECT — never makes a full-size copy of the source.
#
# Usage: seed-fixture.sh <src-state.sqlite> <out-dir>
#   out-dir gets: <out-dir>/userdata/state.sqlite  (a base-dir the server can serve)
set -euo pipefail

SRC="${1:?usage: seed-fixture.sh <src-state.sqlite> <out-dir>}"
OUTDIR="${2:?usage: seed-fixture.sh <src-state.sqlite> <out-dir>}"

# Threads to keep (the largest, painful ones). Edit to taste.
THREADS=(
  "e2fd85a3-f113-46af-bcd1-552dc76dfe62"  # Experimental Helix port forwarding (~1644 msgs, 25MB snapshot)
  "84413b43-ce7c-4b85-904d-64425680c1e7"  # Run React Kiosk Without KDE (~1267 msgs)
)

mkdir -p "$OUTDIR/userdata" "$OUTDIR/worktrees"
OUT="$OUTDIR/userdata/state.sqlite"
rm -f "$OUT" "$OUT-journal" "$OUT-wal" "$OUT-shm"

tin=$(printf "'%s'," "${THREADS[@]}"); tin="${tin%,}"
projects=$(sqlite3 "$SRC" "SELECT DISTINCT project_id FROM projection_threads WHERE thread_id IN ($tin);")
pin=$(printf "'%s'," $projects); pin="${pin%,}"
echo "keeping threads ($tin)"
echo "in project(s) ($pin)"

echo "[1/3] create schema-only fixture"
sqlite3 "$SRC" ".schema" | grep -v "sqlite_sequence" | sqlite3 "$OUT"

echo "[2/3] copy only target rows (ATTACH + INSERT..SELECT)"
sqlite3 "$OUT" <<SQL
ATTACH '$SRC' AS src;
PRAGMA foreign_keys=OFF;
BEGIN;
-- schema/version + projection cursor (full, so migrations read as applied)
INSERT INTO effect_sql_migrations SELECT * FROM src.effect_sql_migrations;
INSERT INTO projection_state       SELECT * FROM src.projection_state;
-- kept project(s)
INSERT INTO projection_projects    SELECT * FROM src.projection_projects            WHERE project_id IN ($pin);
-- thread-scoped rows for kept threads
INSERT INTO projection_threads              SELECT * FROM src.projection_threads              WHERE thread_id IN ($tin);
INSERT INTO projection_thread_messages      SELECT * FROM src.projection_thread_messages      WHERE thread_id IN ($tin);
INSERT INTO projection_thread_activities    SELECT * FROM src.projection_thread_activities    WHERE thread_id IN ($tin);
INSERT INTO projection_thread_sessions      SELECT * FROM src.projection_thread_sessions      WHERE thread_id IN ($tin);
INSERT INTO projection_turns                SELECT * FROM src.projection_turns                WHERE thread_id IN ($tin);
INSERT INTO projection_pending_approvals    SELECT * FROM src.projection_pending_approvals    WHERE thread_id IN ($tin);
INSERT INTO projection_thread_proposed_plans SELECT * FROM src.projection_thread_proposed_plans WHERE thread_id IN ($tin);
INSERT INTO provider_session_runtime        SELECT * FROM src.provider_session_runtime        WHERE thread_id IN ($tin);
INSERT INTO checkpoint_diff_blobs           SELECT * FROM src.checkpoint_diff_blobs           WHERE thread_id IN ($tin);
-- event log + receipts for kept threads and their project
INSERT INTO orchestration_events            SELECT * FROM src.orchestration_events            WHERE stream_id IN ($tin) OR stream_id IN ($pin);
INSERT INTO orchestration_command_receipts  SELECT * FROM src.orchestration_command_receipts  WHERE aggregate_id IN ($tin) OR aggregate_id IN ($pin);
-- auth_sessions / auth_pairing_links / push_devices intentionally left empty (fresh pairing, no leaked creds)
COMMIT;
DETACH src;
SQL

echo "[3/3] done"
echo "=== fixture built ==="
du -h "$OUT" | cut -f1
sqlite3 -header -column "$OUT" "SELECT substr(thread_id,1,8) thread, (SELECT COUNT(*) FROM projection_thread_messages m WHERE m.thread_id=t.thread_id) msgs, (SELECT COUNT(*) FROM orchestration_events e WHERE e.stream_id=t.thread_id) events FROM projection_threads t;"
