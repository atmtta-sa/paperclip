import * as THREE from "three";

const CERAMIC = new THREE.MeshStandardMaterial({
  color: 0xf8fafc,
  roughness: 0.3,
  metalness: 0.02,
});

function createCoffeeCup(x: number, y: number, z: number, rotationY = 0): THREE.Group {
  const cup = new THREE.Group();
  cup.name = "office-lounge-coffee-cup";
  cup.userData.generated = true;
  cup.position.set(x, y, z);
  cup.rotation.y = rotationY;

  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.075, 0.16, 16), CERAMIC);
  body.castShadow = true;
  cup.add(body);

  const coffee = new THREE.Mesh(
    new THREE.CircleGeometry(0.072, 16),
    new THREE.MeshStandardMaterial({ color: 0x4a2511, roughness: 0.65 }),
  );
  coffee.position.y = 0.082;
  coffee.rotation.x = -Math.PI / 2;
  cup.add(coffee);

  const handle = new THREE.Mesh(new THREE.TorusGeometry(0.055, 0.015, 8, 14, Math.PI * 1.5), CERAMIC);
  handle.position.set(0.085, 0, 0);
  handle.rotation.y = Math.PI / 2;
  cup.add(handle);
  return cup;
}

export function addLoungeDetails(atrium: THREE.Group): void {
  atrium.add(
    createCoffeeCup(-0.18, 0.72, 0.13, 0.35),
    createCoffeeCup(0.24, 0.72, 0.28, -0.5),
    createCoffeeCup(-2.48, 0.86, 0.62, Math.PI / 2),
  );

  const warmLight = new THREE.PointLight(0xffc36a, 0.65, 4.5, 2);
  warmLight.name = "office-lounge-warm-light";
  warmLight.userData.generated = true;
  warmLight.position.set(2.45, 2.15, -1.75);
  atrium.add(warmLight);

  const glow = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 16, 12),
    new THREE.MeshBasicMaterial({ color: 0xffd38a, transparent: true, opacity: 0.72, toneMapped: false }),
  );
  glow.name = "office-lounge-warm-glow";
  glow.userData.generated = true;
  glow.position.copy(warmLight.position);
  atrium.add(glow);
}
