import { AuthSessionId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { layer as pushDevicesLayer, PushDeviceRepository } from "./PushDevices.ts";

const prefs = {
  notificationsEnabled: true,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: false,
};

const pushLayer = it.layer(
  Layer.mergeAll(
    pushDevicesLayer.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

pushLayer("PushDeviceRepository", (it) => {
  it.effect("upserts, updates on conflict, lists, and deletes a device", () =>
    Effect.gen(function* () {
      const repo = yield* PushDeviceRepository;
      const now = yield* DateTime.now;
      const sessionId = AuthSessionId.make("session-1");

      yield* repo.upsert({
        deviceId: "device-1",
        sessionId,
        platform: "android",
        token: "token-1",
        label: "Pixel",
        appVersion: "0.1.0",
        preferences: prefs,
        now,
      });

      let all = yield* repo.listAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0]?.token, "token-1");
      assert.strictEqual(all[0]?.platform, "android");
      assert.strictEqual(all[0]?.preferences.notifyOnFailure, false);

      // Same deviceId with a rotated token updates in place rather than adding a row.
      yield* repo.upsert({
        deviceId: "device-1",
        sessionId,
        platform: "android",
        token: "token-2",
        label: null,
        appVersion: null,
        preferences: prefs,
        now,
      });

      all = yield* repo.listAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0]?.token, "token-2");

      const deleted = yield* repo.deleteByDeviceId({ deviceId: "device-1" });
      assert.strictEqual(deleted, true);
      all = yield* repo.listAll();
      assert.strictEqual(all.length, 0);
    }),
  );

  it.effect("deletes all devices for a revoked session", () =>
    Effect.gen(function* () {
      const repo = yield* PushDeviceRepository;
      const now = yield* DateTime.now;
      const sessionA = AuthSessionId.make("session-a");
      const sessionB = AuthSessionId.make("session-b");

      yield* repo.upsert({
        deviceId: "device-a",
        sessionId: sessionA,
        platform: "android",
        token: "a",
        label: null,
        appVersion: null,
        preferences: prefs,
        now,
      });
      yield* repo.upsert({
        deviceId: "device-b",
        sessionId: sessionB,
        platform: "android",
        token: "b",
        label: null,
        appVersion: null,
        preferences: prefs,
        now,
      });

      yield* repo.deleteBySessionId({ sessionId: sessionA });
      const all = yield* repo.listAll();
      assert.strictEqual(all.length, 1);
      assert.strictEqual(all[0]?.deviceId, "device-b");
    }),
  );
});
