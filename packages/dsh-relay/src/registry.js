// Instance registry: tracks live instance tunnels plus a memory of instances
// that have ever registered (so we can tell "offline" from "unknown").
// Also owns the per-instance inflight stream map (32-stream cap, 30s idle).

const MAX_STREAMS_PER_INSTANCE = 32
const STREAM_IDLE_TIMEOUT_MS = 30_000
const ID_NAME_RE = /^[a-z0-9-]{1,64}$/

export class Registry {
  constructor(opts = {}) {
    this.maxStreams = opts.maxStreams ?? MAX_STREAMS_PER_INSTANCE
    this.idleTimeoutMs = opts.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS
    // Live tunnels only: id -> { id, name, socket, authHash, lastSeen, streams }
    this.instances = new Map()
    // Everything ever registered: id -> { id, name, lastSeen, authHash }
    this.known = new Map()
  }

  validateId(id) {
    return typeof id === 'string' && ID_NAME_RE.test(id)
  }

  validateName(name) {
    return typeof name === 'string' && ID_NAME_RE.test(name)
  }

  // Register (or replace) a live instance. Throws on invalid id/name.
  register(id, name, socket, authHash) {
    if (!this.validateId(id)) throw new Error('invalid instance id')
    if (!this.validateName(name)) throw new Error('invalid instance name')
    const now = Date.now()
    const existing = this.instances.get(id)
    if (existing) this.unregister(id)
    const inst = {
      id,
      name,
      socket,
      authHash,
      lastSeen: now,
      streams: new Map(),
    }
    this.instances.set(id, inst)
    this.known.set(id, { id, name, lastSeen: now, authHash })
    return inst
  }

  // Remove a live instance (keeps it in `known` as offline).
  unregister(id) {
    const inst = this.instances.get(id)
    if (!inst) return
    for (const stream of inst.streams.values()) stream.clear()
    inst.streams.clear()
    this.instances.delete(id)
    const known = this.known.get(id)
    if (known) known.lastSeen = Date.now()
  }

  has(id) {
    return this.known.has(id)
  }

  get(id) {
    return this.instances.get(id) || null
  }

  touch(id) {
    const inst = this.instances.get(id)
    if (!inst) return
    inst.lastSeen = Date.now()
    const known = this.known.get(id)
    if (known) known.lastSeen = inst.lastSeen
  }

  // Online + offline inventory for the targets API.
  list() {
    return [...this.known.values()].map((k) => ({
      id: k.id,
      name: k.name,
      online: this.instances.has(k.id),
      lastSeenMs: k.lastSeen,
    }))
  }

  // Open an inflight stream on an instance. Returns { stream } on success or
  // { error } when the instance is offline or the 32-stream cap is hit.
  // `onIdle` fires once if the stream stays idle for the idle timeout.
  openStream(id, streamId, onIdle) {
    const inst = this.instances.get(id)
    if (!inst) return { error: 'instance-offline' }
    if (inst.streams.size >= this.maxStreams) return { error: 'stream-limit' }
    let timer = setTimeout(() => {
      inst.streams.delete(streamId)
      if (typeof onIdle === 'function') onIdle()
    }, this.idleTimeoutMs)
    if (timer.unref) timer.unref()
    const stream = {
      reset() {
        clearTimeout(timer)
        timer = setTimeout(() => {
          inst.streams.delete(streamId)
          if (typeof onIdle === 'function') onIdle()
        }, this.idleTimeoutMs)
        if (timer.unref) timer.unref()
      },
      clear() {
        clearTimeout(timer)
      },
    }
    inst.streams.set(streamId, stream)
    return { stream }
  }

  closeStream(id, streamId) {
    const inst = this.instances.get(id)
    if (!inst) return
    const stream = inst.streams.get(streamId)
    if (stream) {
      stream.clear()
      inst.streams.delete(streamId)
    }
  }

  // Close every live tunnel authenticated with the given token hash.
  dropByToken(authHash) {
    for (const inst of [...this.instances.values()]) {
      if (inst.authHash === authHash) {
        try {
          inst.socket.close(1008, 'token revoked')
        } catch {
          /* ignore */
        }
        this.unregister(inst.id)
      }
    }
  }

  closeAll() {
    for (const inst of [...this.instances.values()]) {
      try {
        inst.socket.close(1001, 'relay shutting down')
      } catch {
        /* ignore */
      }
    }
  }
}

export const LIMITS = {
  MAX_STREAMS_PER_INSTANCE,
  STREAM_IDLE_TIMEOUT_MS,
}
