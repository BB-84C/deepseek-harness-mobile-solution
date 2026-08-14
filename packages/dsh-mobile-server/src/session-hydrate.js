/**
 * @bb-84c/dsh-mobile-server — resident "session sync" hydration plugin.
 *
 * PROBLEM. The resident dsh web instance (spawned by `dsh --profile mobile
 * service start`) and the deployment's own dsh instance share $DSH_HOME, so
 * both write session logs under $DSH_HOME/sessions. The resident instance's
 * in-memory SessionStore (`ctx.sessions`) only contains sessions created in
 * ITS OWN process; sessions persisted by the other instance stay "cold".
 *
 * MECHANISM (investigated, read-only, against the installed dsh):
 * - The in-memory store is the `"sessions"` service
 *   (@deepseek-ai/dsh-session/lib/index.js:1584 `super(ctx, "sessions")`).
 *   It has NO boot enumeration of persisted logs — persistence is a plugin
 *   concern, and cold sessions are "resumed on first touch".
 * - The durable backend is the `"sessionPersistence"` service
 *   (@deepseek-ai/dsh-session-persistence/lib/index.js:1351). The JSONL
 *   backend adds the OFFICIAL directory-index `list(signal)`
 *   (dsh-session-persistence-jsonl/lib/index.js:1037) and the read-only
 *   `inspect(id, signal)` / resumable `prepare(id, signal)`.
 * - The web session list ALREADY merges cold persisted sessions:
 *   `session.list` -> `listVisibleSessionSummaries` -> `ctx.sessions.list()`
 *   (attached) + `persistence.list()` (cold, cwd-defined)
 *   (@deepseek-ai/dsh-host-apiproxy/lib/index.js:2212-2257).
 * - Click/resume ALREADY works for cold sessions on demand:
 *   `session.create` -> `ensureSession`
 *   (dsh-host-apiproxy/lib/index.js:2130) and `session.prompt` ->
 *   `createApiRemoteAgentResolver.agentFor`
 *   (@deepseek-ai/dsh-api-remotes/lib/types/agent-lookup.js:87) both call
 *   `ctx.agents.resume({ resumeSessionId })` -> `AgentLoop.resumeWith`
 *   (@deepseek-ai/dsh-agent-loop/lib/index.js:1262) ->
 *   `sessionPersistence.prepare(id)`.
 *
 * WHY THIS PLUGIN DOES NOT ENTER SESSIONS INTO THE STORE BY DEFAULT.
 * Eagerly publishing a cold session into `ctx.sessions` makes it "live", and
 * the official resume path then REFUSES it:
 *   PersistenceCoordinator.prepare() throws
 *   `cannot prepare session "<id>" while it is live`
 *   (@deepseek-ai/dsh-session-persistence/lib/index.js:852).
 * A session entered without an agent is therefore un-resumable from the web:
 * clicking it and typing would fail with that exact error. Entering is
 * harmful, so the safe default below enumerates + validates + pre-warms the
 * cold sessions WITHOUT publishing them, and reports the real sync gap.
 *
 * SAFE DEFAULT (this plugin): for every persisted session NOT already live,
 * call the OFFICIAL read-only `sessionPersistence.inspect(id, signal)` — this
 * runs the full cold read (zstd decode + chunk-row expansion + header/event
 * validation + in-memory interrupted-tail repair) and warms the coordinator's
 * prepared cache, WITHOUT publishing, WITHOUT durable repair, and WITHOUT
 * breaking resume. Per-session failures are logged with their exact reason
 * (corruption, unsupported format version, unknown event type, …), which
 * surfaces the true cause of a "session not visible" symptom.
 *
 * OPT-IN ATTACH MODE (`DSH_MOBILE_SESSION_ATTACH=1`): additionally publish
 * each cold session into the store via the OFFICIAL
 * `sessionPersistence.prepare(id)` + `ctx.sessions.enter(session)` +
 * `ctx.sessions.announce(session)` transaction (the exact transaction
 * dsh-agent-loop uses at resume, minus the agent). This satisfies the literal
 * "cold-register into the store" request but carries the resume-conflict risk
 * documented above — use only if your deployment genuinely does not list cold
 * sessions, and verify the open/resume flow on the host afterwards.
 *
 * The plugin is completely inert unless DSH_MOBILE_INSTANCE === "1".
 */

