// Secret holding a Google service-account JSON (with FCM enabled) used to mint
// OAuth2 access tokens for the FCM HTTP v1 API. Stored in the server secret
// store; absence disables self-hosted push. Set it with `t3 push set-fcm-credentials`.
export const FCM_SERVICE_ACCOUNT_SECRET = "push-fcm-service-account";

// Android notification channel id. Must match the channel the mobile app
// creates so high-priority agent alerts are delivered as heads-up notifications.
export const PUSH_ANDROID_CHANNEL_ID = "agent-activity";
