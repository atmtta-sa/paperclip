import * as THREE from "three";
import { clone as cloneSkeleton } from "three/addons/utils/SkeletonUtils.js";
import type { LoadedOfficeModel } from "./sceneComposition.js";

const ROBOT_HEIGHT = 1.2;
const SMOKE_COUNT = 7;
const SPARK_COUNT = 10;

function generatedMaterial(color: number, opacity: number): THREE.MeshBasicMaterial {
  return new THREE.MeshBasicMaterial({
    color,
    opacity,
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
}

function createRobot(model?: LoadedOfficeModel): THREE.Object3D {
  if (model) {
    const robot = cloneSkeleton(model.object);
    robot.scale.setScalar(ROBOT_HEIGHT / Math.max(model.size.y, 0.001));
    robot.name = "office-error-monster-robot";
    return robot;
  }
  const robot = new THREE.Mesh(
    new THREE.BoxGeometry(0.5, 0.9, 0.4),
    new THREE.MeshStandardMaterial({ color: 0xc0392b, roughness: 0.5 }),
  );
  robot.name = "office-error-monster-robot";
  robot.position.y = 0.45;
  robot.userData.generated = true;
  return robot;
}

export function createErrorMonster(model?: LoadedOfficeModel): THREE.Group {
  const monster = new THREE.Group();
  monster.name = "office-error-monster";
  monster.position.set(0, 0.16, -0.35);
  monster.userData.generated = true;

  const robot = createRobot(model);
  monster.add(robot);

  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 32),
    generatedMaterial(0xff3a1e, 0.6),
  );
  disc.name = "office-error-monster-warning-disc";
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.02;
  disc.userData.generated = true;
  monster.add(disc);

  for (let index = 0; index < SMOKE_COUNT; index += 1) {
    const smoke = new THREE.Mesh(
      new THREE.SphereGeometry(0.07, 8, 6),
      generatedMaterial(0x6b6b72, 0),
    );
    smoke.name = "office-error-monster-smoke";
    smoke.userData = { generated: true, phase: index / SMOKE_COUNT };
    monster.add(smoke);
  }

  for (let index = 0; index < SPARK_COUNT; index += 1) {
    const spark = new THREE.Mesh(
      new THREE.SphereGeometry(0.03, 6, 5),
      generatedMaterial(0xffb640, 0),
    );
    spark.name = "office-error-monster-spark";
    spark.userData = { generated: true, phase: index / SPARK_COUNT };
    monster.add(spark);
  }

  return monster;
}

export function updateErrorMonsters(root: THREE.Object3D, elapsed: number): void {
  root.getObjectsByProperty("name", "office-error-monster").forEach((monster) => {
    const robot = monster.getObjectByName("office-error-monster-robot");
    if (robot) {
      robot.position.x = (Math.sin(elapsed * 37) + Math.sin(elapsed * 53)) * 0.012;
      robot.position.z = (Math.cos(elapsed * 41) + Math.sin(elapsed * 61)) * 0.012;
      robot.rotation.y = Math.sin(elapsed * 2) * 0.22;
    }

    const disc = monster.getObjectByName("office-error-monster-warning-disc");
    if (disc instanceof THREE.Mesh && disc.material instanceof THREE.MeshBasicMaterial) {
      const pulse = 0.5 + 0.5 * Math.sin(elapsed * 6);
      disc.material.opacity = 0.35 + 0.4 * pulse;
      disc.scale.setScalar(0.92 + pulse * 0.14);
    }

    monster.getObjectsByProperty("name", "office-error-monster-smoke").forEach((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshBasicMaterial)) return;
      const phase = (elapsed * 0.5 + Number(object.userData.phase)) % 1;
      object.position.set(
        Math.sin(elapsed * 1.3 + phase * 9) * 0.06,
        ROBOT_HEIGHT + phase * 0.55,
        Math.cos(elapsed * 1.1 + phase * 7) * 0.06,
      );
      object.scale.setScalar(0.7 + phase * 1.2);
      object.material.opacity = (1 - phase) * 0.48;
    });

    monster.getObjectsByProperty("name", "office-error-monster-spark").forEach((object) => {
      if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshBasicMaterial)) return;
      const phase = Number(object.userData.phase);
      const burst = Math.max(0, Math.sin(elapsed * 5 + phase * Math.PI * 2));
      const radius = 0.3 + burst * 0.22;
      object.position.set(
        Math.cos(phase * Math.PI * 2) * radius,
        ROBOT_HEIGHT * 0.78 + burst * 0.4,
        Math.sin(phase * Math.PI * 2) * radius,
      );
      object.material.opacity = burst > 0.72 ? (burst - 0.72) / 0.28 : 0;
    });
  });
}
