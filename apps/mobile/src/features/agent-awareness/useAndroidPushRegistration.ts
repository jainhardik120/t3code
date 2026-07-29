import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { useEffect, useRef } from "react";
import { Platform } from "react-native";
import { AsyncResult } from "effect/unstable/reactivity";

import { loadOrCreateAgentAwarenessDeviceId } from "../../persistence/imperative";
import { useEnvironments } from "../../state/environments";
import { pushEnvironment } from "../../state/push";
import { useAtomCommand } from "../../state/use-atom-command";
import { projectWorkspaceEnvironment } from "../../state/workspaceModel";
import { configureAndroidNotificationChannel } from "./notificationSetup";

// Registers this Android device's FCM token with every connected self-hosted
// server so it can receive agent notifications directly (no hosted relay).
// iOS keeps using the relay path in remoteRegistration.ts; this hook is a
// no-op off Android.
export function useAndroidPushRegistration(): void {
  const registerToken = useAtomCommand(pushEnvironment.registerToken, { reportFailure: false });
  const { environments } = useEnvironments();
  // Guards against re-registering the same (environment, token) pair on every
  // render or environment-list change.
  const registeredRef = useRef(new Set<string>());

  useEffect(() => {
    if (Platform.OS !== "android") {
      return;
    }
    const connected = environments
      .map(projectWorkspaceEnvironment)
      .filter((environment) => environment.connectionState === "connected");
    if (connected.length === 0) {
      return;
    }

    let cancelled = false;
    void (async () => {
      await configureAndroidNotificationChannel();

      const existing = await Notifications.getPermissionsAsync();
      if (!existing.granted) {
        const requested = await Notifications.requestPermissionsAsync();
        if (!requested.granted) {
          return;
        }
      }

      let token: Notifications.DevicePushToken;
      try {
        token = await Notifications.getDevicePushTokenAsync();
      } catch {
        // Thrown when FCM is not configured in the native build (no
        // google-services.json). Push simply stays off for this install.
        return;
      }
      if (token.type !== "android" || typeof token.data !== "string" || token.data.length === 0) {
        return;
      }

      const deviceId = await loadOrCreateAgentAwarenessDeviceId();
      const appVersion = Constants.expoConfig?.version;

      for (const environment of connected) {
        if (cancelled) {
          return;
        }
        const key = `${environment.environmentId}:${token.data}`;
        if (registeredRef.current.has(key)) {
          continue;
        }
        const result = await registerToken({
          environmentId: environment.environmentId,
          input: {
            deviceId,
            platform: "android",
            token: token.data,
            ...(appVersion ? { appVersion } : {}),
            preferences: {
              notificationsEnabled: true,
              notifyOnApproval: true,
              notifyOnInput: true,
              notifyOnCompletion: true,
              notifyOnFailure: true,
            },
          },
        });
        if (!AsyncResult.isFailure(result)) {
          registeredRef.current.add(key);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [environments, registerToken]);
}
