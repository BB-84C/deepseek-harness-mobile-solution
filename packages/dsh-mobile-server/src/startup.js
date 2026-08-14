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

export function apply(ctx) {
  if (process.env.DSH_MOBILE_INSTANCE !== "1") return;

  let gateway = null;
  let tunnel = null;

  import("./gateway.js")
    .then(async (mod) => {
      gateway = await mod.startGateway({ ctx });
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
