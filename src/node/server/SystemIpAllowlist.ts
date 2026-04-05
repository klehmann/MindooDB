/**
 * Optional IP allowlist for /system/* routes (MINDOODB_ADMIN_ALLOWED_IPS).
 *
 * Comma-separated IPv4/IPv6 addresses or IPv4/IPv6 CIDRs. Use `*` to allow all.
 * IPv4-mapped IPv6 (::ffff:x.x.x.x) is normalized to the IPv4 form for matching.
 */

import type { NextFunction, Request, Response } from "express";
import { isIPv4, isIPv6 } from "net";

const ENV_KEY = "MINDOODB_ADMIN_ALLOWED_IPS";

export function readSystemIpAllowListFromEnv(): string | undefined {
  const raw = process.env[ENV_KEY];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
  }
  return raw.trim();
}

/**
 * When unset or `*`, no IP restriction (JWT + capabilities still apply).
 */
export function isSystemIpAllowListDisabled(raw: string | undefined): boolean {
  if (raw === undefined || raw === "*") {
    return true;
  }
  return false;
}

function normalizeClientIp(ip: string): string {
  if (ip.startsWith("::ffff:")) {
    const v4 = ip.slice(7);
    if (isIPv4(v4)) {
      return v4;
    }
  }
  return ip;
}

function ipv4ToInt(ip: string): number {
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return -1;
  }
  return (((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0) as number;
}

function ipv4MatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) {
    return false;
  }
  const base = cidr.slice(0, slash);
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (!isIPv4(base) || Number.isNaN(bits) || bits < 0 || bits > 32) {
    return false;
  }
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  if (ipNum < 0 || baseNum < 0) {
    return false;
  }
  if (bits === 0) {
    return true;
  }
  const mask =
    bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ipNum & mask) === (baseNum & mask);
}

function parseIpv4Parts(ip: string): number[] | null {
  if (!isIPv4(ip)) {
    return null;
  }
  const parts = ip.split(".").map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n) || n < 0 || n > 255)) {
    return null;
  }
  return parts;
}

function parseIpv6SegmentList(part: string): number[] | null {
  if (part === "") {
    return [];
  }

  const segments: number[] = [];
  for (const token of part.split(":")) {
    if (token.length === 0) {
      return null;
    }

    if (token.includes(".")) {
      const ipv4Parts = parseIpv4Parts(token);
      if (!ipv4Parts) {
        return null;
      }
      segments.push((ipv4Parts[0] << 8) | ipv4Parts[1]);
      segments.push((ipv4Parts[2] << 8) | ipv4Parts[3]);
      continue;
    }

    if (!/^[0-9a-fA-F]{1,4}$/.test(token)) {
      return null;
    }

    segments.push(parseInt(token, 16));
  }

  return segments;
}

function ipv6ToBigInt(ip: string): bigint | null {
  if (!isIPv6(ip)) {
    return null;
  }

  const doubleColonCount = ip.split("::").length - 1;
  if (doubleColonCount > 1) {
    return null;
  }

  let parts: number[];

  if (ip.includes("::")) {
    const [leftRaw, rightRaw] = ip.split("::");
    const left = parseIpv6SegmentList(leftRaw);
    const right = parseIpv6SegmentList(rightRaw);
    if (!left || !right) {
      return null;
    }
    const missing = 8 - (left.length + right.length);
    if (missing < 1) {
      return null;
    }
    parts = [...left, ...new Array<number>(missing).fill(0), ...right];
  } else {
    const parsed = parseIpv6SegmentList(ip);
    if (!parsed || parsed.length !== 8) {
      return null;
    }
    parts = parsed;
  }

  if (parts.length !== 8 || parts.some((n) => n < 0 || n > 0xffff)) {
    return null;
  }

  let result = 0n;
  for (const part of parts) {
    result = (result << 16n) | BigInt(part);
  }
  return result;
}

function ipv6MatchesCidr(ip: string, cidr: string): boolean {
  const slash = cidr.indexOf("/");
  if (slash === -1) {
    return false;
  }
  const base = cidr.slice(0, slash);
  const bits = parseInt(cidr.slice(slash + 1), 10);
  if (!isIPv6(base) || Number.isNaN(bits) || bits < 0 || bits > 128) {
    return false;
  }

  const ipNum = ipv6ToBigInt(ip);
  const baseNum = ipv6ToBigInt(base);
  if (ipNum === null || baseNum === null) {
    return false;
  }
  if (bits === 0) {
    return true;
  }

  const shift = 128n - BigInt(bits);
  return (ipNum >> shift) === (baseNum >> shift);
}

/**
 * Returns true if clientIp is allowed by the allowlist string (non-empty, not `*`).
 */
export function isClientIpAllowedForSystemList(
  clientIpRaw: string,
  allowListRaw: string,
): boolean {
  const clientIp = normalizeClientIp(clientIpRaw.trim());
  const entries = allowListRaw.split(",").map((s) => s.trim()).filter(Boolean);

  for (const entry of entries) {
    if (entry.includes("/")) {
      if (isIPv4(clientIp) && ipv4MatchesCidr(clientIp, entry)) {
        return true;
      }
      if (isIPv6(clientIp) && ipv6MatchesCidr(clientIp, entry)) {
        return true;
      }
      continue;
    }
    if (clientIp === entry) {
      return true;
    }
    if (isIPv6(clientIp) && isIPv6(entry) && ipv6ToBigInt(clientIp) === ipv6ToBigInt(entry)) {
      return true;
    }
  }

  return false;
}

/**
 * Express middleware: 403 if client IP not in allowlist (when env is set).
 */
export function systemIpAllowlistMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const raw = readSystemIpAllowListFromEnv();
  if (isSystemIpAllowListDisabled(raw)) {
    next();
    return;
  }

  const ip =
    (typeof req.ip === "string" && req.ip.length > 0
      ? req.ip
      : req.socket?.remoteAddress) || "";
  const normalized = normalizeClientIp(ip);

  if (!normalized || (!isIPv4(normalized) && !isIPv6(normalized))) {
    res.status(403).json({ error: "Forbidden: system admin IP not allowed" });
    return;
  }

  if (!isClientIpAllowedForSystemList(normalized, raw!)) {
    res.status(403).json({ error: "Forbidden: system admin IP not allowed" });
    return;
  }

  next();
}
