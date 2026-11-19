import type { RequestHandler } from "express";

const err = (code: string, message: string) => ({ error: { code, message } });

/**
 * The hub holds every device token and has no login of its own, so it only answers requests
 * whose Host is one it serves (blocks DNS rebinding) from its own origin (blocks CSRF), and
 * accepts JSON writes plus the exact binary Artifact stream endpoint. The latter requires a
 * custom filename header (also forces a browser CORS preflight) and rejects simple form types.
 */
export function guard(allowedHosts: Set<string>): RequestHandler {
  return (req, res, next) => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (!allowedHosts.has(host))
      return void res.status(421).json(err("invalid", `Unknown Host header: ${host}`));
    const origin = req.headers.origin;
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host.toLowerCase();
      } catch {}
      if (originHost !== host)
        return void res
          .status(403)
          .json(err("unauthorized", "Cross-origin requests are not allowed"));
    }
    const binaryArtifact =
      req.method === "POST" &&
      /^\/projects\/[^/]+\/artifacts\/binary$/.test(req.path) &&
      typeof req.headers["x-artifact-name"] === "string" &&
      !["application/x-www-form-urlencoded", "multipart/form-data", "text/plain"].some((type) => Boolean(req.is(type)));
    if (["POST", "PUT", "PATCH"].includes(req.method) && !req.is("application/json") && !binaryArtifact)
      return void res.status(415).json(err("invalid", "JSON required"));
    next();
  };
}
