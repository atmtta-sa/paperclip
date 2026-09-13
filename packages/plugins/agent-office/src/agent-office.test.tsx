import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import manifest from "./manifest.js";
import { AgentOfficePage } from "./ui/index.js";

describe("Agent Office plugin shell", () => {
  it("registers a company-scoped Office page and sidebar entry with read-only capabilities", () => {
    expect(manifest.capabilities).toEqual([
      "agents.read",
      "issues.read",
      "ui.page.register",
      "ui.sidebar.register",
    ]);
    expect(manifest.ui?.slots).toEqual([
      expect.objectContaining({
        type: "page",
        routePath: "office",
        exportName: "AgentOfficePage",
      }),
      expect.objectContaining({
        type: "sidebar",
        exportName: "AgentOfficeSidebarLink",
      }),
    ]);
  });

  it("renders Paperclip authority and company scope without controls", () => {
    const html = renderToStaticMarkup(
      <AgentOfficePage
        context={{
          companyId: "company-123",
          companyPrefix: "OPS",
          projectId: null,
          entityId: null,
          entityType: null,
          userId: null,
        }}
      />,
    );

    expect(html).toContain("Agent Office");
    expect(html).toContain("Paperclip is the authoritative operational system");
    expect(html).toContain("company-123");
    expect(html).not.toContain("<button");
  });
});
