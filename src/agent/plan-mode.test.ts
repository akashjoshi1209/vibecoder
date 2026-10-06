import { describe, expect, test } from "bun:test";
import { PLAN_MODE_PROMPT, isPlanOutput, stripPlanEnvelope } from "./plan-mode";

describe("plan-mode prompt", () => {
  test("declares read-only rules and the required envelope", () => {
    expect(PLAN_MODE_PROMPT).toContain("PLAN MODE");
    expect(PLAN_MODE_PROMPT).toContain("MUST NOT change anything");
    expect(PLAN_MODE_PROMPT).toContain("UNDERSTAND:");
    expect(PLAN_MODE_PROMPT).toContain("PLAN:");
    expect(PLAN_MODE_PROMPT).toContain("FILES:");
    expect(PLAN_MODE_PROMPT).toContain("RISKS:");
  });
});

describe("isPlanOutput", () => {
  test("detects the plan envelope", () => {
    expect(isPlanOutput("PLAN:\n1. do it")).toBe(true);
    expect(isPlanOutput("UNDERSTAND: current state")).toBe(true);
  });

  test("returns false for ordinary chat", () => {
    expect(isPlanOutput("Sure, I can help with that.")).toBe(false);
  });
});

describe("stripPlanEnvelope", () => {
  test("drops prose before the envelope", () => {
    const out = stripPlanEnvelope("Sure! Here's the plan.\n\nUNDERSTAND: x\nPLAN:\n1. y\nFILES: a.ts\nRISKS: z");
    expect(out.startsWith("UNDERSTAND:")).toBe(true);
    expect(out).toContain("FILES: a.ts");
  });

  test("removes wrapping code fences", () => {
    const out = stripPlanEnvelope("```\nUNDERSTAND: x\nPLAN:\n1. y\n```");
    expect(out.startsWith("UNDERSTAND:")).toBe(true);
    expect(out.endsWith("y")).toBe(true);
    expect(out).not.toContain("```");
  });

  test("returns the original text when there is no envelope", () => {
    expect(stripPlanEnvelope("no envelope here")).toBe("no envelope here");
  });
});