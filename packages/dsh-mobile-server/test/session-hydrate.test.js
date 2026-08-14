import test from "node:test";
import assert from "node:assert/strict";

import { reconcile, apply, name, inject } from "../src/session-hydrate.js";

/**
 * Faithful MOCK of the discovered dsh interfaces (see docs/research/session-hydration.md):
 *
 * - `sessionPersistence` service ("sessionPersistence"):
 *     list(signal)              -> SessionHeader[]   (directory index; header only)
 *     inspect(id, signal)       -> { meta, events }  (read-only cold read + validate)
 *     prepare(id, signal)       -> SessionPreparation{ session, [Symbol.dispose]() }
 * - `sessions` service ("sessions"):
 *     get(id) / list() / enter(session)->detach / announce(session)
 *
 * The mock models ONLY the leaf shapes this plugin consumes, so the tests run
 * offline without the real dsh runtime.
 */

function mockPersistence({ headers = [], failures = new Map(), prepareImpl } = {}) {
  const calls = { list: 0, inspect: 0, prepare: 0 };
  return {
    calls,
    async list() {
      calls.list += 1;
      return headers;
    },
    async inspect(id) {
      calls.inspect += 1;
      if (failures.has(id)) throw new Error(failures.get(id));
      return { meta: { id }, events: [] };
    },
    async prepare(id) {
      calls.prepare += 1;
      if (failures.has(id)) throw new Error(failures.get(id));
      if (prepareImpl) return prepareImpl(id);
      let disposed = false;
      const preparation = {
        session: { id, header: { id }, events: [] },
        [Symbol.dispose]() {
          disposed = true;
        },
        get disposed() {
          return disposed;
        },
      };
      return preparation;
    },
  };
}

function mockSessions(liveIds = []) {
  const store = new Map(liveIds.map((id) => [id, { id }]));
  const calls = { enter: 0, announce: 0 };
  const detachers = [];
  return {
    store,
    calls,
    detachers,
    get(id) {
      return store.get(id);
    },
    list() {
      return [...store.values()];
    },
    enter(session) {
      calls.enter += 1;
      store.set(session.id, session);
      const detach = () => {
        store.delete(session.id);
      };
      detachers.push(detach);
      return detach;
    },
    announce(session) {
      calls.announce += 1;
    },
  };
}

const silentLogger = { info() {}, warn() {} };

test("module exports a Cordis plugin shape", () => {
  assert.equal(name, "mobile-session-hydrate");
  assert.deepEqual(inject, ["sessions"]);
  assert.equal(typeof apply, "function");
  assert.equal(typeof reconcile, "function");
});

test("apply is inert when DSH_MOBILE_INSTANCE !== '1'", () => {
  const previous = process.env.DSH_MOBILE_INSTANCE;
  delete process.env.DSH_MOBILE_INSTANCE;
  try {
    const ctx = { get() { throw new Error("should not touch ctx"); } };
    assert.equal(apply(ctx), undefined);
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_INSTANCE;
    else process.env.DSH_MOBILE_INSTANCE = previous;
  }
});

test("apply is inert when the services are absent", () => {
  const previous = process.env.DSH_MOBILE_INSTANCE;
  process.env.DSH_MOBILE_INSTANCE = "1";
  try {
    const warnings = [];
    const ctx = {
      get() { return undefined; },
      logger: { warn: (m) => warnings.push(m) },
    };
    assert.equal(apply(ctx), undefined);
    assert.equal(warnings.length, 1);
  } finally {
    if (previous === undefined) delete process.env.DSH_MOBILE_INSTANCE;
    else process.env.DSH_MOBILE_INSTANCE = previous;
  }
});

test("reconcile (safe) skips live sessions and inspects cold ones", async () => {
  const persistence = mockPersistence({
    headers: [
      { id: "s-1", cwd: "/w" },
      { id: "s-2", cwd: "/w" },
      { id: "s-3", cwd: "/w" },
    ],
  });
  const sessions = mockSessions(["s-1"]);

  const report = await reconcile({ sessions, persistence, logger: silentLogger });

  assert.equal(report.found, 3);
  assert.equal(report.live, 1);
  assert.equal(report.cold, 2);
  assert.equal(persistence.calls.inspect, 2);
  assert.equal(sessions.calls.enter, 0);
  assert.equal(sessions.calls.announce, 0);
  assert.deepEqual(
    report.results.map((r) => [r.id, r.ok, r.attached]),
    [
      ["s-2", true, false],
      ["s-3", true, false],
    ],
  );
});

