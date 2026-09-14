import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import type { OfficeRoom } from "../projection.js";
import { updateActivityBubble, type OfficeActivity } from "./activityBubble.js";
import { createAmbientActorMotion } from "./ambientMotion.js";
import { createCoffeeBreakMotion, projectCoffeeSpot } from "./coffeeBreak.js";
import type { OfficeModelMap } from "./sceneComposition.js";
import { buildOfficeEnvironment } from "./sceneComposition.js";
import { resolveAnimationClip, type StatusLightProfile } from "./visualState.js";

export const ROOM_LABEL_BACKGROUND = "rgba(15, 23, 42, 0.55)";
export const ROOM_LABEL_PLACEMENT = {
  x: 1.35,
  y: 1.62,
  z: -4.28,
  rotationX: 0,
} as const;

function createRoomLabel(label: string): THREE.Mesh {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 112;
  const context = canvas.getContext("2d");
  if (context) {
    context.fillStyle = ROOM_LABEL_BACKGROUND;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#f8fafc";
    context.font = "bold 42px system-ui, sans-serif";
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(label, canvas.width / 2, canvas.height / 2, canvas.width - 32);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -1,
  });
  const decal = new THREE.Mesh(new THREE.PlaneGeometry(5.2, 0.92), material);
  decal.name = "office-room-label";
  decal.position.set(ROOM_LABEL_PLACEMENT.x, ROOM_LABEL_PLACEMENT.y, ROOM_LABEL_PLACEMENT.z);
  decal.rotation.x = ROOM_LABEL_PLACEMENT.rotationX;
  decal.userData.generated = true;
  return decal;
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

interface ActorRuntime {
  mixer: THREE.AnimationMixer;
  motion: { update: (delta: number) => void } | null;
}

function createActorRuntimes(environment: THREE.Group, random: () => number): ActorRuntime[] {
  const runtimes: ActorRuntime[] = [];
  environment.updateMatrixWorld(true);
  environment.getObjectsByProperty("name", "office-agent").forEach((object, index) => {
    const clips = object.userData.animations as THREE.AnimationClip[] | undefined;
    const state = object.userData.officeState as OfficeRoom["state"] | undefined;
    const clip = state && clips ? resolveAnimationClip(state, clips) : clips?.[0];
    if (!clip) return;
    const mixer = new THREE.AnimationMixer(object);
    const restingAction = mixer.clipAction(clip);
    const walkClip = clips?.find((candidate) => candidate.name.toLowerCase() === "walk");
    const walkingAction = walkClip ? mixer.clipAction(walkClip) : null;
    restingAction.play();
    object.userData.officeMotion = "stationary";
    const bubbleAnchor = object.getObjectByName("office-activity-bubble-anchor");
    const setActivity = (activity: OfficeActivity) => {
      if (bubbleAnchor && state) updateActivityBubble(bubbleAnchor, state, activity);
    };
    setActivity("stationary");
    const setWalking = (walking: boolean) => {
      object.userData.officeMotion = walking ? "walking" : "stationary";
      const current = walking ? walkingAction : restingAction;
      const previous = walking ? restingAction : walkingAction;
      previous?.stop();
      current?.reset().play();
    };
    const ambient = state && walkingAction
      ? createAmbientActorMotion(object, state, random, setWalking)
      : null;
    const spot = projectCoffeeSpot(index);
    const worldSpot = environment.localToWorld(new THREE.Vector3(spot.x, object.position.y, spot.z));
    const loungeSpot = object.parent?.worldToLocal(worldSpot) ?? worldSpot;
    const coffee = state && walkingAction
      ? createCoffeeBreakMotion(object, state, [
        new THREE.Vector3(3, object.position.y, -2.5),
        new THREE.Vector3(3, object.position.y, 4.8),
        loungeSpot,
      ], random, setWalking)
      : null;
    const motion = ambient || coffee ? {
      update: (delta: number) => {
        const wasOnBreak = coffee?.isActive() ?? false;
        coffee?.update(delta);
        const isOnBreak = coffee?.isActive() ?? false;
        if (!wasOnBreak && isOnBreak) {
          ambient?.reset();
          setWalking(true);
          setActivity("coffee-break");
        } else if (wasOnBreak && !isOnBreak) {
          ambient?.reset();
          setActivity("stationary");
        } else if (!isOnBreak) {
          ambient?.update(delta);
        }
      },
    } : null;
    runtimes.push({ mixer, motion });
  });
  return runtimes;
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

function hasSameVisualState(current: readonly OfficeRoom[], next: readonly OfficeRoom[]): boolean {
  return current.length === next.length && current.every((room, index) => {
    const candidate = next[index];
    return candidate?.id === room.id
      && candidate.label === room.label
      && candidate.state === room.state
      && candidate.channel === room.channel;
  });
}

function disposeGenerated(root: THREE.Object3D): void {
  root.traverse((object) => {
    if (!object.userData.generated) return;
    if (object instanceof THREE.Mesh) object.geometry.dispose();
    if (object instanceof THREE.Mesh || object instanceof THREE.Sprite) {
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => {
        if (material instanceof THREE.SpriteMaterial || material instanceof THREE.MeshBasicMaterial) {
          material.map?.dispose();
        }
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
  random: () => number = Math.random,
): OfficeEnvironmentController {
  let environment: THREE.Group;
  let actorRuntimes: ActorRuntime[] = [];
  let elapsed = 0;
  let renderedRooms: readonly OfficeRoom[] = [];

  const replaceEnvironment = (rooms: OfficeRoom[]) => {
    if (environment && hasSameVisualState(renderedRooms, rooms)) return;
    if (environment) {
      actorRuntimes.forEach(({ mixer }) => mixer.stopAllAction());
      scene.remove(environment);
      disposeGenerated(environment);
    }
    environment = buildOfficeEnvironment(rooms, models);
    renderedRooms = rooms;
    decorateEnvironment(environment, rooms);
    scene.add(environment);
    actorRuntimes = createActorRuntimes(environment, random);
  };

  replaceEnvironment(initialRooms);
  return {
    updateRooms: replaceEnvironment,
    updateAnimations: (delta) => {
      elapsed += delta;
      actorRuntimes.forEach(({ mixer, motion }) => {
        motion?.update(delta);
        mixer.update(delta);
      });
      updateStatusLights(environment, elapsed);
    },
    dispose: () => {
      actorRuntimes.forEach(({ mixer }) => mixer.stopAllAction());
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
