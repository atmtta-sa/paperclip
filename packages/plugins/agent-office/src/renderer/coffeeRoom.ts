import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { LoadedOfficeModel, OfficeModelMap } from "./sceneComposition.js";
import type {
  TinyTreatsCollection,
  TinyTreatsModel,
} from "./tinyTreatsLibrary.js";

export const COFFEE_ROOM_POSITION = { x: 9.8, z: -9.8 } as const;

interface CoffeeRoomModelSpec {
  collection: TinyTreatsCollection;
  model: TinyTreatsModel;
  position: readonly [number, number, number];
  rotation?: number;
  scale?: number;
}

export const COFFEE_ROOM_MODEL_SPECS: readonly CoffeeRoomModelSpec[] = [
  { collection: "charming-kitchen", model: "fridge", position: [-3.55, 0, -3.72], scale: 0.92 },
  { collection: "charming-kitchen", model: "countertop_straight_A", position: [-2.15, 0, -3.72], scale: 0.92 },
  { collection: "charming-kitchen", model: "countertop_sink", position: [-0.75, 0, -3.72], scale: 0.92 },
  { collection: "charming-kitchen", model: "stove", position: [0.72, 0, -3.72], scale: 0.92 },
  { collection: "charming-kitchen", model: "wall_cabinet_straight", position: [-1.7, 2.05, -3.94], scale: 0.9 },
  { collection: "charming-kitchen", model: "extractor_hood", position: [0.72, 2.05, -3.94], scale: 0.9 },
  { collection: "charming-kitchen", model: "table_B", position: [0.7, 0, 0.8], rotation: Math.PI / 2, scale: 0.86 },
  { collection: "charming-kitchen", model: "chair", position: [-0.5, 0, 0.8], rotation: -Math.PI / 2, scale: 0.86 },
  { collection: "charming-kitchen", model: "chair", position: [1.9, 0, 0.8], rotation: Math.PI / 2, scale: 0.86 },
  { collection: "charming-kitchen", model: "toaster", position: [-2.15, 0.94, -3.62], scale: 0.82 },
  { collection: "charming-kitchen", model: "kettle", position: [-0.75, 0.94, -3.62], scale: 0.82 },
  { collection: "baked-goods", model: "cake_chocolate", position: [3.35, 1.02, -1.45], scale: 0.62 },
  { collection: "baked-goods", model: "croissant", position: [3.35, 1.02, -0.7], scale: 0.68 },
  { collection: "baked-goods", model: "cupcake", position: [3.35, 1.02, 0.05], scale: 0.68 },
  { collection: "baked-goods", model: "donut_pink", position: [3.35, 1.02, 0.8], scale: 0.68 },
  { collection: "baked-goods", model: "muffin", position: [3.35, 1.02, 1.55], scale: 0.68 },
  { collection: "baked-goods", model: "waffle_stacked", position: [3.35, 1.02, 2.3], scale: 0.62 },
];

function generatedBox(
  name: string,
  size: readonly [number, number, number],
  color: number,
): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(...size),
    new THREE.MeshStandardMaterial({ color, roughness: 0.88 }),
  );
  mesh.name = name;
  mesh.receiveShadow = true;
  mesh.userData.generated = true;
  return mesh;
}

function placeModel(
  room: THREE.Group,
  source: LoadedOfficeModel,
  spec: CoffeeRoomModelSpec,
): void {
  const object = cloneSkeleton(source.object);
  object.name = "agent-office-coffee-room-prop";
  object.position.set(...spec.position);
  object.rotation.y = spec.rotation ?? 0;
  object.scale.setScalar(spec.scale ?? 1);
  object.userData = { ...object.userData, collection: spec.collection, model: spec.model };
  object.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      child.castShadow = true;
      child.receiveShadow = true;
    }
  });
  room.add(object);
}

export function createCoffeeRoom(models: OfficeModelMap): THREE.Group {
  const room = new THREE.Group();
  room.name = "agent-office-coffee-room";
  room.position.set(COFFEE_ROOM_POSITION.x, 0, COFFEE_ROOM_POSITION.z);

  const floor = generatedBox("agent-office-coffee-room-floor", [8.8, 0.18, 8.8], 0xf2c7aa);
  floor.position.y = -0.1;
  room.add(floor);

  const fridgeWall = generatedBox("agent-office-coffee-room-wall", [8.8, 3.8, 0.18], 0xffeadf);
  fridgeWall.position.set(0, 1.8, -4.3);
  room.add(fridgeWall);

  const display = generatedBox("agent-office-coffee-room-display", [1.15, 0.95, 5.2], 0xffe0c7);
  display.position.set(3.35, 0.46, 0.42);
  display.castShadow = true;
  room.add(display);

  const warmLight = new THREE.PointLight(0xffc36a, 0.72, 6);
  warmLight.name = "agent-office-coffee-room-light";
  warmLight.position.set(0.4, 3.1, 0.2);
  room.add(warmLight);

  COFFEE_ROOM_MODEL_SPECS.forEach((spec) => {
    const source = models.get(spec.model);
    if (source) placeModel(room, source, spec);
  });

  return room;
}
