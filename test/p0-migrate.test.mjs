import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { test } from "node:test";
import { applySqliteMigrations } from "../src/adapters/sqlite.js";
import {
  applyPlanToD1,
  applyPlanToMemory,
  applyPlanToPostgres,
  applyPlanToSqlite,
  listSqliteWorkouts,
  planWorkoutStarts,
  renderWorkoutStartSql,
  WORKOUT_STARTS_MIGRATION_ID,
} from "../src/core/workout-start-migration.js";
import { handleRequest } from "../src/core/http.js";
import { MemoryStorage } from "../src/core/memory.js";
import { d1FromSqlite, eachBackend, openPostgres, seedWorkout } from "./p0-backends.mjs";

const ZONE = "America/Los_Angeles";

function applyMemory(storage, timeZone) {
  const plan = planWorkoutStarts([...storage.workouts.values()], timeZone);
  applyPlanToMemory(storage, plan.actions);
  return plan;
}

async function applyBackend(backend, timeZone) {
  if (backend.kind === "memory") return applyMemory(backend.storage, timeZone);
  if (backend.kind === "postgres") {
    const listed = await backend.raw.query("SELECT name, start, date, duration_min, kcal, writer FROM workouts");
    const plan = planWorkoutStarts(listed.rows, timeZone);
    await applyPlanToPostgres(backend.raw, plan.actions, "2026-10-16T00:00:00.000Z");
    return plan;
  }
  const plan = planWorkoutStarts(listSqliteWorkouts(backend.raw), timeZone);
  if (backend.kind === "d1") applyPlanToD1(backend.raw, plan.actions, "2026-10-16T00:00:00.000Z");
  else applyPlanToSqlite(backend.raw, plan.actions, "2026-10-16T00:00:00.000Z");
  return plan;
}

async function rows(backend) {
  if (backend.kind === "memory") return [...backend.storage.workouts.values()];
  if (backend.kind === "postgres") {
    return (await backend.raw.query("SELECT name, start, date, duration_min, kcal, writer FROM workouts ORDER BY start")).rows;
  }
  return backend.raw.prepare("SELECT name, start, date, duration_min, kcal, writer FROM workouts ORDER BY start").all();
}

