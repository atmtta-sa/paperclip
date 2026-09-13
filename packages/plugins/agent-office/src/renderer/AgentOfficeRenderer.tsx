import { useEffect, useRef, useState } from "react";
import type { OfficeRoom } from "../projection.js";
import { loadOfficeModels, resolveInstalledPluginId } from "./modelLoader.js";
import type { OfficeModelMap } from "./sceneComposition.js";
import { createOfficeScene } from "./sceneRuntime.js";

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
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (!canvasRef.current) return;
    const canvas = canvasRef.current;
    let cancelled = false;
    let disposeScene: (() => void) | undefined;
    setStatus("loading");
    void getOfficeModels()
      .then((models) => {
        if (cancelled) return;
        disposeScene = createOfficeScene(canvas, rooms, models);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });
    return () => {
      cancelled = true;
      disposeScene?.();
    };
  }, [rooms]);

  return (
    <figure className="space-y-3" data-office-renderer="agent-office-upstream">
      <canvas
        ref={canvasRef}
        aria-label="Read-only 3D Agent Office"
        className="h-[32rem] w-full rounded-lg border bg-slate-950"
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
