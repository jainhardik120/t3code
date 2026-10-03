import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

// Self-hosted push notifications. Unlike the hosted relay path (relay.ts,
// iOS/APNs only), this lets a device register its native push token directly
// with the server it is paired to, and the server pushes to it via the
// platform transport (FCM on Android, APNs on iOS). Kept independent of the
// relay contract so the self-hosted path carries no Clerk/cloud coupling.
export const PushDevicePlatform = Schema.Literals(["ios", "android"]);
export type PushDevicePlatform = typeof PushDevicePlatform.Type;

// Per-category notification toggles. Mirrors the relay's preference shape but
// without the iOS Live Activity flag, which is not part of the self-hosted
// push path.
export const PushNotificationPreferences = Schema.Struct({
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type PushNotificationPreferences = typeof PushNotificationPreferences.Type;

export const PushRegisterTokenInput = Schema.Struct({
  // Stable per-install identifier so the same device updates its row instead
  // of accumulating one per token rotation.
  deviceId: TrimmedNonEmptyString,
  platform: PushDevicePlatform,
  // FCM registration token (Android) or APNs device token (iOS).
  token: TrimmedNonEmptyString,
  label: Schema.optional(TrimmedNonEmptyString),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  preferences: PushNotificationPreferences,
});
export type PushRegisterTokenInput = typeof PushRegisterTokenInput.Type;

export const PushRegisterTokenResult = Schema.Struct({
  registered: Schema.Boolean,
});
export type PushRegisterTokenResult = typeof PushRegisterTokenResult.Type;

export const PushUnregisterTokenInput = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type PushUnregisterTokenInput = typeof PushUnregisterTokenInput.Type;

export const PushUnregisterTokenResult = Schema.Struct({
  unregistered: Schema.Boolean,
});
export type PushUnregisterTokenResult = typeof PushUnregisterTokenResult.Type;

export class PushRegistrationError extends Schema.TaggedError<PushRegistrationError>()(
  "PushRegistrationError",
  {
    message: Schema.String,
  },
) {}
