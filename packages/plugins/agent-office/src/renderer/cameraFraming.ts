export interface OfficeCameraFrustum {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

const DEFAULT_HALF_HEIGHT = 18;
const MINIMUM_HALF_WIDTH = 18;

export function getOfficeCameraFrustum(width: number, height: number): OfficeCameraFrustum {
  const aspect = width / height;
  const halfHeight = Math.max(DEFAULT_HALF_HEIGHT, MINIMUM_HALF_WIDTH / aspect);
  const halfWidth = halfHeight * aspect;

  return {
    left: -halfWidth,
    right: halfWidth,
    top: halfHeight,
    bottom: -halfHeight,
  };
}
