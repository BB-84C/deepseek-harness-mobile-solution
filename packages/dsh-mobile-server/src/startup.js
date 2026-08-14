/**
 * @bb-84c/dsh-mobile-server — plugin entry for the resident `web` profile.
 *
 * Completely inert unless this process is a mobile-managed resident instance
 * (env DSH_MOBILE_INSTANCE=1, set by `dsh --profile mobile service start`).
 * When active it mounts the authenticating gateway in front of the official
 * dsh web (which itself stays on 127.0.0.1) — see docs/design/gateway.md.
 */

export const name = "mobile-gateway";

export function apply(ctx) {
  if (process.env.DSH_MOBILE_INSTANCE !== "1") return;

  let gateway = null;
  import("./gateway.js")
    .then(async (mod) => {
      gateway = await mod.startGateway({ ctx });
    })
    .catch((error) => {
      console.error(`[dsh-mobile-server] gateway failed to start: ${error?.message ?? error}`);
    });

  return () => {
    if (gateway !== null) gateway.stop();
  };
}
