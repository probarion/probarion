import { describe, expect, it } from "vitest";
import { asForm, createWarnings, parseApprovers } from "./create-rules";

describe("asForm: what a server action accepts from the browser", () => {
  it("keeps the five string fields and nothing else", () => {
    expect(
      asForm({
        name: "acme",
        approvers: "cfo.near",
        dailyBackstopUsdc: "500",
        heldTtlHours: "72",
        depositNear: "1",
        owner: "evil.near",
        factory: "vaults.evil.near",
      }),
    ).toEqual({
      name: "acme",
      approvers: "cfo.near",
      dailyBackstopUsdc: "500",
      heldTtlHours: "72",
      depositNear: "1",
    });
  });

  it("turns a non-string field, or a non-object, into empty fields", () => {
    expect(asForm({ name: 7, approvers: ["a.near"], depositNear: { v: 1 } })).toEqual({
      name: "",
      approvers: "",
      dailyBackstopUsdc: "",
      heldTtlHours: "",
      depositNear: "",
    });
    for (const raw of [null, undefined, "acme", 42]) {
      expect(asForm(raw)).toEqual({
        name: "",
        approvers: "",
        dailyBackstopUsdc: "",
        heldTtlHours: "",
        depositNear: "",
      });
    }
  });

  it("cuts an oversized field to 1,000 characters", () => {
    expect(asForm({ name: "a".repeat(5000) }).name).toHaveLength(1000);
  });
});

describe("createWarnings", () => {
  it("warns when the owner is the only approver, and not otherwise", () => {
    expect(createWarnings(["acme.near"], "acme.near")).toHaveLength(1);
    expect(createWarnings(["acme.near", "cfo.near"], "acme.near")).toEqual([]);
    expect(createWarnings(["cfo.near"], "acme.near")).toEqual([]);
    expect(createWarnings([], "acme.near")).toEqual([]);
  });

  it("is computed on the same parsed list the transaction carries", () => {
    expect(createWarnings(parseApprovers(" acme.near, acme.near "), "acme.near")).toHaveLength(1);
  });
});
