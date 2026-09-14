import * as THREE from "three";
import type { OfficeState } from "../projection.js";

export type OfficeActivity = "stationary" | "walking" | "coffee-break";

export interface ActivityBubblePresentation {
  symbol: string;
  label: string;
}

export const ACTIVITY_BUBBLE_COLORS = {
  plate: "rgba(29, 78, 216, 0.94)",
  border: "rgba(219, 234, 254, 0.98)",
  text: "#ffffff",
} as const;

const STATE_PRESENTATIONS: Readonly<Record<OfficeState, ActivityBubblePresentation>> = {
  idle: { symbol: "Zz", label: "Idle" },
  thinking: { symbol: "…", label: "Thinking" },
  executing: { symbol: "</>", label: "Coding" },
  waiting: { symbol: "⌛", label: "Waiting" },
  error: { symbol: "!", label: "Error" },
};

export function activityBubblePresentation(
  state: OfficeState,
  activity: OfficeActivity,
): ActivityBubblePresentation {
  if (state === "idle" && activity === "coffee-break") {
    return { symbol: "☕", label: "Coffee break" };
  }
  return STATE_PRESENTATIONS[state];
}

function createBubbleTexture(symbol: string): THREE.CanvasTexture | null {
  if (typeof document === "undefined") return null;
  const canvas = document.createElement("canvas");
  canvas.width = 160;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.fillStyle = ACTIVITY_BUBBLE_COLORS.plate;
  context.strokeStyle = ACTIVITY_BUBBLE_COLORS.border;
  context.lineWidth = 6;
  context.beginPath();
  context.roundRect(12, 10, 136, 82, 28);
  context.fill();
  context.stroke();
  context.beginPath();
  context.moveTo(72, 91);
  context.lineTo(58, 108);
  context.lineTo(88, 94);
  context.fill();
  context.fillStyle = ACTIVITY_BUBBLE_COLORS.text;
  context.font = "bold 38px system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(symbol, 80, 51, 116);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function updateActivityBubble(
  anchor: THREE.Object3D,
  state: OfficeState,
  activity: OfficeActivity,
): void {
  const presentation = activityBubblePresentation(state, activity);
  anchor.userData = { ...anchor.userData, state, activity, label: presentation.label, symbol: presentation.symbol };
  const texture = createBubbleTexture(presentation.symbol);
  if (!texture) return;
  const previous = anchor.getObjectByName("office-activity-bubble");
  if (previous instanceof THREE.Sprite) {
    previous.material.map?.dispose();
    previous.material.dispose();
    anchor.remove(previous);
  }
  const bubble = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthWrite: false }));
  bubble.name = "office-activity-bubble";
  bubble.scale.set(1.35, 0.95, 1);
  bubble.userData = { generated: true, label: presentation.label, symbol: presentation.symbol };
  anchor.add(bubble);
}
