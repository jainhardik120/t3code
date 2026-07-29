# Push Notifications (Self-Hosted Android)

T3 Code Mobile can notify you when an agent on your self-hosted server needs
attention — an approval, input, a completed run, or a failure. On Android this
is delivered by your own server directly through Firebase Cloud Messaging (FCM),
with no dependency on the hosted T3 Connect relay.

> [!NOTE]
> This path is Android-only. iOS notifications still use the hosted relay + APNs
> (see the mobile app's agent-awareness module). The Live Activity lock-screen
> card remains iOS-only.

## How it works

1. When the Android app connects to your server, it registers its FCM push
   token over the existing authenticated WebSocket (`push.registerToken`).
2. The server stores the token against your paired session (`push_devices`).
3. A background sink (`FcmPushSink`) watches agent activity. When a thread
   transitions into an alerting phase (`waiting_for_approval`,
   `waiting_for_input`, `completed`, `failed`), it sends an FCM message to every
   registered Android device whose preferences allow that category.
4. Tapping the notification deep-links straight to the thread.

The server only sends push when it has FCM credentials configured; otherwise the
whole path is dormant and nothing changes.

## One-time setup

### 1. Create a Firebase project and Android app

1. In the [Firebase console](https://console.firebase.google.com/), create (or
   reuse) a project.
2. Add an **Android app** with the package name matching your build:
   - `com.t3tools.t3code` (production variant)
   - `com.t3tools.t3code.dev` / `com.t3tools.t3code.preview` for those variants
3. Download the generated `google-services.json`.

### 2. Build the Android app with FCM enabled

Place the file at `apps/mobile/google-services.json`, then rebuild:

```bash
cd apps/mobile
APP_VARIANT=production T3CODE_DISABLE_UPDATES=1 EXPO_NO_GIT_STATUS=1 \
  npx expo prebuild --clean --platform android
cd android && ANDROID_HOME=~/Android/Sdk \
  JAVA_HOME=/usr/lib/jvm/temurin-17-jdk-amd64 ./gradlew :app:assembleRelease
```

`app.config.ts` automatically wires `googleServicesFile` when the file is
present. Without it, the app builds fine but never requests a push token.

### 3. Give the server FCM credentials

FCM HTTP v1 requires a **service account**. In the Firebase console:
**Project settings → Service accounts → Generate new private key**. This
downloads a service-account JSON.

On the server host (same user/base-dir as your running service), store it:

```bash
t3 push set-fcm-credentials /path/to/service-account.json
```

Restart the server if it was already running. To disable push later:

```bash
t3 push clear-fcm-credentials
```

The credentials live in the server's encrypted secret store, not in the repo.

## Using it

1. Install the Android build and pair it to your server (see
   [Remote Access](./remote-access.md)).
2. Grant the notification permission when prompted (Android 13+).
3. Start an agent run. When it needs approval/input or finishes, you get a push.

## Troubleshooting

- **No prompt / no token:** the build has no `google-services.json`, or the
  Firebase Android app package name does not match the build variant.
- **Token registers but no notifications arrive:** the server has no FCM
  credentials (`t3 push set-fcm-credentials`), or the service account's Firebase
  project differs from the app's `google-services.json` project.
- **Notifications stop after reinstall:** FCM tokens rotate; the app re-registers
  on next connect, and the server drops tokens FCM reports as unregistered.
