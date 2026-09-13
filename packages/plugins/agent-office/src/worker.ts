import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Agent Office read-only plugin ready");
  },

  async onHealth() {
    return { status: "ok", message: "Agent Office plugin ready" };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
