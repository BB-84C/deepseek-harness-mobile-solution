/**
 * @bb-84c/dsh-mobile-server — plugin entry for the resident `web` profile.
 *
 * Completely inert unless this process is a mobile-managed resident instance
 * (env DSH_MOBILE_INSTANCE=1, set by `dsh --profile mobile service start`).
 * When active it mounts the authenticating gateway in front of the official
 * dsh web (which itself stays on 127.0.0.1) — see docs/design/gateway.md —
 * and, in relay mode, the outbound tunnel to the user's VPS relay.
 */

import { startTunnel } from "./relay-tunnel.js";
import { loadConfig } from "@bb-84c/dsh-mobile-common/config.js";

export const name = "mobile-gateway";
// The live session store feeds the session-live guard (blocks opening a
// session another instance is actively writing). Activation waits for it;
// the env gate below keeps ordinary `dsh web` runs inert.
//
// `connection` and `webApp` are NOT listed here on purpose: this cordis build
// reads `inject` as a flat list of required service names (an object form is
// stringified into bogus service names and the entry never activates), and the
// token provider must stay optional anyway — a missing service simply means
// this dsh version has no browser-token gate. It is resolved lazily per call.
export const inject = ["sessions"];

const WEB_ORIGIN_FALLBACK = "http://127.0.0.1:3080/";

/**
 * Build the launch-token provider for the gateway.
 *
 * Upstream `dsh-client-connection` (0.1.2-rc.1 and newer) gates the served
 * index on a per-process launch token and answers 401 without the signed
 * `dsh-auth-*` cookie. `connection.authenticatedUrl(url)` returns that URL with
 * the token attached, so the gateway can hand it to a phone that only holds OUR
 * device session. Returns null when this dsh has no browser auth at all (older
 * versions), which keeps the proxy transparent.
 *
 * @param {object} ctx cordis plugin context (may not carry either service)
 * @returns {(() => string|null)|null} provider returning the raw token
 */
export function createLaunchTokenProvider(ctx) {
  if (ctx === void 0 || ctx === null || typeof ctx.get !== "function") return null;

  /** Read a service without letting a not-yet-provided name abort the gateway. */
  function service(name) {
    try {
      const value = ctx.get(name);
      return value === void 0 ? null : value;
    } catch {
      return null;
    }
  }

  /** The advertised GUI URL is irrelevant here (only `?token=` is read), but it keeps upstream semantics warm. */
  function baseUrl() {
    const webApp = service("webApp");
    if (webApp !== null && typeof webApp.getAdvertisedUrl === "function") {
      try {
        const advertised = webApp.getAdvertisedUrl();
        if (typeof advertised === "string" && advertised !== "") return advertised;
      } catch {
        // fall through to the loopback origin
      }
    }
    return WEB_ORIGIN_FALLBACK;
  }

  return () => {
    // Resolved per call: this plugin activates before some rows mount, so a
    // one-shot lookup at activation time would miss `connection` and silently
    // disable the handshake until the next restart.
    const connection = service("connection");
    if (connection === null || typeof connection.authenticatedUrl !== "function") return null;
    try {
      const url = connection.authenticatedUrl(baseUrl());
      if (typeof url !== "string") return null;
      const token = new URL(url).searchParams.get("token");
      return token !== null && token !== "" ? token : null;
    } catch {
      // A connection reload or a closed process owner must not break proxying:
      // the gateway falls back to transparent pass-through for this request.
      return null;
    }
  };
}

export function apply(ctx) {
  if (process.env.DSH_MOBILE_INSTANCE !== "1") return;

  let gateway = null;
  let tunnel = null;

  import("./gateway.js")
    .then(async (mod) => {
      const launchToken = createLaunchTokenProvider(ctx);
      gateway = await mod.startGateway({ ctx, launchToken });
      const config = loadConfig().config;
      const port = Number(process.env.DSH_MOBILE_GATEWAY_PORT || config.gatewayPort || 3081);
      if (config.mode === "relay") {
        tunnel = await startTunnel({ config, targetPort: port });
      }
    })
    .catch((error) => {
      console.error(`[dsh-mobile-server] gateway failed to start: ${error?.message ?? error}`);
    });

  return () => {
    if (tunnel !== null && typeof tunnel.stop === "function") tunnel.stop();
    if (gateway !== null && typeof gateway.stop === "function") gateway.stop();
  };
}
