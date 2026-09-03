// Safe response headers for serving user-uploaded file bytes.
//
// KB files carry an attacker-influenced mimeType (upload sniffing maps
// .svg -> image/svg+xml, .html -> text/html), which a browser would execute as
// script in the app's authenticated origin if served inline. We render inline
// only a small allowlist (PDF + images, needed for preview) and force everything
// else to download as octet-stream — plus X-Content-Type-Options: nosniff and a
// sandbox CSP as defense in depth so even a rendered svg/html can't run script.

const INLINE_SAFE_MIME = new Set([
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/bmp",
])

/** Content-Type / Content-Disposition / nosniff / CSP for a user file.
 *  `dispositionName` must already be percent-encoded. */
export const safeFileServeHeaders = (
  mimeType: string | null | undefined,
  dispositionName: string,
): Record<string, string> => {
  const mt = (mimeType || "application/octet-stream")
    .split(";")[0]!
    .trim()
    .toLowerCase()
  const inline = INLINE_SAFE_MIME.has(mt)
  return {
    "Content-Type": inline ? mt : "application/octet-stream",
    "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${dispositionName}`,
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox",
  }
}
