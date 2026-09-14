import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { OfficeRoom } from "../projection.js";
import type { OfficeModelMap } from "./sceneComposition.js";
import { buildOfficeEnvironment } from "./sceneComposition.js";
import { resolveAnimationClip, type StatusLightProfile } from "./visualState.js";

function createRoomLabel(label: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = "rgba(15, 23, 42, 0.82)";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f8fafc";
    context.font = "bold 42px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 32);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({ map: texture, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(5.2, 0.92, 1);
  sprite.position.set(0, 2.35, 0);
  sprite.userData.generated = true;
  return sprite;
}

function addRoomLabels(environment: THREE.Group, rooms: OfficeRoom[]): void {
  rooms.forEach((room) => {
    environment.getObjectByName(`office-room:${room.id}`)?.add(createRoomLabel(room.label));
  });
}

function addLighting(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xfff4e2, 0x6b5a44, 1.4));
  const sun = new THREE.DirectionalLight(0xfff0d8, 2);
  sun.position.set(18, 30, 12);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcd0ff, 0.45);
  fill.position.set(-16, 14, -10);
  scene.add(fill);
}

function createMixers(environment: THREE.Group): THREE.AnimationMixer[] {
  const mixers: THREE.AnimationMixer[] = [];
  environment.traverse((object) => {
    if (object.name !== "office-agent") return;
    const clips = object.userData.animations as THREE.AnimationClip[] | undefined;
    const state = object.userData.officeState as OfficeRoom["state"] | undefined;
    const clip = state && clips ? resolveAnimationClip(state, clips) : clips?.[0];
    if (!clip) return;
    const mixer = new THREE.AnimationMixer(object);
    mixer.clipAction(clip).play();
    mixers.push(mixer);
  });
  return mixers;
}

function updateStatusLights(environment: THREE.Group, elapsed: number): void {
  environment.getObjectsByProperty("name", "office-status-light").forEach((object) => {
    if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshBasicMaterial)) return;
    const profile = object.userData.pulseProfile as StatusLightProfile | undefined;
    if (!profile) return;
    const phase = Number(object.userData.pulsePhase) || 0;
    const progress = profile.speed === 0 ? 0 : (Math.sin(elapsed * profile.speed * Math.PI * 2 + phase) + 1) / 2;
    const intensity = profile.minIntensity + (profile.maxIntensity - profile.minIntensity) * progress;
    object.scale.setScalar(intensity);
    object.material.opacity = Math.min(intensity, 1);
  });
}

function disposeGenerated(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!object.userData.generated) return;
    if (object instanceof THREE.Mesh) object.geometry.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
        material.dispose();
      });
    }
  });
}

export interface OfficeEnvironmentController {
  updateRooms: (rooms: OfficeRoom[]) => void;
  updateAnimations: (delta: number) => void;
  dispose: () => void;
}

export interface OfficeSceneController {
  updateRooms: (rooms: OfficeRoom[]) => void;
  dispose: () => void;
}

export function createOfficeEnvironmentController(
  scene: THREE.Scene,
  initialRooms: OfficeRoom[],
  models: OfficeModelMap,
  decorateEnvironment: (environment: THREE.Group, rooms: OfficeRoom[]) => void = addRoomLabels,
): OfficeEnvironmentController {
  let environment: THREE.Group;
  let mixers: THREE.AnimationMixer[] = [];
  let elapsed = 0;

  const replaceEnvironment = (rooms: OfficeRoom[]) => {
    if (environment) {
      mixers.forEach((mixer) => mixer.stopAllAction());
      scene.remove(environment);
      disposeGenerated(environment);
    }
    environment = buildOfficeEnvironment(rooms, models);
    decorateEnvironment(environment, rooms);
    scene.add(environment);
    mixers = createMixers(environment);
  };

  replaceEnvironment(initialRooms);
  return {
    updateRooms: replaceEnvironment,
    updateAnimations: (delta) => {
      elapsed += delta;
      mixers.forEach((mixer) => mixer.update(delta));
      updateStatusLights(environment, elapsed);
    },
    dispose: () => {
      mixers.forEach((mixer) => mixer.stopAllAction());
      scene.remove(environment);
      disposeGenerated(environment);
    },
  };
}

export function createOfficeScene(
  canvas: HTMLCanvasElement,
  rooms: OfficeRoom[],
  models: OfficeModelMap,
): OfficeSceneController {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xdbeafe);
  addLighting(scene);

  const environmentController = createOfficeEnvironmentController(scene, rooms, models);

  const camera = new THREE.OrthographicCamera(-18, 18, 18, -18, 0.1, 200);
  camera.position.set(60, 49.2, 60);
  camera.lookAt(0, 0, 0);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.minZoom = 0.55;
  controls.maxZoom = 2.6;
  controls.target.set(0, 0.4, 0);

  let previousFrameTime = performance.now();
  let frameId = 0;
  const render = () => {
    const width = Math.max(canvas.clientWidth, 1);
    const height = Math.max(canvas.clientHeight, 1);
    const aspect = width / height;
    camera.left = -18 * aspect;
    camera.right = 18 * aspect;
    camera.top = 18;
    camera.bottom = -18;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
    const frameTime = performance.now();
    const delta = Math.min((frameTime - previousFrameTime) / 1000, 0.05);
    previousFrameTime = frameTime;
    environmentController.updateAnimations(delta);
    controls.update();
    renderer.render(scene, camera);
    frameId = window.requestAnimationFrame(render);
  };
  render();

  return {
    updateRooms: environmentController.updateRooms,
    dispose: () => {
      window.cancelAnimationFrame(frameId);
      controls.dispose();
      environmentController.dispose();
      renderer.dispose();
    },
  };
}
