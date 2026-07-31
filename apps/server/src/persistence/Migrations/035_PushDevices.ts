import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Self-hosted push notifications: each row is a device that registered its
// native push token (FCM on Android, APNs on iOS) with this server over its
// authenticated WebSocket session. Keyed by device_id so a token rotation
// updates the same row; session_id ties the device to the auth session so it
// can be cleaned up when access is revoked.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS push_devices (
      device_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      platform TEXT NOT NULL,
      token TEXT NOT NULL,
      label TEXT,
      app_version TEXT,
      preferences TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS idx_push_devices_session
    ON push_devices (session_id)
  `;
});
