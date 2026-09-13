import type { FurnitureModelName } from "./assets.js";

// Adapted from Agent Office Dashboard frontend/office3d.js at
// ca3e5fc64ceb8092983bf8eb509afff57b3f085e (MIT).
export const OFFICE_ROOM_SIZE = 8.8;
export const ROOM_WALLS = ["north", "west"] as const;

export interface RoomStation {
  x: number;
  z: number;
  screens: number;
}

export interface FurniturePlacement {
  model: FurnitureModelName;
  x: number;
  z: number;
  rotationY?: number;
  scale?: number;
}

export const ROOM_STATIONS: readonly RoomStation[] = [
  { x: 0, z: -2.5, screens: 3 },
  { x: -2.1, z: -0.5, screens: 1 },
  { x: 2.1, z: -0.5, screens: 1 },
  { x: -2.1, z: 1.6, screens: 1 },
  { x: 2.1, z: 1.6, screens: 1 },
];

export const ROOM_FURNITURE: readonly FurniturePlacement[] = [
  { model: "rugRectangle", x: 0, z: -0.4, scale: 2.8 },
  { model: "pottedPlant", x: 3.75, z: 3.7, scale: 1.1 },
  { model: "lampRoundFloor", x: -3.8, z: 3.7 },
  { model: "bookcaseOpen", x: 3.7, z: -3.85 },
  { model: "books", x: 3.7, z: -3.85 },
];

export const ATRIUM_FURNITURE: readonly FurniturePlacement[] = [
  { model: "rugRound", x: 0.1, z: 0.4, scale: 2.4 },
  { model: "cabinetTelevision", x: 0, z: -2.15, scale: 1.3 },
  { model: "televisionModern", x: 0, z: -2.15, scale: 1.62 },
  { model: "loungeSofa", x: 0, z: 1.55, rotationY: Math.PI, scale: 1.35 },
  { model: "tableCoffee", x: 0.1, z: 0.2, scale: 1.15 },
  { model: "kitchenCabinet", x: -2.58, z: 0.35, rotationY: Math.PI / 2, scale: 1.2 },
  { model: "kitchenCoffeeMachine", x: -2.54, z: 0.51, rotationY: Math.PI },
  { model: "kitchenFridgeSmall", x: -2.63, z: -1.85, rotationY: Math.PI / 2, scale: 1.1 },
  { model: "lampSquareFloor", x: 2.65, z: -1.95, scale: 1.1 },
  { model: "plantSmall3", x: 2.65, z: 2, scale: 1.25 },
  { model: "pottedPlant", x: -2.6, z: 1.95 },
];
