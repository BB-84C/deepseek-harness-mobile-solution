// URL builders. ASCII QR output is deferred to a later milestone — this
// module exposes URLs only.
//
// tailscale mode → http://<magicdns-hostname | tailnet-ip>:<gatewayPort>/
// relay mode     → https://<relayHost>/instance/<instanceId>/   (the relay
//                  sets a routing cookie there; the official frontend's
//                  absolute /api paths then ride that cookie)
// pairing        → <accessUrl>mobile/pair?code=<code>
//

/**
 * Normalize a relay host: strip any scheme and trailing slashes.
 * @param {string} relayUrl
 * @returns {string}
 */
export function relayBaseUrl(relayUrl) {
  return String(relayUrl || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '');
}

/**
 * Build the remote access URL for the current mode.
 * @param {{ config: object, tailscaleIp?: string|null, tailscaleHostname?: string|null }} params
 * @returns {string}
 */
export function buildAccessUrl({ config, tailscaleIp, tailscaleHostname } = {}) {
  if (!config) return '';
  if (config.mode === 'relay') {
    const host = relayBaseUrl(config.relay && config.relay.url);
    const instanceId = (config.relay && config.relay.instanceId ? config.relay.instanceId : '').toLowerCase();
    if (host && instanceId) {
      return `https://${host}/instance/${encodeURIComponent(instanceId)}/`;
    }
    // No instance id: point at the relay's instance picker instead.
    return `https://${host}/relay/`;
  }
  // tailscale: prefer MagicDNS hostname, else tailnet IP
  const host = tailscaleHostname || tailscaleIp || '';
  return `http://${host}:${config.gatewayPort}/`;
}

/**
 * Build the one-time pairing URL.
 * @param {{ accessUrl: string, pairingCode: string }} params
 * @returns {string}
 */
export function pairingUrl({ accessUrl, pairingCode } = {}) {
  const base = String(accessUrl || '').replace(/\/+$/, '');
  return `${base}/mobile/pair?code=${encodeURIComponent(String(pairingCode ?? ''))}`;
}
