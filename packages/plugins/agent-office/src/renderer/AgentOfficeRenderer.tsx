import { useEffect, useRef, useState } from "react";
import type { OfficeRoom } from "../projection.js";
import { loadOfficeModels, resolveInstalledPluginId } from "./modelLoader.js";
import type { OfficeModelMap } from "./sceneComposition.js";
import { createOfficeScene, type OfficeSceneController } from "./sceneRuntime.js";

interface AgentOfficeRendererProps {
  rooms: OfficeRoom[];
}

let officeModelsPromise: Promise<OfficeModelMap> | null = null;

function getOfficeModels(): Promise<OfficeModelMap> {
  officeModelsPromise ??= resolveInstalledPluginId().then((pluginId) => loadOfficeModels(pluginId));
  return officeModelsPromise;
}

export function AgentOfficeRenderer({ rooms }: AgentOfficeRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const roomsRef = useRef(rooms);
  const sceneRef = useRef<OfficeSceneController | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    roomsRef.current = rooms;
    sceneRef.current?.updateRooms(rooms);
  }, [rooms]);

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    let cancelled = false;
    setStatus("loading");
    void getOfficeModels()
      .then((models) => {
        if (cancelled) return;
        sceneRef.current = createOfficeScene(canvas, roomsRef.current, models);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      sceneRef.current?.dispose();
      sceneRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!expanded) return;
    const previousOverflow = document.body.style.overflow;
    const exitOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", exitOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", exitOnEscape);
    };
  }, [expanded]);

  return (
    <figure
      className={
        expanded
          ? "fixed inset-0 z-[100] flex h-screen w-screen flex-col gap-3 overflow-y-auto bg-background p-4"
          : "space-y-3"
      }
      style={expanded ? { zIndex: 2147483647 } : undefined}
      data-office-expanded={String(expanded)}
      data-office-renderer="agent-office-upstream"
    >
      <div className="flex justify-end">
        <button
          type="button"
          aria-label={expanded ? "Exit expanded Agent Office" : "Expand Agent Office"}
          className="rounded border bg-background px-3 py-1.5 text-sm font-medium shadow-sm hover:bg-accent"
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Exit expanded view" : "Expand Office"}
        </button>
      </div>
      <canvas
        ref={canvasRef}
        aria-label="Read-only 3D Agent Office"
        className={
          expanded
            ? "min-h-0 flex-1 w-full rounded-lg border bg-slate-950"
            : "h-[32rem] w-full rounded-lg border bg-slate-950"
        }
      />
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {status === "loading" ? "Loading upstream office assets…" : null}
        {status === "ready" ? "Live Paperclip projection" : null}
        {status === "error" ? "Office assets could not be loaded." : null}
      </p>
      <figcaption className="grid gap-2 text-xs text-muted-foreground sm:grid-cols-2 xl:grid-cols-5">
        {rooms.map((room) => (
          <div key={room.id} className="rounded border px-2 py-1">
            <strong className="block text-foreground">{room.label}</strong>
            <span className="block">{room.state}</span>
            {room.taskTitle ? <span className="block">{room.taskTitle}</span> : null}
          </div>
        ))}
      </figcaption>
    </figure>
  );
}
