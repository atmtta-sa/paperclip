import {
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";

export function AgentOfficePage({ context }: PluginPageProps) {
  return (
    <section aria-labelledby="agent-office-title" className="space-y-4">
      <div>
        <h1 id="agent-office-title" className="text-2xl font-semibold">
          Agent Office
        </h1>
        <p className="text-sm text-muted-foreground">
          Paperclip is the authoritative operational system. This Office is a read-only visualization.
        </p>
      </div>
      <div className="rounded-lg border bg-card p-4 text-sm">
        <strong>Company context</strong>
        <div>{context.companyId}</div>
      </div>
    </section>
  );
}

export function AgentOfficeSidebarLink({ context: _context }: PluginSidebarProps) {
  const hostNavigation = useHostNavigation();
  const href = hostNavigation.resolveHref("/office");
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  return (
    <a
      {...hostNavigation.linkProps("/office")}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span aria-hidden="true">◇</span>
      <span className="flex-1 truncate">Agent Office</span>
    </a>
  );
}