test("reconcile (safe) contains per-session inspect failures", async () => {
  const persistence = mockPersistence({
    headers: [
      { id: "bad", cwd: "/w" },
      { id: "good", cwd: "/w" },
    ],
    failures: new Map([["bad", "corrupt session log"]]),
  });
  const sessions = mockSessions();
  const warnings = [];
  const logger = { warn: (m) => warnings.push(m) };

  const report = await reconcile({ sessions, persistence, logger });

  assert.equal(report.cold, 2);
  assert.equal(report.results.length, 2);
  assert.equal(report.results[0].ok, false);
  assert.match(report.results[0].error, /corrupt session log/);
  assert.equal(report.results[1].ok, true);
  assert.equal(warnings.length, 1);
});

test("reconcile (attach) publishes cold sessions via prepare+enter+announce", async () => {
  const persistence = mockPersistence({
    headers: [
      { id: "s-1", cwd: "/w" },
      { id: "s-2", cwd: "/w" },
    ],
  });
  const sessions = mockSessions();
  const collected = [];

  const report = await reconcile({
    sessions,
    persistence,
    attach: true,
    logger: silentLogger,
    onAttach: (detach) => collected.push(detach),
  });

  assert.equal(report.cold, 2);
  assert.equal(persistence.calls.prepare, 2);
  assert.equal(sessions.calls.enter, 2);
  assert.equal(sessions.calls.announce, 2);
  assert.equal(collected.length, 2);
  assert.equal(report.results.every((r) => r.ok && r.attached), true);
  // both sessions are now live in the mock store
  assert.notEqual(sessions.get("s-1"), undefined);
  assert.notEqual(sessions.get("s-2"), undefined);

  // detachers remove them again (lifecycle correctness)
  collected.forEach((detach) => detach());
  assert.equal(sessions.get("s-1"), undefined);
  assert.equal(sessions.get("s-2"), undefined);
});

test("reconcile (attach) skips already-live sessions and disposes preparations", async () => {
  const dispositions = [];
  const persistence = mockPersistence({
    headers: [
      { id: "live", cwd: "/w" },
      { id: "cold", cwd: "/w" },
    ],
    prepareImpl(id) {
      let disposed = false;
      const preparation = {
        session: { id, header: { id }, events: [] },
        [Symbol.dispose]() {
          disposed = true;
          dispositions.push(id);
        },
      };
      return preparation;
    },
  });
  const sessions = mockSessions(["live"]);

  const report = await reconcile({
    sessions,
    persistence,
    attach: true,
    logger: silentLogger,
  });

  assert.equal(report.live, 1);
  assert.equal(report.cold, 1);
  assert.equal(persistence.calls.prepare, 1); // only the cold one
  assert.deepEqual(dispositions, ["cold"]); // preparation released after publish
});

test("reconcile (attach) reports per-session prepare failures", async () => {
  const persistence = mockPersistence({
    headers: [{ id: "boom", cwd: "/w" }],
    failures: new Map([["boom", "cannot prepare session while it is live"]]),
  });
  const sessions = mockSessions();

  const report = await reconcile({
    sessions,
    persistence,
    attach: true,
    logger: silentLogger,
  });

  assert.equal(report.results[0].ok, false);
  assert.equal(report.results[0].attached, false);
  assert.match(report.results[0].error, /cannot prepare session while it is live/);
});

test("reconcile tolerates a missing/empty header id", async () => {
  const persistence = mockPersistence({ headers: [{ id: "", cwd: "/w" }, null] });
  const sessions = mockSessions();

  const report = await reconcile({ sessions, persistence, logger: silentLogger });

  assert.equal(report.found, 2);
  assert.equal(report.cold, 0);
  assert.equal(report.results.length, 0);
});
