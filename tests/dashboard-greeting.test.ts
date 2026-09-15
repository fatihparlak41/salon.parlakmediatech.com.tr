import { describe, it, expect } from "vitest";
import { greetingBandForHour, firstNameOnly } from "@/lib/modules/dashboard/greeting";

describe("Faz DASHBOARD.1 — greetingBandForHour", () => {
  it("returns morning before noon", () => {
    expect(greetingBandForHour(0)).toBe("morning");
    expect(greetingBandForHour(6)).toBe("morning");
    expect(greetingBandForHour(11)).toBe("morning");
  });

  it("returns day from noon up to (not including) 18:00", () => {
    expect(greetingBandForHour(12)).toBe("day");
    expect(greetingBandForHour(15)).toBe("day");
    expect(greetingBandForHour(17)).toBe("day");
  });

  it("returns evening from 18:00 onward", () => {
    expect(greetingBandForHour(18)).toBe("evening");
    expect(greetingBandForHour(23)).toBe("evening");
  });
});

describe("Faz DASHBOARD.1 — firstNameOnly", () => {
  it("returns the first token of a multi-word name", () => {
    expect(firstNameOnly("Gökhan İlhan")).toBe("Gökhan");
  });

  it("returns the name unchanged when it is already a single token", () => {
    expect(firstNameOnly("Feyzanur")).toBe("Feyzanur");
  });

  it("tolerates stray leading/trailing/inner whitespace", () => {
    expect(firstNameOnly("  Ayşe   Yılmaz  ")).toBe("Ayşe");
  });

  it("returns null for null, undefined, or blank input — never a placeholder string", () => {
    expect(firstNameOnly(null)).toBeNull();
    expect(firstNameOnly(undefined)).toBeNull();
    expect(firstNameOnly("")).toBeNull();
    expect(firstNameOnly("   ")).toBeNull();
  });
});
