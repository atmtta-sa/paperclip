import { useEffect, useMemo, useState } from "react";
import {
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { loadOfficeProjection, readHostJson } from "../dataSource.js";
import { projectOfficeRooms, type OfficeProjectionInput } from "../projection.js";
import { AgentOfficeRenderer } from "../renderer/AgentOfficeRenderer.js";

const EMPTY_PROJECTION: OfficeProjectionInput = { agents: [], issues: [], runs: [] };
const REFRESH_INTERVAL_MS = 10_000;

export function AgentOfficePage({ context }: PluginPageProps) {
  const [projection, setProjection] = useState<OfficeProjectionInput>(EMPTY_PROJECTION);
  const [error, setError] = useState<string | null>(null);
  const rooms = useMemo(() => projectOfficeRooms(projection), [projection]);

  useEffect(() => {
    if (!context.companyId) return;
    let cancelled = false;

    const load = async () => {
      try {
        const nextProjection = await loadOfficeProjection(context.companyId!, readHostJson);
        if (!cancelled) {
          setProjection(nextProjection);
          setError(null);
        }
      } catch (nextError) {
        if (!cancelled) {
          setError(nextError instanceof Error ? nextError.message : "Paperclip read failed");
        }
      }
    };

    void load();
    const timer = window.setInterval(() => void load(), REFRESH_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [context.companyId]);

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
      {error ? (
        <p role="alert" className="rounded-lg border border-destructive/40 p-3 text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <AgentOfficeRenderer rooms={rooms} />
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
