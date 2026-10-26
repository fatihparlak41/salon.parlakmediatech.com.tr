// @vitest-environment jsdom
/**
 * RC.1A - layout guards for defects found on the 390 px phone check. jsdom has no layout engine, so these pin the class that fixed
 * each defect (the live measurement is in the RC report): a fieldset keeps its intrinsic minimum width unless told otherwise, which
 * pushed the service form's fields past the edge of the sheet.
 */
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { ServiceExperienceFields } from "@/components/services/service-experience-fields";
import { emptyExperienceForm } from "@/lib/modules/services/experience";

afterEach(() => cleanup());

describe("service form fields inside a narrow sheet", () => {
  it("the fieldset can shrink below its content width (min-w-0), so no field is wider than the sheet", () => {
    const { container } = render(<ServiceExperienceFields value={emptyExperienceForm()} onChange={() => {}} idPrefix="t" />);
    const fieldset = container.querySelector("fieldset")!;
    expect(fieldset.className).toContain("min-w-0");
  });

  it("one model: the same fieldset carries pricing, display duration, re-booking window and every public text", () => {
    const { container } = render(<ServiceExperienceFields value={emptyExperienceForm()} onChange={() => {}} idPrefix="t" />);
    for (const id of ["pricing", "booking", "dmin", "dmax", "rmin", "rmax", "summary", "badge", "details", "prep", "important", "after"]) {
      expect(container.querySelector(`#t-${id}`), id).not.toBeNull();
    }
  });
});
