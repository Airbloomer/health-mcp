import assert from "node:assert/strict";
import { test } from "node:test";
import { eachBackend, seedWorkout } from "./p0-backends.mjs";

const DAY = "2026-10-14";

async function seed(backend, rows) {
  for (const row of rows) await seedWorkout(backend, row);
}

function iso(ms) {
  return new Date(ms).toISOString();
}

test("D1 D1b real names and isIndoor is ignored", async () => {
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Traditional Strength Training", start: "2026-10-14 17:30:00 -0700", date: DAY, duration_min: 45, kcal: 310, writer: null },
      { name: "Strength Training", start: "2026-10-15T00:30:00.000Z", date: DAY, duration_min: 45, kcal: null, writer: "bearer" },
    ]);
    const rows = await backend.storage.listWorkouts(DAY, DAY);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].name, "Strength Training");
    assert.equal(rows[0].start, "2026-10-15T00:30:00.000Z");
    assert.equal(rows[0].kcal, 310);
    const summary = await backend.storage.queryDaySummary(DAY);
    assert.equal(summary.workouts.length, 1);
    assert.equal(summary.workouts[0].kcal, 310);

    await seed(backend, [
      { name: "Running", start: "2026-10-14T18:00:00.000Z", date: DAY, duration_min: 30, kcal: 200, writer: null },
      { name: "Running", start: "2026-10-14T18:00:30.000Z", date: DAY, duration_min: 30, kcal: 180, writer: "bearer" },
    ]);
    const runs = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Running");
    assert.equal(runs.length, 1);
  });
});

test("D2 D3 D13 tolerance edges", async () => {
  await eachBackend(async (backend) => {
    const base = Date.parse("2026-10-14T15:00:00.000Z");
    await seed(backend, [
      { name: "Running", start: iso(base), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
      { name: "Running", start: iso(base + 90_000), date: DAY, duration_min: 30.5, kcal: 1, writer: "bearer" },
      { name: "Running", start: iso(base + 3_600_000), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
    ]);
    const near = await backend.storage.listWorkouts(DAY, DAY);
    assert.equal(near.length, 2);
    await seed(backend, [
      { name: "Walking", start: iso(base + 10_000_000), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
      { name: "Walking", start: iso(base + 10_180_000), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
      { name: "Walking", start: iso(base + 20_000_000), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
      { name: "Walking", start: iso(base + 20_001_000), date: DAY, duration_min: 25, kcal: 1, writer: "bearer" },
    ]);
    const walks = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Walking");
    assert.equal(walks.length, 4);
    await seed(backend, [
      { name: "Yoga", start: iso(base + 30_000_000), date: DAY, duration_min: 1, kcal: 1, writer: "bearer" },
      { name: "Yoga", start: iso(base + 30_090_000), date: DAY, duration_min: 1, kcal: 1, writer: "bearer" },
    ]);
    const yoga = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Yoga");
    assert.equal(yoga.length, 2);
  });
});

test("D4 D8 D9 winner order and anchor clustering", async () => {
  await eachBackend(async (backend, name) => {
    const rowsFor = (order) => order.map((row) => row);
    const a = { name: "Run A", start: "2026-10-14T12:00:00.000Z", date: DAY, duration_min: 40, kcal: 10, writer: "bearer" };
    const b = { name: "Run A", start: "2026-10-14T12:00:01.000Z", date: DAY, duration_min: 39, kcal: 50, writer: "bearer" };
    const c = { name: "Run A", start: "2026-10-14T12:00:02.000Z", date: DAY, duration_min: 39.5, kcal: 5, writer: null };
    for (const order of [[a, b, c], [c, a, b]]) {
      const fresh = backend;
      if (order !== [a, b, c] && name !== "memory") continue;
    }
    await seed(backend, [a, b, c]);
    const won = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Run A");
    assert.equal(won.length, 1, name);
    assert.equal(Number(won[0].duration_min), 40, name);
    assert.equal(won[0].start, a.start, name);

    const t = Date.parse("2026-10-14T16:00:00.000Z");
    const chain = [
      { name: "Walk", start: iso(t), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
      { name: "Walk", start: iso(t + 100_000), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
      { name: "Walk", start: iso(t + 200_000), date: DAY, duration_min: 30, kcal: 1, writer: "bearer" },
    ];
    await seed(backend, chain);
    const clustered = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Walk");
    assert.equal(clustered.length, 2, name);
    assert.equal(clustered.some((row) => row.start === chain[2].start), true, name);

    await seed(backend, [
      { name: "Strength Training", start: "2026-10-14T19:00:00.000Z", date: DAY, duration_min: 45, kcal: null, writer: "bearer" },
      { name: "Traditional Strength Training", start: "2026-10-14 12:00:00 -0700", date: DAY, duration_min: 45, kcal: 310, writer: null },
    ]);
    const lift = (await backend.storage.listWorkouts(DAY, DAY)).find((row) => row.start === "2026-10-14T19:00:00.000Z");
    assert.equal(Number(lift.duration_min), 45, name);
    assert.equal(Number(lift.kcal), 310, name);
    void rowsFor;
  });
});

test("D5 D6 unparseable starts and read-only dedupe", async () => {
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Odd", start: "not-a-date", date: DAY, duration_min: 10, kcal: 1, writer: null },
      { name: "Odd", start: "2026-10-14T12:00:00.000Z", date: DAY, duration_min: 10, kcal: 1, writer: "bearer" },
    ]);
    const before = backend.kind === "memory" ? backend.storage.workouts.size : null;
    const rows = await backend.storage.listWorkouts(DAY, DAY);
    assert.equal(rows.filter((row) => row.name === "Odd").length, 2);
    assert.equal(rows.some((row) => row.start === "not-a-date"), true);
    await backend.storage.queryDaySummary(DAY);
    await backend.storage.listWorkouts(DAY, DAY);
    if (before != null) assert.equal(backend.storage.workouts.size, before);
  });
});

test("D7 removed adapter names match strength training", async () => {
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Traditional Strength Training", start: "2026-10-14T21:00:00.000Z", date: DAY, duration_min: 40, kcal: 200, writer: null },
      { name: "Strength Training", start: "2026-10-14T21:00:30.000Z", date: DAY, duration_min: 40, kcal: 180, writer: "bearer" },
    ]);
    const rows = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.duration_min === 40 && (row.name === "Strength Training" || row.name === "Traditional Strength Training"));
    assert.equal(rows.length, 1);
  });
});

