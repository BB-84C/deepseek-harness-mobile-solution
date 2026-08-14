// Minimal WebAuthn helpers — zero dependencies.
// Provides the small subset of WebAuthn/CTAP2 needed to register and verify a
// passkey owner credential: a CBOR decoder, authData parsing, COSE public-key
// parsing (ES256/RS256), clientDataJSON checks, and assertion signature
// verification via node:crypto.

import { createHash, createPublicKey, createVerify, constants } from 'node:crypto'

// --- base64url --------------------------------------------------------------

export function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64url')
}

// Tolerates missing/malformed padding.
export function b64urlDecode(value) {
  let s = String(value)
  s = s.replace(/-/g, '+').replace(/_/g, '/')
  while (s.length % 4 !== 0) s += '='
  return Buffer.from(s, 'base64')
}

// --- minimal CBOR decoder ---------------------------------------------------
// Decodes a single CBOR item starting at `start`. Returns { value, next }.
// Supports definite-length unsigned/negative ints, byte/text strings, arrays,
// maps, tags (ignored), and simple values (false/true/null, floats). This is
// enough for WebAuthn attestation objects and COSE_Key.

export function decodeCbor(buf, start = 0) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  let i = start

  function readUint(n) {
    let v = 0
    for (let k = 0; k < n; k++) v = v * 256 + b[i + k]
    i += n
    return v
  }

  function parse() {
    if (i >= b.length) throw new Error('CBOR: unexpected end of input')
    const initial = b[i++]
    const major = initial >> 5
    const info = initial & 0x1f

    function len() {
      if (info < 24) return info
      if (info === 24) return readUint(1)
      if (info === 25) return readUint(2)
      if (info === 26) return readUint(4)
      if (info === 27) return readUint(8)
      throw new Error('CBOR: unsupported additional info ' + info)
    }

    switch (major) {
      case 0:
        return len()
      case 1:
        return -1 - len()
      case 2: {
        const n = len()
        const out = Buffer.from(b.subarray(i, i + n))
        i += n
        return out
      }
      case 3: {
        const n = len()
        const out = b.subarray(i, i + n).toString('utf8')
        i += n
        return out
      }
      case 4: {
        const n = len()
        const arr = []
        for (let k = 0; k < n; k++) arr.push(parse())
        return arr
      }
      case 5: {
        const n = len()
        const map = {}
        for (let k = 0; k < n; k++) {
          const key = parse()
          const val = parse()
          map[key] = val
        }
        return map
      }
      case 6: {
        len() // tag number (ignored)
        return parse()
      }
      case 7: {
        if (info === 20) return false
        if (info === 21) return true
        if (info === 22) return null
        if (info === 24) return readUint(1)
        if (info === 26) {
          const f = b.readFloatBE(i)
          i += 4
          return f
        }
        if (info === 27) {
          const f = b.readDoubleBE(i)
          i += 8
          return f
        }
        throw new Error('CBOR: unsupported simple value ' + info)
      }
      default:
        throw new Error('CBOR: unsupported major type ' + major)
    }
  }

  const value = parse()
  return { value, next: i }
}

// --- attestation object -----------------------------------------------------

export function parseAttestationObject(buf) {
  const { value } = decodeCbor(buf, 0)
  if (!value || typeof value !== 'object') throw new Error('invalid attestationObject')
  return {
    fmt: value.fmt,
    attStmt: value.attStmt || {},
    authData: value.authData,
  }
}

// --- authenticator data (authData) ------------------------------------------
// Layout (WebAuthn §6.1):
//   rpIdHash(32) | flags(1) | signCount(4, BE) | [attestedCredentialData] | [extensions]
//   attestedCredentialData = aaguid(16) | credIdLen(2, BE) | credentialId | credentialPublicKey(CBOR)

export const AUTH_FLAGS = {
  UP: 0x01, // user present
  UV: 0x04, // user verified
  AT: 0x40, // attested credential data included
  ED: 0x80, // extension data included
}

export function parseAuthData(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  if (b.length < 37) throw new Error('authData too short')
  const rpIdHash = Buffer.from(b.subarray(0, 32))
  const flags = b[32]
  const counter = b.readUInt32BE(33)
  let offset = 37
  let aaguid = null
  let credentialId = null
  let cosePublicKey = null
  if (flags & AUTH_FLAGS.AT) {
    aaguid = Buffer.from(b.subarray(offset, offset + 16))
    offset += 16
    const credIdLen = b.readUInt16BE(offset)
    offset += 2
    credentialId = Buffer.from(b.subarray(offset, offset + credIdLen))
    offset += credIdLen
    const decoded = decodeCbor(b, offset)
    cosePublicKey = decoded.value
    offset = decoded.next
  }
  return { rpIdHash, flags, counter, aaguid, credentialId, cosePublicKey }
}

// --- COSE public key -> JWK -------------------------------------------------
// COSE_Key map keys: 1=kty, 3=alg, -1=crv/n, -2=x/e, -3=y.

export function cosePublicKeyToJwk(cose) {
  if (!cose || typeof cose !== 'object') throw new Error('invalid COSE key')
  const kty = cose[1]
  const alg = cose[3]
  if (kty === 2) {
    // EC2
    if (alg !== -7) throw new Error('unsupported EC alg ' + alg)
    if (cose[-1] !== 1) throw new Error('unsupported EC curve ' + cose[-1])
    const x = cose[-2]
    const y = cose[-3]
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('missing EC coordinates')
    return { alg, jwk: { kty: 'EC', crv: 'P-256', x: b64urlEncode(x), y: b64urlEncode(y) } }
  }
  if (kty === 3) {
    // RSA
    if (alg !== -257) throw new Error('unsupported RSA alg ' + alg)
    const n = cose[-1]
    const e = cose[-2]
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('missing RSA modulus/exponent')
    return { alg, jwk: { kty: 'RSA', n: b64urlEncode(n), e: b64urlEncode(e) } }
  }
  throw new Error('unsupported kty ' + kty)
}

export function jwkToPublicKeyPem(jwk) {
  return createPublicKey({ key: jwk, format: 'jwk' }).export({ type: 'spki', format: 'pem' })
}

// --- clientDataJSON ---------------------------------------------------------

export function decodeClientDataJSON(buf) {
  const text = Buffer.from(buf).toString('utf8')
  return JSON.parse(text)
}

// --- assertion signature verification ---------------------------------------
// signedData = authenticatorData || SHA-256(clientDataJSON)
// ES256 (-7): signature is ASN.1 DER (WebAuthn §6.5.2) -> node verifies directly.
// RS256 (-257): RSASSA-PSS with SHA-256, MGF1-SHA256, salt length 32.

export function verifyAssertionSignature({ publicKeyPem, alg, authenticatorData, clientDataJSON, signature }) {
  const clientDataHash = createHash('sha256').update(clientDataJSON).digest()
  const signedData = Buffer.concat([Buffer.from(authenticatorData), clientDataHash])
  const verifier = createVerify('sha256')
  verifier.update(signedData)
  if (alg === -7) {
    return verifier.verify(publicKeyPem, signature)
  }
  if (alg === -257) {
    return verifier.verify(
      { key: publicKeyPem, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 },
      signature,
    )
  }
  throw new Error('unsupported alg ' + alg)
}
