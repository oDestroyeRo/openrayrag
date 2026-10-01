import { describe, expect, it } from "vitest";
import cases from "./data/supply-boundary-cases.json";
import {
  DEFAULT_SUPPLY,
  validateSupplySettings,
  validateSupplyResumeGuard,
  type SupplyResumeGuard,
} from "./supply-trip";
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  validateSettings,
} from "./settings";
import { ProfileStore } from "./profiles";
import { PersistentFieldRun } from "./reconnect";
import { validFeatureStatus } from "./feature-ui";
const settings = {
  ...DEFAULT_SETTINGS,
  map: "prt_fild08",
  targets: [4000],
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    supply: { ...DEFAULT_SUPPLY, enabled: true, maxTrips: 3 },
    disposition: { maxSpend: 1000, rules: [] },
  },
};
const guard: SupplyResumeGuard = {
  version: 1,
  character: "Tester",
  latched: true,
  remainingTrips: 2,
  actions: 4,
  spent: 100,
  reserved: 120,
  intervalSeconds: 300,
  deadlineSeconds: 500,
  interrupted: true,
  uncertain: true,
  returnDestination: { map: "prt_fild08", position: { x: 100, y: 101 } },
};
describe("supply successor and disabled guard repair", () => {
  it("allocates only the first enabled allowance before a page can reload without telemetry", () => {
    const run = new PersistentFieldRun(() => 100000),
      disabled = {
        ...settings,
        automation: {
          ...settings.automation,
          supply: { ...settings.automation.supply, enabled: false },
        },
      };
    run.begin(disabled, "Tester", "off");
    expect(run.supplyGuardForStart(settings, "Tester", "off")).toBeUndefined();
    run.begin(settings, "Tester", "old");
    expect(run.supplyGuardForStart(settings, "Tester", "old")).toMatchObject({
      remainingTrips: 3,
      uncertain: false,
    });
    const request = run.resumeFor({
      sessionId: "new",
      connected: true,
      compatible: true,
      map: "prt_fild05",
      player: { name: "Tester" },
    })!;
    expect(request.supplyGuard).toMatchObject({
      remainingTrips: 2,
      uncertain: true,
      interrupted: true,
      returnDestination: null,
    });
  });

  it("accepts same-allowance fresh reconciliation only after a successful successor handoff", () => {
    const run = new PersistentFieldRun(() => 100000),
      old = {
        sessionId: "old",
        connected: true,
        compatible: true,
        map: "prt_fild08",
        player: { name: "Tester" },
        supplyGuard: guard,
      };
    run.begin(settings, "Tester", "old");
    run.observe(old);
    const next = { ...old, sessionId: "new" };
    const request = run.resumeFor(next)!;
    expect(run.completeResume(request, true)).toBe(true);
    run.observe({
      ...next,
      supplyGuard: {
        ...request.supplyGuard!,
        uncertain: false,
        interrupted: true,
      },
    });
    expect(run.supplyGuardForStart(settings, "Tester", "new")).toMatchObject({
      remainingTrips: 2,
      uncertain: false,
      interrupted: false,
      returnDestination: null,
      reserved: 120,
    });
  });
  it("rejects a foreign-character successor completion without consuming the pending handoff", () => {
    const run = new PersistentFieldRun(() => 100000),
      old = {
        sessionId: "old",
        connected: true,
        compatible: true,
        map: "prt_fild08",
        player: { name: "Tester" },
        supplyGuard: guard,
      };
    run.begin(settings, "Tester", "old");
    run.observe(old);
    const request = run.resumeFor({ ...old, sessionId: "new" })!;
    expect(
      run.completeResume(
        {
          ...request,
          supplyGuard: { ...request.supplyGuard!, character: "Other" },
        },
        true,
      ),
    ).toBe(false);
    expect(run.completeResume(request, true)).toBe(true);
    expect(run.supplyGuardForStart(settings, "Other", "new")).toBeUndefined();
    expect(run.supplyGuardForStart(settings, "Tester", "new")).toMatchObject({
      remainingTrips: 2,
      uncertain: true,
    });
  });
  it("keeps newer conservative publication while a successor Start is awaiting completion", () => {
    const run = new PersistentFieldRun(() => 100000),
      old = {
        sessionId: "old",
        connected: true,
        compatible: true,
        map: "prt_fild08",
        player: { name: "Tester" },
        supplyGuard: guard,
      };
    run.begin(settings, "Tester", "old");
    run.observe(old);
    const request = run.resumeFor({ ...old, sessionId: "new" })!;
    run.observe({
      ...old,
      supplyGuard: { ...guard, remainingTrips: 1, reserved: 200 },
    });
    expect(run.completeResume(request, true)).toBe(true);
    expect(run.supplyGuardForStart(settings, "Tester", "new")).toMatchObject({
      remainingTrips: 1,
      reserved: 200,
      uncertain: true,
    });
  });
  it("preserves a newer same-page sent receipt when an earlier explicit Start completes", () => {
    const run = new PersistentFieldRun(() => 100000),
      status = {
        sessionId: "one",
        connected: true,
        compatible: true,
        map: "prt_fild08",
        player: { name: "Tester" },
      };
    run.observe({
      ...status,
      supplyGuard: {
        ...guard,
        uncertain: false,
        interrupted: false,
        latched: false,
        returnDestination: null,
      },
    });
    const earlier = run.supplyGuardForStart(settings, "Tester", "one")!;
    run.observe({
      ...status,
      supplyGuard: {
        ...guard,
        uncertain: true,
        latched: true,
        intervalSeconds: 600,
        deadlineSeconds: 450,
      },
    });
    run.completeSupplyStart("Tester", "one", earlier);
    expect(run.supplyGuardForStart(settings, "Tester", "one")).toMatchObject({
      uncertain: true,
      interrupted: true,
      latched: true,
      intervalSeconds: 600,
      deadlineSeconds: 450,
      returnDestination: guard.returnDestination,
    });
  });
  it("keeps guarded completion bounded at64 retained characters", () => {
    const run = new PersistentFieldRun(() => 100000);
    for (let i = 0; i < 64; i++)
      run.completeSupplyStart(`Character${i}`, "page", {
        ...guard,
        character: `Character${i}`,
      });
    run.completeSupplyStart("Overflow", "page", {
      ...guard,
      character: "Overflow",
      uncertain: false,
    });
    expect(run.supplyGuardForStart(settings, "Overflow", "page")).toMatchObject(
      { remainingTrips: 0, uncertain: true, interrupted: true },
    );
    expect(
      run.supplyGuardForStart(settings, "Character0", "page"),
    ).toMatchObject({ remainingTrips: 2, reserved: 120 });
  });
  it("retains consumed trip allowance when disabled/default telemetry is published", () => {
    const run = new PersistentFieldRun(() => 100000),
      status = {
        sessionId: "one",
        connected: true,
        compatible: true,
        map: "prt_fild08",
        player: { name: "Tester" },
      };
    run.observe({
      ...status,
      supplyGuard: { ...guard, remainingTrips: 0, uncertain: false },
    });
    const disabled = {
      ...settings,
      automation: {
        ...settings.automation,
        supply: { ...settings.automation.supply, enabled: false },
      },
    };
    const forwarded = run.supplyGuardForStart(disabled, "Tester", "one");
    expect(forwarded?.remainingTrips).toBe(0);
    run.completeSupplyStart("Tester", "one", forwarded);
    run.observe({
      ...status,
      supplyGuard: {
        ...guard,
        remainingTrips: 3,
        uncertain: false,
        interrupted: false,
        reserved: 0,
      },
    });
    expect(run.supplyGuardForStart(settings, "Tester", "one")).toMatchObject({
      remainingTrips: 0,
      reserved: 120,
    });
  });
});
describe("supply settings, profile and reload boundaries", () => {
  it.each(cases)("$name", (row) => {
    let valid = true;
    try {
      if (row.kind === "settings") validateSupplySettings(row.value);
      else validateSupplyResumeGuard(row.value);
    } catch {
      valid = false;
    }
    expect(valid).toBe(row.valid);
  });
  it("preserves optional absence/escape defaults and rejects null/unknown supply fields", () => {
    const legacy = {
      ...DEFAULT_SETTINGS,
      map: "prt_fild08",
      targets: [4000],
      automation: structuredClone(DEFAULT_AUTOMATION),
    };
    delete legacy.automation.escape;
    expect(validateSettings(legacy).automation?.escape).toEqual(
      DEFAULT_AUTOMATION.escape,
    );
    expect(validateSettings(legacy).automation).not.toHaveProperty("supply");
    expect(validateSettings(settings).automation?.supply).toEqual(
      settings.automation.supply,
    );
    for (const value of [
      null,
      { ...DEFAULT_SUPPLY, command: { type: "shop" } },
      undefined,
    ])
      expect(() =>
        validateSettings({
          ...settings,
          automation: { ...settings.automation, supply: value } as never,
        }),
      ).toThrow();
  });
  it("imports a detached profile atomically without transaction or actor state", () => {
    const storage = new Map<string, string>(),
      backend = {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => {
          storage.set(key, value);
        },
      };
    let id = 0;
    const store = new ProfileStore(
      backend,
      () => `profile-${++id}`,
      () => 1,
    );
    const saved = store.save("Supplies", "Tester", settings),
      document = store.export(saved.id);
    expect(store.import(document)[0]?.settings.automation?.supply).toEqual(
      settings.automation.supply,
    );
    const before = [...storage];
    const invalid = JSON.parse(document);
    invalid.profiles[0].settings.automation.supply.npcId = 20;
    expect(() => store.import(JSON.stringify(invalid))).toThrow();
    expect([...storage]).toEqual(before);
    expect(document).not.toContain("returnDestination");
    expect(document).not.toContain("uncertain");
  });
  it("retains spent allowance, latch and reservation through Stop and page reload; blank pages cannot replenish it", () => {
    let now = 100000;
    const run = new PersistentFieldRun(() => now);
    run.begin(settings, "Tester", "old");
    run.observe({
      sessionId: "old",
      connected: true,
      compatible: true,
      map: "prt_fild08",
      player: { name: "Tester" },
      supplyGuard: guard,
    });
    now += 100000;
    run.observe({
      sessionId: "new",
      connected: true,
      compatible: true,
      map: "prontera",
      player: { name: "Tester" },
      supplyGuard: {
        ...guard,
        remainingTrips: 3,
        reserved: 0,
        spent: 0,
        uncertain: false,
        interrupted: false,
        returnDestination: null,
      },
    });
    const request = run.resumeFor({
      sessionId: "new",
      connected: true,
      compatible: true,
      map: "prontera",
      player: { name: "Tester" },
    })!;
    expect(request.supplyGuard).toMatchObject({
      remainingTrips: 2,
      intervalSeconds: 200,
      deadlineSeconds: 400,
      reserved: 120,
      uncertain: true,
      interrupted: true,
    });
    run.stop();
    expect(
      run.resumeFor({
        sessionId: "third",
        connected: true,
        compatible: true,
        map: "prontera",
        player: { name: "Tester" },
      }),
    ).toBeNull();
    expect(run.supplyGuardForStart(settings, "Tester", "third")).toMatchObject({
      remainingTrips: 2,
      uncertain: true,
    });
  });
  it("a reconciled explicit new run retains finite allowance and latch without resuming the canceled trip", () => {
    const run = new PersistentFieldRun(() => 100000);
    run.observe({
      sessionId: "old",
      connected: true,
      compatible: true,
      map: "prt_fild08",
      player: { name: "Tester" },
      supplyGuard: { ...guard, uncertain: false },
    });
    expect(run.supplyGuardForStart(settings, "Tester", "old")).toMatchObject({
      remainingTrips: 2,
      latched: true,
      interrupted: false,
      returnDestination: null,
    });
  });
  it("bounds all public supply telemetry and guards independently of existing features", () => {
    expect(
      validFeatureStatus({
        supply: { reason: "Waiting", remainingTrips: 2 },
        supplyGuard: guard,
      }),
    ).toBe(true);
    expect(validFeatureStatus({ supply: { reserved: NaN } })).toBe(false);
    expect(
      validFeatureStatus({ supplyGuard: { npcId: "x".repeat(8193) } }),
    ).toBe(false);
  });
});
