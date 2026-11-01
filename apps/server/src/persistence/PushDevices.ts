import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

import { AuthSessionId, PushDevicePlatform, PushNotificationPreferences } from "@t3tools/contracts";

import {
  PersistenceDecodeError,
  type PersistenceErrorCorrelation,
  PersistenceSqlError,
  type PushDeviceRepositoryError,
} from "./Errors.ts";

export const PushDeviceRecord = Schema.Struct({
  deviceId: Schema.String,
  sessionId: AuthSessionId,
  platform: PushDevicePlatform,
  token: Schema.String,
  label: Schema.NullOr(Schema.String),
  appVersion: Schema.NullOr(Schema.String),
  preferences: PushNotificationPreferences,
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});
export type PushDeviceRecord = typeof PushDeviceRecord.Type;

export const UpsertPushDeviceInput = Schema.Struct({
  deviceId: Schema.String,
  sessionId: AuthSessionId,
  platform: PushDevicePlatform,
  token: Schema.String,
  label: Schema.NullOr(Schema.String),
  appVersion: Schema.NullOr(Schema.String),
  preferences: PushNotificationPreferences,
  now: Schema.DateTimeUtcFromString,
});
export type UpsertPushDeviceInput = typeof UpsertPushDeviceInput.Type;

export const DeletePushDeviceInput = Schema.Struct({
  deviceId: Schema.String,
});
export type DeletePushDeviceInput = typeof DeletePushDeviceInput.Type;

export const DeletePushDevicesBySessionInput = Schema.Struct({
  sessionId: AuthSessionId,
});
export type DeletePushDevicesBySessionInput = typeof DeletePushDevicesBySessionInput.Type;

export class PushDeviceRepository extends Context.Service<
  PushDeviceRepository,
  {
    readonly upsert: (
      input: UpsertPushDeviceInput,
    ) => Effect.Effect<void, PushDeviceRepositoryError>;
    readonly deleteByDeviceId: (
      input: DeletePushDeviceInput,
    ) => Effect.Effect<boolean, PushDeviceRepositoryError>;
    readonly deleteBySessionId: (
      input: DeletePushDevicesBySessionInput,
    ) => Effect.Effect<void, PushDeviceRepositoryError>;
    readonly listAll: () => Effect.Effect<
      ReadonlyArray<PushDeviceRecord>,
      PushDeviceRepositoryError
    >;
  }
>()("t3/persistence/PushDevices/PushDeviceRepository") {}

const PushDeviceDbRow = Schema.Struct({
  deviceId: Schema.String,
  sessionId: AuthSessionId,
  platform: PushDevicePlatform,
  token: Schema.String,
  label: Schema.NullOr(Schema.String),
  appVersion: Schema.NullOr(Schema.String),
  preferences: Schema.fromJsonString(PushNotificationPreferences),
  createdAt: Schema.DateTimeUtcFromString,
  updatedAt: Schema.DateTimeUtcFromString,
});

const PushDeviceRawDbRow = Schema.Struct({
  deviceId: Schema.String,
  sessionId: Schema.Unknown,
  platform: Schema.Unknown,
  token: Schema.Unknown,
  label: Schema.Unknown,
  appVersion: Schema.Unknown,
  preferences: Schema.Unknown,
  createdAt: Schema.Unknown,
  updatedAt: Schema.Unknown,
});

const decodePushDeviceDbRow = Schema.decodeUnknownEffect(PushDeviceDbRow);

function toPersistenceSqlOrDecodeError(
  sqlOperation: string,
  decodeOperation: string,
  correlation?: PersistenceErrorCorrelation,
) {
  return (cause: unknown): PushDeviceRepositoryError =>
    Schema.isSchemaError(cause)
      ? PersistenceDecodeError.fromSchemaError(decodeOperation, cause, correlation)
      : new PersistenceSqlError({
          operation: sqlOperation,
          ...(correlation === undefined ? {} : { correlation }),
          cause,
        });
}

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertRow = SqlSchema.void({
    Request: UpsertPushDeviceInput,
    execute: (input) =>
      sql`
        INSERT INTO push_devices (
          device_id,
          session_id,
          platform,
          token,
          label,
          app_version,
          preferences,
          created_at,
          updated_at
        )
        VALUES (
          ${input.deviceId},
          ${input.sessionId},
          ${input.platform},
          ${input.token},
          ${input.label},
          ${input.appVersion},
          ${JSON.stringify(input.preferences)},
          ${input.now},
          ${input.now}
        )
        ON CONFLICT (device_id) DO UPDATE SET
          session_id = excluded.session_id,
          platform = excluded.platform,
          token = excluded.token,
          label = excluded.label,
          app_version = excluded.app_version,
          preferences = excluded.preferences,
          updated_at = excluded.updated_at
      `,
  });

  const deleteByDeviceIdRows = SqlSchema.findAll({
    Request: DeletePushDeviceInput,
    Result: Schema.Struct({ deviceId: Schema.String }),
    execute: ({ deviceId }) =>
      sql`
        DELETE FROM push_devices
        WHERE device_id = ${deviceId}
        RETURNING device_id AS "deviceId"
      `,
  });

  const deleteBySessionIdRow = SqlSchema.void({
    Request: DeletePushDevicesBySessionInput,
    execute: ({ sessionId }) =>
      sql`
        DELETE FROM push_devices
        WHERE session_id = ${sessionId}
      `,
  });

  const listAllRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PushDeviceRawDbRow,
    execute: () =>
      sql`
        SELECT
          device_id AS "deviceId",
          session_id AS "sessionId",
          platform AS "platform",
          token AS "token",
          label AS "label",
          app_version AS "appVersion",
          preferences AS "preferences",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM push_devices
        ORDER BY updated_at DESC, device_id DESC
      `,
  });

  const upsert: PushDeviceRepository["Service"]["upsert"] = (input) =>
    upsertRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PushDeviceRepository.upsert:query",
          "PushDeviceRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteByDeviceId: PushDeviceRepository["Service"]["deleteByDeviceId"] = (input) =>
    deleteByDeviceIdRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PushDeviceRepository.deleteByDeviceId:query",
          "PushDeviceRepository.deleteByDeviceId:decodeRows",
        ),
      ),
      Effect.map((rows) => rows.length > 0),
    );

  const deleteBySessionId: PushDeviceRepository["Service"]["deleteBySessionId"] = (input) =>
    deleteBySessionIdRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PushDeviceRepository.deleteBySessionId:query",
          "PushDeviceRepository.deleteBySessionId:encodeRequest",
        ),
      ),
    );

  const listAll: PushDeviceRepository["Service"]["listAll"] = () =>
    listAllRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PushDeviceRepository.listAll:query",
          "PushDeviceRepository.listAll:decodeRows",
        ),
      ),
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodePushDeviceDbRow(row).pipe(
            Effect.mapError((cause) =>
              PersistenceDecodeError.fromSchemaError(
                "PushDeviceRepository.listAll:decodeRows",
                cause,
              ),
            ),
          ),
        ),
      ),
    );

  return {
    upsert,
    deleteByDeviceId,
    deleteBySessionId,
    listAll,
  } satisfies PushDeviceRepository["Service"];
});

export const layer = Layer.effect(PushDeviceRepository, make);