test("L1 L3 L4 L5 L6 L7 workout start backfill", async () => {
  await eachBackend(async (backend, name) => {
    await seedWorkout(backend, { name: "Run", start: "2026-10-04 08:00:00 -0700", date: "2026-10-04", duration_min: 30, kcal: 100, writer: null });
    await seedWorkout(backend, { name: "Run", start: "2026-10-04T15:00:00Z", date: "2026-10-04", duration_min: 30, kcal: 90, writer: null });
    await applyBackend(backend, ZONE);
    const l1 = await rows(backend);
    assert.equal(l1.length, 1, name);
    assert.equal(l1[0].start, "2026-10-04T15:00:00.000Z", name);

    const make = (start, duration) => ({ name: "Lift", start, date: "2026-10-05", duration_min: duration, kcal: 10, writer: null });
    const offsetForm = "2026-10-05 11:00:00 -0700";
    const zuluForm = "2026-10-05T18:00:00Z";
    const colonForm = "2026-10-05T18:00:00+00:00";
    await seedWorkout(backend, make(zuluForm, 10));
    await seedWorkout(backend, make(offsetForm, 40));
    await seedWorkout(backend, make(colonForm, 20));
    const first = planWorkoutStarts([make(zuluForm, 10), make(offsetForm, 40), make(colonForm, 20)], ZONE);
    const second = planWorkoutStarts([make(colonForm, 20), make(zuluForm, 10), make(offsetForm, 40)], ZONE);
    const winnerStart = (plan) => plan.actions.find((action) => action.update)?.update.start;
    assert.equal(first.actions.length, 1, name);
    assert.equal(second.actions.length, 1, name);
    assert.equal(winnerStart(first), offsetForm, name);
    assert.equal(winnerStart(second), offsetForm, name);
    await applyBackend(backend, ZONE);
    const lifts = (await rows(backend)).filter((row) => row.name === "Lift");
    assert.equal(lifts.length, 1, name);
    assert.equal(lifts[0].start, "2026-10-05T18:00:00.000Z", name);
    assert.equal(Number(lifts[0].duration_min), 40, name);

    const before = JSON.stringify(await rows(backend));
    const secondRun = await applyBackend(backend, ZONE);
    assert.equal(secondRun.unparseable, 0, name);
    assert.equal(JSON.stringify(await rows(backend)), before, name);

    await seedWorkout(backend, { name: "Bad", start: "not-a-date", date: "2026-10-06", duration_min: 5, kcal: 1, writer: null });
    const counted = await applyBackend(backend, ZONE);
    assert.equal(counted.unparseable, 1, name);
    assert.equal((await rows(backend)).some((row) => row.start === "not-a-date"), true, name);

    await seedWorkout(backend, { name: "Zone", start: "2026-10-07 08:00:00 -0700", date: "2026-10-07", duration_min: 10, kcal: 1, writer: null });
    await seedWorkout(backend, { name: "Zone", start: "2026-10-07T15:00:00+00:00", date: "2026-10-07", duration_min: 10, kcal: 1, writer: null });
    await seedWorkout(backend, { name: "Zone", start: "2026-10-07T15:00:00.000Z", date: "2026-10-07", duration_min: 10, kcal: 1, writer: null });
    await applyBackend(backend, ZONE);
    const zones = (await rows(backend)).filter((row) => row.name === "Zone");
    assert.equal(zones.length, 1, name);
    assert.equal(zones[0].start, "2026-10-07T15:00:00.000Z", name);

    await seedWorkout(backend, { name: "Late", start: "2026-10-14 23:30:00 -0700", date: "2026-10-14", duration_min: 20, kcal: 5, writer: null });
    await applyBackend(backend, ZONE);
    const late = (await rows(backend)).find((row) => row.name === "Late");
    assert.equal(late.start, "2026-10-15T06:30:00.000Z", name);
    assert.equal(late.date, "2026-10-14", name);

    if (backend.kind !== "memory") {
      const marked = backend.kind === "postgres"
        ? (await backend.raw.query("SELECT id FROM schema_migrations WHERE id = $1", [WORKOUT_STARTS_MIGRATION_ID])).rows
        : backend.raw.prepare("SELECT id FROM schema_migrations WHERE id = ?").all(WORKOUT_STARTS_MIGRATION_ID);
      assert.equal(marked.length, 1, name);
    }
  });
});

test("a URL-token row does not replace a bearer row or a legacy NULL row", async () => {
  await eachBackend(async (backend, name) => {
    await seedWorkout(backend, {
      name: "Running",
      start: "2026-10-15T15:00:00Z",
      date: "2026-10-15",
      duration_min: 30,
      kcal: 300,
      writer: "bearer",
    });
    await seedWorkout(backend, {
      name: "Running",
      start: "2026-10-15T15:00:00.000Z",
      date: "2026-10-15",
      duration_min: 90,
      kcal: 1,
      writer: "url",
    });
    await seedWorkout(backend, {
      name: "Walk",
      start: "2026-10-16T15:00:00Z",
      date: "2026-10-16",
      duration_min: 20,
      kcal: 100,
      writer: null,
    });
    await seedWorkout(backend, {
      name: "Walk",
      start: "2026-10-16T15:00:00.000Z",
      date: "2026-10-16",
      duration_min: 90,
      kcal: 1,
      writer: "url",
    });
    const plan = await applyBackend(backend, "UTC");
    const running = plan.actions.find((action) => action.update?.name === "Running" || action.deletes.some((row) => row.name === "Running"));
    const walk = plan.actions.find((action) => action.update?.name === "Walk" || action.deletes.some((row) => row.name === "Walk"));
    assert.equal(running.deletes.some((row) => row.start === "2026-10-15T15:00:00Z"), false, name);
    assert.equal(running.deletes.some((row) => row.start === "2026-10-15T15:00:00.000Z"), true, name);
    assert.equal(walk.deletes.some((row) => row.start === "2026-10-16T15:00:00Z"), false, name);
    assert.equal(walk.deletes.some((row) => row.start === "2026-10-16T15:00:00.000Z"), true, name);
    const stored = await rows(backend);
    const run = stored.filter((row) => row.name === "Running");
    const walks = stored.filter((row) => row.name === "Walk");
    assert.equal(run.length, 1, name);
    assert.equal(run[0].start, "2026-10-15T15:00:00.000Z", name);
    assert.equal(Number(run[0].duration_min), 30, name);
    assert.equal(Number(run[0].kcal), 300, name);
    assert.equal(run[0].writer, "bearer", name);
    assert.equal(walks.length, 1, name);
    assert.equal(walks[0].start, "2026-10-16T15:00:00.000Z", name);
    assert.equal(Number(walks[0].duration_min), 20, name);
    assert.equal(Number(walks[0].kcal), 100, name);
    assert.equal(walks[0].writer ?? null, null, name);
  });
});