test("D10 URL rows do not win or supply kcal", async () => {
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Ride", start: "2026-10-14T22:00:00.000Z", date: DAY, duration_min: 40, kcal: 250, writer: "bearer" },
      { name: "Ride", start: "2026-10-14T22:01:00.000Z", date: DAY, duration_min: 40, kcal: 999, writer: "url" },
      { name: "Swim", start: "2026-10-14 15:00:00 -0700", date: DAY, duration_min: 20, kcal: 80, writer: null },
      { name: "Swim", start: "2026-10-14T22:00:30.000Z", date: DAY, duration_min: 20, kcal: 999, writer: "url" },
    ]);
    const ride = (await backend.storage.listWorkouts(DAY, DAY)).find((row) => row.name === "Ride");
    assert.equal(ride.kcal, 250);
    assert.equal(ride.start, "2026-10-14T22:00:00.000Z");
    const swim = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Swim");
    assert.equal(swim.length, 1);
    assert.equal(swim[0].kcal, 80);
  });
});

test("D11 a near-midnight pair is shown once on the winner date", async () => {
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Night", start: "2026-10-14 23:30:00 -0700", date: "2026-10-14", duration_min: 45, kcal: 100, writer: null },
      { name: "Night", start: "2026-10-15 06:30:00 +0000", date: "2026-10-15", duration_min: 44, kcal: 50, writer: "bearer" },
    ]);
    const fourteenth = await backend.storage.listWorkouts("2026-10-14", "2026-10-14");
    const fifteenth = await backend.storage.listWorkouts("2026-10-15", "2026-10-15");
    const range = await backend.storage.listWorkouts("2026-10-14", "2026-10-15");
    assert.equal(fourteenth.filter((row) => row.name === "Night").length, 1);
    assert.equal(fifteenth.filter((row) => row.name === "Night").length, 0);
    assert.equal(range.filter((row) => row.name === "Night").length, 1);
  });
});

test("D12 legacy start formats match", async () => {
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Format", start: "2026-10-14 17:30:00 -0700", date: DAY, duration_min: 30, kcal: 10, writer: null },
      { name: "Format", start: "2026-10-15T00:30:00-00:00", date: DAY, duration_min: 30, kcal: 11, writer: null },
      { name: "Format", start: "2026-10-15T00:30:00Z", date: DAY, duration_min: 30, kcal: 12, writer: null },
      { name: "Format", start: "2026-10-15T00:30:00.000Z", date: DAY, duration_min: 30, kcal: 13, writer: "bearer" },
    ]);
    const rows = (await backend.storage.listWorkouts(DAY, DAY)).filter((row) => row.name === "Format");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].start, "2026-10-15T00:30:00.000Z");
  });
});

test("D14 duration formula, including the 300s cap", async () => {
  // The spec example says a 3h ride 250s apart merges. 2% of 3h is 216s, so 250s does not.
  // The formula wins. Rides long enough for the 300s cap merge at 250s and stay apart at 310s.
  await eachBackend(async (backend) => {
    await seed(backend, [
      { name: "Three", start: "2026-10-14T08:00:00.000Z", date: DAY, duration_min: 180, kcal: 1, writer: "bearer" },
      { name: "Three", start: "2026-10-14T08:00:01.000Z", date: DAY, duration_min: 180 - 200 / 60, kcal: 1, writer: "bearer" },
      { name: "ThreeB", start: "2026-10-14T09:00:00.000Z", date: DAY, duration_min: 180, kcal: 1, writer: "bearer" },
      { name: "ThreeB", start: "2026-10-14T09:00:01.000Z", date: DAY, duration_min: 180 - 250 / 60, kcal: 1, writer: "bearer" },
      { name: "Long", start: "2026-10-14T10:00:00.000Z", date: DAY, duration_min: 260, kcal: 1, writer: "bearer" },
      { name: "Long", start: "2026-10-14T10:00:01.000Z", date: DAY, duration_min: 260 - 250 / 60, kcal: 1, writer: "bearer" },
      { name: "LongB", start: "2026-10-14T11:00:00.000Z", date: DAY, duration_min: 260, kcal: 1, writer: "bearer" },
      { name: "LongB", start: "2026-10-14T11:00:01.000Z", date: DAY, duration_min: 260 - 310 / 60, kcal: 1, writer: "bearer" },
    ]);
    const rows = await backend.storage.listWorkouts(DAY, DAY);
    assert.equal(rows.filter((row) => row.name === "Three").length, 1);
    assert.equal(rows.filter((row) => row.name === "ThreeB").length, 2);
    assert.equal(rows.filter((row) => row.name === "Long").length, 1);
    assert.equal(rows.filter((row) => row.name === "LongB").length, 2);
  });
});
