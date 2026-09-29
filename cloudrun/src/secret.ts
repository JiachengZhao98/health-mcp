import { createHash, timingSafeEqual } from "node:crypto";

export function isSecretSegment(segment: string, secret: string): boolean {
  if (!segment || !secret) return false;
  const a = createHash("sha256").update(segment).digest();
  const b = createHash("sha256").update(secret).digest();
  return timingSafeEqual(a, b);
}
