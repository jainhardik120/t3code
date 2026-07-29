import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

// Must match the server's PUSH_ANDROID_CHANNEL_ID (apps/server/src/push/config.ts)
// so high-priority agent alerts route to a heads-up channel on Android.
export const AGENT_ACTIVITY_ANDROID_CHANNEL_ID = "agent-activity";

// Present incoming notifications while the app is foregrounded. Without a
// handler, expo-notifications suppresses the banner when the app is open, so a
// push that arrives mid-use would be silently dropped.
Notifications.setNotificationHandler({
  handleNotification: () =>
    Promise.resolve({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
    }),
});

// Android 8+ requires an explicit channel before any notification can display.
// Idempotent — safe to call on every launch.
export async function configureAndroidNotificationChannel(): Promise<void> {
  if (Platform.OS !== "android") {
    return;
  }
  await Notifications.setNotificationChannelAsync(AGENT_ACTIVITY_ANDROID_CHANNEL_ID, {
    name: "Agent activity",
    importance: Notifications.AndroidImportance.HIGH,
    lockscreenVisibility: Notifications.AndroidNotificationVisibility.PRIVATE,
  });
}
