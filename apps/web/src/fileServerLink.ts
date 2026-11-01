import { isElectron } from "./env";

/**
 * Mount prefix of the `filed` file server on the app's own origin. The
 * Cloudflare tunnel routes `<app origin>/files/*` to it, so a chat file chip
 * can link at the real file instead of a path that resolves to a 404 on the
 * app itself.
 */
const FILE_SERVER_BASE_PATH = "/files";

const POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;

function encodeAbsolutePath(absolutePath: string): string {
  return absolutePath.split("/").map(encodeURIComponent).join("/");
}

/** Same-origin file-server URL for `absolutePath`, or null (always in desktop, where the editor is better). */
export function fileServerHref(absolutePath: string): string | null {
  if (isElectron) return null;
  // POSIX absolute paths only -- Windows and relative paths are not addressable
  // on the file server, which resolves a URL path as a filesystem path.
  if (!absolutePath.startsWith("/")) return null;
  if (absolutePath.includes("\0")) return null;

  const withoutPosition = absolutePath.replace(POSITION_SUFFIX_PATTERN, "");
  if (withoutPosition.length === 0) return null;

  return `${FILE_SERVER_BASE_PATH}${encodeAbsolutePath(withoutPosition)}`;
}
