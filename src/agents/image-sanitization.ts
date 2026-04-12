import type { OpenClawConfig } from "../config/config.js";

export type ImageSanitizationLimits = {
  maxDimensionPx?: number;
  maxBytes?: number;
};

export const DEFAULT_IMAGE_MAX_DIMENSION_PX = 3840; // increase to allow up to 4K images
export const DEFAULT_IMAGE_MAX_BYTES = 5 * 1024 * 1024; // Match chat.ts with 5mb limit

export function resolveImageSanitizationLimits(cfg?: OpenClawConfig): ImageSanitizationLimits {
  const configured = cfg?.agents?.defaults?.imageMaxDimensionPx;
  if (typeof configured !== "number" || !Number.isFinite(configured)) {
    return {};
  }
  return { maxDimensionPx: Math.max(1, Math.floor(configured)) };
}
