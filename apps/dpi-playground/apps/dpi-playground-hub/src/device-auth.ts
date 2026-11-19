import { timingSafeEqual } from "node:crypto";
import type { NetworkRegistry } from "../../../../dpi-sdk/src/node/registry.js";

const bearer = (authorization: string | undefined) => {
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  return match?.[1];
};

/** Authenticate one remote device with the token already registered for that device. */
export function authenticateRemoteDevice(
  registry: NetworkRegistry,
  deviceId: string | undefined,
  authorization: string | undefined,
) {
  if (!deviceId) return false;
  const supplied = bearer(authorization);
  const expected = registry.get(deviceId)?.token;
  if (!supplied || !expected) return false;
  const left = Buffer.from(supplied);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
