import { expect, test } from "vitest";

import type { CreateConfigValues } from "@paperclipai/adapter-utils";

import { buildHermesConfig } from "./build-config.js";

function values(
  overrides: Partial<CreateConfigValues> = {},
): CreateConfigValues {
  return {
    adapterType: "hermes_local",
    cwd: "",
    promptTemplate: "",
    model: "",
    thinkingEffort: "",
    chrome: false,
    dangerouslySkipPermissions: false,
    search: false,
    fastMode: false,
    dangerouslyBypassSandbox: false,
    command: "",
    args: "",
    extraArgs: "",
    envVars: "",
    envBindings: {},
    url: "",
    bootstrapPrompt: "",
    maxTurnsPerRun: 0,
    ...overrides,
  } as CreateConfigValues;
}

test("persists an explicit structured context renderer selection", () => {
  const config = buildHermesConfig(values({
    paperclipContextRenderer: "structured_v1",
  }));

  expect(config.paperclipContextRenderer).toBe("structured_v1");
});

test("does not invent a renderer selection when the form omits it", () => {
  const config = buildHermesConfig(values());

  expect(config).not.toHaveProperty("paperclipContextRenderer");
});
