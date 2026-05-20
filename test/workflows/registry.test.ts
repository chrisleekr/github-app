/**
 * Unit tests for the workflow registry shape. Exercises the Zod schema's
 * four cross-entry invariants: uniqueness on name + label, valid step
 * references, and the composite-vs-requiresPrior XOR rule.
 *
 * The real `registry.ts` module parses its constant at import time; those
 * tests touch the schema directly so the boot-time parse is still the only
 * place that panics on mis-construction.
 */

import { describe, expect, it } from "bun:test";
import type { z } from "zod";

import {
  registry,
  RegistrySchema,
  type WorkflowHandler,
  WorkflowNameSchema,
} from "../../src/workflows/registry";

const stubHandler: WorkflowHandler = () => Promise.resolve({ status: "failed", reason: "stub" });

type RegistryEntryInput = z.input<typeof RegistrySchema>[number];

function makeEntry(overrides: Partial<RegistryEntryInput>): RegistryEntryInput {
  return {
    name: "triage" as const,
    label: "bot:triage",
    context: "issue" as const,
    requiresPrior: null,
    steps: [],
    handler: stubHandler,
    ...overrides,
  };
}

describe("registry parsed at module load", () => {
  it("exposes the seven canonical workflow names", () => {
    const names = registry.map((e) => e.name).sort();
    expect(names).toEqual(["implement", "plan", "remember", "resolve", "review", "ship", "triage"]);
  });

  it("registers remember with bot:remember label, both-context, no prior, no steps", () => {
    const remember = registry.find((e) => e.name === "remember");
    expect(remember).toBeDefined();
    expect(remember?.label).toBe("bot:remember");
    expect(remember?.context).toBe("both");
    expect(remember?.requiresPrior).toBeNull();
    expect(remember?.steps).toEqual([]);
  });

  it("has exactly one composite workflow with ship's five-step chain", () => {
    const composites = registry.filter((e) => e.steps.length > 0);
    expect(composites.length).toBe(1);
    expect(composites[0]?.name).toBe("ship");
    expect(composites[0]?.steps).toEqual(["triage", "plan", "implement", "review", "resolve"]);
  });

  it("preserves the requiresPrior chain for atomic workflows", () => {
    const byName = new Map(registry.map((e) => [e.name, e]));
    expect(byName.get("triage")?.requiresPrior).toBeNull();
    expect(byName.get("plan")?.requiresPrior).toBe("triage");
    expect(byName.get("implement")?.requiresPrior).toBe("plan");
    expect(byName.get("review")?.requiresPrior).toBeNull();
    expect(byName.get("resolve")?.requiresPrior).toBeNull();
    expect(byName.get("ship")?.requiresPrior).toBeNull();
  });
});

describe("RegistrySchema invariants", () => {
  it("rejects duplicate workflow names", () => {
    const bad = [
      makeEntry({ name: "triage", label: "bot:triage" }),
      makeEntry({ name: "triage", label: "bot:triagetwo" }),
    ];
    expect(() => RegistrySchema.parse(bad)).toThrow(/workflow names must be unique/);
  });

  it("rejects duplicate labels", () => {
    const bad = [
      makeEntry({ name: "triage", label: "bot:x" }),
      makeEntry({ name: "plan", label: "bot:x" }),
    ];
    expect(() => RegistrySchema.parse(bad)).toThrow(/labels must be unique/);
  });

  it("rejects a label that does not match ^bot:[a-z]+$", () => {
    const bad = [makeEntry({ label: "ship:ready" })];
    expect(() => RegistrySchema.parse(bad)).toThrow();
  });

  it("rejects a step that names a workflow missing from the registry", () => {
    // `plan` is a valid WorkflowName per the enum, but absent from this
    // minimal registry, the cross-entry refine() is what must catch the gap
    // (enum membership alone is not enough).
    const bad = [
      makeEntry({ name: "triage", label: "bot:triage" }),
      makeEntry({
        name: "ship",
        label: "bot:ship",
        steps: ["triage", "plan"],
      }),
    ];
    expect(() => RegistrySchema.parse(bad)).toThrow(
      /every step must reference an existing workflow name/,
    );
  });

  it("rejects a composite workflow whose requiresPrior is non-null", () => {
    const bad = [
      makeEntry({ name: "triage", label: "bot:triage" }),
      makeEntry({
        name: "ship",
        label: "bot:ship",
        requiresPrior: "triage",
        steps: ["triage"],
      }),
    ];
    expect(() => RegistrySchema.parse(bad)).toThrow(/composite workflows.*must have requiresPrior/);
  });

  it("rejects a non-function handler", () => {
    const bad = [
      // Handler field is typed as WorkflowHandler but validated via z.custom's
      // function-type guard, pass a non-function to exercise the runtime path.
      makeEntry({
        // @ts-expect-error, string is not a function
        handler: "not-a-function",
      }),
    ];
    expect(() => RegistrySchema.parse(bad)).toThrow(/handler must be a function reference/);
  });
});

describe("WorkflowNameSchema", () => {
  it("accepts the seven canonical names", () => {
    for (const name of [
      "triage",
      "plan",
      "implement",
      "review",
      "resolve",
      "ship",
      "remember",
    ] as const) {
      expect(WorkflowNameSchema.parse(name)).toBe(name);
    }
  });

  it("rejects an unknown name", () => {
    expect(() => WorkflowNameSchema.parse("deploy")).toThrow();
  });
});