test("L2 bearer resend stays one row and a URL resend does not change it", async () => {
  const storage = new MemoryStorage({ timeZone: ZONE });
  const legacyStart = "2026-10-04 08:00:00 -0700";
  storage.workouts.set(`Run\0${legacyStart}`, {
    name: "Run",
    start: legacyStart,
    date: "2026-10-04",
    duration_min: 30,
    kcal: 100,
    writer: null,
  });
  applyMemory(storage, ZONE);
  const ctx = { token: "tok", timeZone: ZONE, storage, now: new Date("2026-10-16T12:00:00Z") };
  const bearer = await handleRequest(new Request("http://localhost/ingest/shortcuts", {
    method: "POST",
    headers: { authorization: "Bearer tok", "content-type": "application/json" },
    body: JSON.stringify({ workouts: [{ type: "Run", start: "2026-10-04T15:00:00.000Z", duration: "1800", energy: "120" }] }),
  }), ctx);
  assert.equal(bearer.status, 200);
  assert.equal(storage.workouts.size, 1);
  const url = await handleRequest(new Request("http://localhost/ingest/shortcuts?token=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workouts: [{ type: "Run", start: "2026-10-04T15:00:00.000Z", duration: "60", energy: "1" }] }),
  }), { ...ctx, urlToken: `${"b".repeat(31)}-` });
  assert.equal(url.status, 200);
  assert.equal(storage.workouts.size, 1);
  const row = [...storage.workouts.values()][0];
  assert.equal(row.duration_min, 30);
  assert.equal(row.kcal, 120);
});

test("rendered D1 SQL is applied only by a local executor", () => {
  const plan = planWorkoutStarts([
    { name: "Run", start: "2026-10-04 08:00:00 -0700", date: "2026-10-04", duration_min: 30, kcal: 1 },
  ], ZONE);
  const sql = renderWorkoutStartSql(plan.actions, "2026-10-16T00:00:00.000Z");
  assert.match(sql, /2026-10-04T15:00:00.000Z/);
  assert.match(sql, new RegExp(WORKOUT_STARTS_MIGRATION_ID));
  const db = new Database(":memory:");
  applySqliteMigrations(db);
  db.prepare("INSERT INTO workouts (name, start, date, duration_min, kcal, writer) VALUES (?, ?, ?, ?, ?, ?)").run(
    "Run", "2026-10-04 08:00:00 -0700", "2026-10-04", 30, 1, null,
  );
  db.exec(sql);
  const row = db.prepare("SELECT start, date FROM workouts").get();
  assert.equal(row.start, "2026-10-04T15:00:00.000Z");
  assert.equal(row.date, "2026-10-04");
  db.close();
  void d1FromSqlite;
  void openPostgres;
});
