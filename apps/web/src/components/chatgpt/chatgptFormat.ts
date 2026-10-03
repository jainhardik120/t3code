// @effect-diagnostics globalDate:off -- display timestamps derived from wall-clock now
/**
 * Format a ChatGPT timestamp for display. The API returns list times as ISO
 * strings and message times as epoch seconds, so both are accepted.
 *
 * @module components/chatgpt/chatgptFormat
 */
const DAY_MS = 86_400_000;

const toMillis = (value: number | string | null): number | null => {
  if (value == null) return null;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/** Short relative label: "today", "3d ago", "Mar 4", "Mar 4 2025". */
export function formatChatTime(value: number | string | null): string {
  const ms = toMillis(value);
  if (ms === null) return "";
  const now = Date.now();
  const diff = now - ms;
  if (diff < DAY_MS) return "today";
  if (diff < 2 * DAY_MS) return "yesterday";
  if (diff < 7 * DAY_MS) return `${Math.floor(diff / DAY_MS)}d ago`;
  const date = new Date(ms);
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(diff > 330 * DAY_MS ? { year: "numeric" } : {}),
  });
}
