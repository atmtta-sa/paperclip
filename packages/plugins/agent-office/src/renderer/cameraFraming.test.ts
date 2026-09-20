import { describe, expect, it } from "vitest";
import { getOfficeCameraFrustum } from "./cameraFraming.js";

describe("getOfficeCameraFrustum", () => {
  it("keeps the rear-right coffee room inside a narrow expanded viewport", () => {
    const frustum = getOfficeCameraFrustum(390, 844);

    expect(frustum.right).toBeGreaterThanOrEqual(18);
    expect(frustum.left).toBeLessThanOrEqual(-18);
  });

  it("preserves the established desktop framing", () => {
    expect(getOfficeCameraFrustum(1440, 900)).toEqual({
      left: -28.8,
      right: 28.8,
      top: 18,
      bottom: -18,
    });
  });
});
