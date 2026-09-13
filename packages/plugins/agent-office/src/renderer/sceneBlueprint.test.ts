import { describe, expect, it } from "vitest";
import {
  ATRIUM_FURNITURE,
  OFFICE_ROOM_SIZE,
  ROOM_FURNITURE,
  ROOM_STATIONS,
  ROOM_WALLS,
} from "./sceneBlueprint.js";

describe("adapted upstream Agent Office scene blueprint", () => {
  it("preserves the upstream five-seat room and open two-wall dollhouse", () => {
    expect(OFFICE_ROOM_SIZE).toBe(8.8);
    expect(ROOM_STATIONS).toEqual([
      { x: 0, z: -2.5, screens: 3 },
      { x: -2.1, z: -0.5, screens: 1 },
      { x: 2.1, z: -0.5, screens: 1 },
      { x: -2.1, z: 1.6, screens: 1 },
      { x: 2.1, z: 1.6, screens: 1 },
    ]);
    expect(ROOM_WALLS).toEqual(["north", "west"]);
    expect(ROOM_FURNITURE.map((item) => item.model)).toEqual([
      "rugRectangle",
      "pottedPlant",
      "lampRoundFloor",
      "bookcaseOpen",
      "books",
    ]);
  });

  it("preserves a central furnished atrium instead of a control plane", () => {
    expect(ATRIUM_FURNITURE.map((item) => item.model)).toEqual([
      "rugRound",
      "cabinetTelevision",
      "televisionModern",
      "loungeSofa",
      "tableCoffee",
      "kitchenCabinet",
      "kitchenCoffeeMachine",
      "kitchenFridgeSmall",
      "lampSquareFloor",
      "plantSmall3",
      "pottedPlant",
    ]);
  });
});
