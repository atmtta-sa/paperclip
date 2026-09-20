
export const FURNITURE_MODELS = [
  "desk",
  "chairDesk",
  "computerScreen",
  "pottedPlant",
  "bookcaseOpen",
  "books",
  "lampRoundFloor",
  "rugRectangle",
  "loungeSofa",
  "tableCoffee",
  "televisionModern",
  "cabinetTelevision",
  "kitchenCoffeeMachine",
  "kitchenFridgeSmall",
  "kitchenCabinet",
  "rugRound",
  "lampSquareFloor",
  "plantSmall3",
] as const;

export const CHARACTER_MODELS = [
  "character-male-a",
  "character-male-b",
  "character-male-c",
  "character-male-d",
  "character-male-e",
  "character-male-f",
  "character-female-a",
  "character-female-b",
  "character-female-c",
  "character-female-d",
  "character-female-e",
  "character-female-f",
] as const;

export const ERROR_MONSTER_MODEL = "error-robot" as const;

export type FurnitureModelName = (typeof FURNITURE_MODELS)[number];
export type CharacterModelName = (typeof CHARACTER_MODELS)[number];
export type ErrorMonsterModelName = typeof ERROR_MONSTER_MODEL;
export type KenneyModelName = FurnitureModelName | CharacterModelName;
export type OfficeModelName = KenneyModelName | ErrorMonsterModelName;

export function modelAssetUrl(pluginId: string, name: KenneyModelName): string {
  return `/_plugins/${encodeURIComponent(pluginId)}/ui/assets/kenney/${name}.glb`;
}

export function errorMonsterAssetUrl(pluginId: string): string {
  return `/_plugins/${encodeURIComponent(pluginId)}/ui/assets/kenney-blocky/robot.glb`;
}
