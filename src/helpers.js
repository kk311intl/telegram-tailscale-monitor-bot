import { t } from "./i18n.js";

const timeFormatOptions = {
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit",
  hourCycle: "h23", timeZoneName: "shortOffset"
};
let timeFormatter = { timeZone: "", value: null };

export function clampInteger(value, minimum, maximum, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const text = String(value).trim();
  if (!/^-?\d+$/.test(text)) return fallback;
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function formatAge(timestamp, current = Math.floor(Date.now() / 1000), lang = "zh") {
  const seconds = Math.max(0, Number(current) - Number(timestamp || 0));
  if (!timestamp) return t(lang, "notChecked");
  if (seconds < 60) return t(lang, "ageSeconds", seconds);
  if (seconds < 3600) return t(lang, "ageMinutes", Math.floor(seconds / 60));
  if (seconds < 86400) return t(lang, "ageHours", Math.floor(seconds / 3600));
  return t(lang, "ageDays", Math.floor(seconds / 86400));
}

export function formatLocalTime(timestamp, timeZone = "UTC") {
  if (timeFormatter.timeZone !== timeZone || !timeFormatter.value) {
    let value;
    try {
      value = new Intl.DateTimeFormat("en-CA", { ...timeFormatOptions, timeZone });
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      value = new Intl.DateTimeFormat("en-CA", { ...timeFormatOptions, timeZone: "UTC" });
    }
    timeFormatter = { timeZone, value };
  }
  const parts = Object.fromEntries(timeFormatter.value.formatToParts(new Date(Number(timestamp) * 1000)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.timeZoneName.replace(/^GMT/, "UTC")}`;
}

export function evaluateObservation(previous, reachable, offlineAfter) {
  const was = previous?.status || "unknown";
  const failures = reachable ? 0 : Number(previous?.consecutive_failures || 0) + 1;
  const successes = reachable ? Number(previous?.consecutive_successes || 0) + 1 : 0;
  let status = was;
  let event = null;
  if (reachable) {
    status = "up";
    if (was === "down") event = "recovered";
  } else if (failures >= offlineAfter) {
    status = "down";
    if (was !== "down") event = "down";
  }
  return { status, failures, successes, event };
}

export function normalizeTailscaleDevice(value) {
  if (!value || typeof value !== "object") throw new Error("Tailscale Devices API: 設備格式無效");
  const id = boundedText(value.nodeId || value.id, 200);
  if (!id || typeof value.connectedToControl !== "boolean") {
    throw new Error("Tailscale Devices API: 設備缺少 nodeId/id 或 connectedToControl");
  }
  const hostname = boundedText(value.hostname, 255);
  const name = boundedText(value.name, 255);
  const addresses = Array.isArray(value.addresses)
    ? value.addresses.slice(0, 16).map((item) => boundedText(item, 64)).filter(Boolean)
    : [];
  const tags = Array.isArray(value.tags)
    ? value.tags.map((item) => boundedText(item, 128)).filter(Boolean)
    : [];
  return {
    id,
    displayName: name ? name.split(".")[0] : hostname || id,
    hostname,
    name,
    addresses,
    tags,
    publicIp: extractPublicEndpoint(value.clientConnectivity?.endpoints),
    os: boundedText(value.os, 64),
    connectedToControl: value.connectedToControl,
    lastSeen: validDateText(value.lastSeen),
    expires: validDateText(value.expires)
  };
}

export function hasHiddenTag(device, hiddenTags) {
  return Array.isArray(device?.tags) && device.tags.some((tag) => hiddenTags.has(String(tag).toLowerCase()));
}

export function extractPublicEndpoint(endpoints) {
  if (!Array.isArray(endpoints)) return "";
  let ipv6 = "";
  for (let index = 0; index < Math.min(endpoints.length, 32); index++) {
    const host = endpointHost(endpoints[index]);
    if (!isPublicIp(host)) continue;
    if (ipv4Number(host) !== null) return host;
    if (!ipv6) ipv6 = host;
  }
  return ipv6;
}

function endpointHost(value) {
  const text = boundedText(value, 128);
  if (!text) return "";
  const ipv4 = text.match(/^((?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}):(\d{1,5})$/);
  if (ipv4 && Number(ipv4[2]) <= 65535 && ipv4Number(ipv4[1]) !== null) return ipv4[1];
  try {
    return new URL(`udp://${text}`).hostname.replace(/^\[|\]$/g, "").toLowerCase();
  } catch { return ""; }
}

function isPublicIp(value) {
  const ipv4 = ipv4Number(value);
  if (ipv4 !== null) {
    const [a, b, c] = String(value).split(".").map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 192 && b === 88 && c === 99) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113));
  }
  const ipv6 = String(value || "").toLowerCase();
  // Only global-unicast IPv6; mapped IPv4, NAT64 and local ranges are excluded.
  return /^[23][0-9a-f]{3}:/.test(ipv6) &&
    !/^2001:(?:0:|2:|10:|20:|db8:)/.test(ipv6) && !/^2002:/.test(ipv6) && !/^3fff:/.test(ipv6);
}

export function countryCodeToFlag(value) {
  const code = String(value || "").trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(code)) return "";
  return String.fromCodePoint(...[...code].map((letter) => 127397 + letter.charCodeAt(0)));
}

export function compareTailscaleAddresses(left, right) {
  const a = ipv4Number(left);
  const b = ipv4Number(right);
  if (a !== null && b !== null) return a - b;
  if (a !== null) return -1;
  if (b !== null) return 1;
  const a6 = ipv6Number(left);
  const b6 = ipv6Number(right);
  if (a6 !== null && b6 !== null) return a6 < b6 ? -1 : a6 > b6 ? 1 : 0;
  if (a6 !== null) return -1;
  if (b6 !== null) return 1;
  return String(left || "").localeCompare(String(right || ""), "en");
}

function ipv6Number(value) {
  try {
    const normalized = new URL(`http://[${value}]/`).hostname.slice(1, -1);
    const [left, right] = normalized.split("::");
    const head = left ? left.split(":") : [];
    const tail = right ? right.split(":") : [];
    const parts = [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail];
    if (parts.length !== 8) return null;
    return parts.reduce((total, part) => (total << 16n) + BigInt(`0x${part}`), 0n);
  } catch { return null; }
}

function ipv4Number(value) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4 || parts.some((part) => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  return parts.reduce((total, part) => total * 256 + Number(part), 0);
}

function boundedText(value, maximum) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, maximum);
}

function validDateText(value) {
  const text = boundedText(value, 64);
  return text && Number.isFinite(Date.parse(text)) ? text : "";
}

export function notificationFailurePlan(error, previousAttempts, now) {
  const nextAttempts = Number(previousAttempts || 0) + 1;
  const telegramCode = Number(error?.telegramErrorCode || 0);
  const permanent = error?.name === "SyntaxError" ||
    (telegramCode >= 400 && telegramCode < 500 && telegramCode !== 429);
  if (permanent) return { terminal: true, attempts: nextAttempts, nextAttemptAt: 0 };
  const retryAfter = Number(error?.retryAfter || 0);
  const retryDelay = telegramCode === 429 && Number.isFinite(retryAfter) && retryAfter > 0
    ? Math.ceil(retryAfter)
    : Math.min(3600, 60 * (2 ** Math.min(nextAttempts - 1, 6)));
  return { terminal: false, attempts: nextAttempts, nextAttemptAt: Number(now) + retryDelay };
}
