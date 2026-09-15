import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  CHARACTER_MODELS,
  ERROR_MONSTER_MODEL,
  errorMonsterAssetUrl,
  FURNITURE_MODELS,
  modelAssetUrl,
  type OfficeModelName,
} from "./assets.js";
import type { LoadedOfficeModel, OfficeModelMap } from "./sceneComposition.js";

interface LoadedGltf {
  scene: THREE.Group;
  animations: THREE.AnimationClip[];
}

export type OfficeModelReader = (url: string) => Promise<LoadedGltf>;
export type OfficeJsonReader = (path: string) => Promise<unknown>;

interface PluginContribution {
  pluginId: string;
  pluginKey: string;
}

function normalizeModel(loaded: LoadedGltf): LoadedOfficeModel {
  const bounds = new THREE.Box3().setFromObject(loaded.scene);
  const center = bounds.getCenter(new THREE.Vector3());
  const size = bounds.getSize(new THREE.Vector3());
  loaded.scene.position.set(-center.x, -bounds.min.y, -center.z);
  const wrapper = new THREE.Group();
  wrapper.add(loaded.scene);
  return { object: wrapper, animations: loaded.animations, size };
}

async function defaultModelReader(url: string): Promise<LoadedGltf> {
  const loader = new GLTFLoader();
  return loader.loadAsync(url);
}

async function defaultJsonReader(path: string): Promise<unknown> {
  const response = await fetch(path, { credentials: "include" });
  if (!response.ok) throw new Error(`Paperclip plugin discovery failed (${response.status})`);
  return response.json();
}

export async function resolveInstalledPluginId(
  readJson: OfficeJsonReader = defaultJsonReader,
): Promise<string> {
  const contributions = await readJson("/api/plugins/ui-contributions") as PluginContribution[];
  const contribution = contributions.find((item) => item.pluginKey === "paperclip.agent-office");
  if (!contribution) throw new Error("Installed Agent Office plugin was not found");
  return contribution.pluginId;
}

export async function loadOfficeModels(
  pluginId: string,
  readModel: OfficeModelReader = defaultModelReader,
): Promise<OfficeModelMap> {
  const names = [...FURNITURE_MODELS, ...CHARACTER_MODELS];
  const loaded = await Promise.all(
    names.map(async (name) => [name, normalizeModel(await readModel(modelAssetUrl(pluginId, name)))] as const),
  );
  const errorMonster = normalizeModel(await readModel(errorMonsterAssetUrl(pluginId)));
  return new Map<OfficeModelName, LoadedOfficeModel>([
    ...loaded,
    [ERROR_MONSTER_MODEL, errorMonster],
  ]);
}