export const name = "mobile-session-hydrate";
export const inject = ["sessions"];

/**
 * Reconcile persisted sessions against the live store.
 *
 * @param {object} deps
 * @param {{ get(id: string): any, enter(session: any): () => void, announce(session: any): void }} deps.sessions
 * @param {{ list(signal?: any): Promise<Array<{id: string, cwd?: string}>>,
 *           inspect(id: string, signal?: any): Promise<any>,
 *           prepare(id: string, signal?: any): Promise<any> }} deps.persistence
 * @param {boolean} [deps.attach]  when true, publish cold sessions into the store (see header).
 * @param {any} [deps.signal]      optional AbortSignal.
 * @param {any} [deps.logger]      optional ctx.logger-like object.
 * @param {(detach: () => void) => void} [deps.onAttach]  collects store-detachers in attach mode.
 * @returns {Promise<{found: number, live: number, cold: number, results: Array<{id: string, cwd?: string, ok: boolean, attached: boolean, error?: string}>}>}
 */
export async function reconcile({ sessions, persistence, attach = false, signal, logger, onAttach }) {
  const report = { found: 0, live: 0, cold: 0, results: [] };

  const headers = await persistence.list(signal);
  report.found = Array.isArray(headers) ? headers.length : 0;

  for (const header of headers ?? []) {
    if (signal?.aborted) break;
    const id = header?.id;
    if (typeof id !== "string" || id === "") continue;

    if (sessions.get(id) !== undefined) {
      report.live += 1;
      continue;
    }

    report.cold += 1;
    const result = { id, cwd: header?.cwd, ok: false, attached: false, error: undefined };

    try {
      if (attach) {
        // OFFICIAL resume-to-cold transaction (dsh-agent-loop/lib/index.js:1159-1161,
        // 1277, 1287): prepare -> enter -> announce -> dispose the preparation.
        const preparation = await persistence.prepare(id, signal);
        try {
          const session = preparation?.session;
          const detach = sessions.enter(session);
          sessions.announce(session);
          if (typeof onAttach === "function") onAttach(detach);
          result.attached = true;
        } finally {
          try {
            preparation?.[Symbol.dispose]?.();
          } catch {
            /* preparation release is best-effort */
          }
        }
      } else {
        // SAFE read-only validation + pre-warm (no publish, no durable repair).
        await persistence.inspect(id, signal);
      }
      result.ok = true;
    } catch (error) {
      result.error = String(error?.message ?? error);
      logger?.warn?.(`[mobile-session-hydrate] session "${id}" not hydratable: ${result.error}`);
    }

    report.results.push(result);
  }

  return report;
}

export function apply(ctx) {
  if (process.env.DSH_MOBILE_INSTANCE !== "1") return;

  const sessions = ctx.get("sessions");
  const persistence = ctx.get("sessionPersistence");
  const logger = ctx.logger;

  if (sessions === undefined || persistence === undefined) {
    logger?.warn?.(
      "[mobile-session-hydrate] sessions/sessionPersistence service absent; session hydration skipped",
    );
    return;
  }

  const attach = process.env.DSH_MOBILE_SESSION_ATTACH === "1";
  const abort = new AbortController();
  const detachers = [];

  const dispose = () => {
    abort.abort();
    for (const detach of detachers.splice(0)) {
      try {
        detach();
      } catch (error) {
        logger?.warn?.(`[mobile-session-hydrate] detach failed: ${String(error?.message ?? error)}`);
      }
    }
  };

  reconcile({ sessions, persistence, attach, signal: abort.signal, logger, onAttach: (detach) => detachers.push(detach) })
    .then((report) => {
      logger?.info?.(`[mobile-session-hydrate] ${JSON.stringify(report)}`);
    })
    .catch((error) => {
      logger?.warn?.(`[mobile-session-hydrate] hydration failed: ${String(error?.message ?? error)}`);
    });

  return dispose;
}
