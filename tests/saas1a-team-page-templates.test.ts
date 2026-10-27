import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Faz SAAS.1A — found in the browser check: the Team page formatted the confirm-dialog descriptions (which carry a
 * `{name}` placeholder the dialog fills in per member) with t(), and next-intl threw FORMATTING_ERROR on the server.
 * The page must hand the dialog the RAW template.
 */
describe("TP team page dialog templates", () => {
  const source = readFileSync(join(process.cwd(), "app/[locale]/app/[tenantSlug]/team/page.tsx"), "utf8");

  it("TP1 every member-dialog description is passed as a raw template", () => {
    for (const kind of ["suspend", "reactivate", "remove"]) {
      expect(source).toContain(`t.raw("memberDialog.${kind}.description")`);
      expect(source).not.toContain(`t("memberDialog.${kind}.description")`);
    }
  });
});
