import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const manifest: PaperclipPluginManifestV1 = {
  id: "paperclip.agent-office",
  apiVersion: 1,
  version: "0.1.0",
  displayName: "Agent Office",
  description: "Read-only 3D visualization of Paperclip agents and operational state.",
  author: "Paperclip Command Center",
  categories: ["ui"],
  capabilities: [
    "agents.read",
    "issues.read",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  ui: {
    slots: [
      {
        type: "page",
        id: "agent-office-page",
        displayName: "Agent Office",
        exportName: "AgentOfficePage",
        routePath: "office",
      },
      {
        type: "sidebar",
        id: "agent-office-sidebar",
        displayName: "Agent Office",
        exportName: "AgentOfficeSidebarLink",
      },
    ],
  },
};

export default manifest;
