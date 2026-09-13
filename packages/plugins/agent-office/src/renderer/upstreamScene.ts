// Adapted from Agent Office Dashboard's single-level ring layout.
// Upstream: https://github.com/masakav3/Agent-Office-Dashboard
// Revision: ca3e5fc64ceb8092983bf8eb509afff57b3f085e
// License: MIT, Copyright © 2026 MATYPE

const HALF_PI = Math.PI / 2;
const OFFICE_STEP = 9.8;

function snap90(angle: number): number {
  return Math.round(angle / HALF_PI) * HALF_PI;
}

function orderedRingCells(ring: number): Array<[number, number]> {
  if (ring === 1) {
    return [
      [0, 1],
      [1, 0],
      [0, -1],
      [-1, 0],
      [1, 1],
      [-1, 1],
      [1, -1],
      [-1, -1],
    ];
  }

  const cells: Array<[number, number]> = [];
  for (let x = -ring; x <= ring; x += 1) {
    for (let z = -ring; z <= ring; z += 1) {
      if (Math.max(Math.abs(x), Math.abs(z)) === ring) cells.push([x, z]);
    }
  }

  return cells.sort((left, right) => {
    const angle = ([x, z]: [number, number]) => {
      const value = Math.atan2(x, z);
      return value < 0 ? value + Math.PI * 2 : value;
    };
    return angle(left) - angle(right);
  });
}

function officeCell(index: number): [number, number] {
  let remaining = index;
  let ring = 1;

  for (;;) {
    const cells = orderedRingCells(ring);
    if (remaining < cells.length) return cells[remaining];
    remaining -= cells.length;
    ring += 1;
  }
}

export function officeCellPosition(index: number): {
  x: number;
  z: number;
  rotationY: number;
} {
  const [gridX, gridZ] = officeCell(index);
  const x = gridX * OFFICE_STEP;
  const z = gridZ * OFFICE_STEP;
  return {
    x,
    z,
    rotationY: snap90(Math.atan2(-x, -z) - Math.PI / 4),
  };
}
