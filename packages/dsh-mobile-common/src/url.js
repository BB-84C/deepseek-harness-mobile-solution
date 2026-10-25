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

/**
 * Reduce anything URL-ish to the bare `host[:port]` authority that dsh's
 * `--trusted-host` accepts, or null when nothing usable is left.
 *
 * dsh >= 0.2 validates every `--trusted-host` value with
 * `assertTrustedAuthority` and FAILS PLUGIN LOAD — the resident web never
 * starts — for anything that is not a canonical bare authority: a scheme, a
 * path, a trailing slash, userinfo, a zero-padded port, or unbracketed IPv6.
 * Older versions parsed leniently, so non-canonical input used to be harmless.
 * @param {string} value raw authority, bare host, or full URL
 * @returns {string|null} canonical authority, lowercased, IPv6 bracketed
 */
export function canonicalAuthority(value) {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (raw === '') return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  /** Parse, bracketing a bare IPv6 literal first (WHATWG requires brackets). */
  const parse = (text) => {
    try {
      return new URL(text);
    } catch {
      return null;
    }
  };
  let url = parse(withScheme ? raw : `http://${raw}`);
  if (url === null && !withScheme && raw.split(':').length > 2) {
    // Unbracketed IPv6 (e.g. a tailnet v6 address): bracket it and retry.
    url = parse(`http://[${raw.replace(/^\[|\]$/g, '')}]`);
  }
  if (url === null || url.hostname === '') return null;
  // WHATWG returns IPv6 hostnames WITH brackets; re-add exactly one pair.
  const bare = url.hostname.replace(/^\[|\]$/g, '');
  const host = bare.includes(':') ? `[${bare}]` : bare;
  return url.port === '' ? host.toLowerCase() : `${host.toLowerCase()}:${url.port}`;
}
