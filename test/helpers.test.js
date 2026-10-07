import test from "node:test";
import assert from "node:assert/strict";
import {
  clampInteger,
  compareTailscaleAddresses,
  countryCodeToFlag,
  evaluateObservation,
  extractPublicEndpoint,
  formatAge,
  formatLocalTime,
  hasHiddenTag,
  normalizeTailscaleDevice,
  notificationFailurePlan
} from "../src/helpers.js";
import { language, messages, t } from "../src/i18n.js";

test("Tailscale IPv4 addresses sort numerically and before IPv6", () => {
  const addresses = ["100.64.0.10", "fd7a:115c:a1e0::1", "100.64.0.2", "100.100.0.1"];
  assert.deepEqual(addresses.sort(compareTailscaleAddresses), [
    "100.64.0.2",
    "100.64.0.10",
    "100.100.0.1",
    "fd7a:115c:a1e0::1"
  ]);
});

test("Tailscale IPv6 addresses sort numerically, including compressed forms", () => {
  const addresses = ["fd7a:115c:a1e0::10", "fd7a:115c:a1e0::2", "2001:db8::1", "fd7a:115c:a1e0::1"];
  assert.deepEqual(addresses.sort(compareTailscaleAddresses), [
    "2001:db8::1", "fd7a:115c:a1e0::1", "fd7a:115c:a1e0::2", "fd7a:115c:a1e0::10"
  ]);
  assert.equal(compareTailscaleAddresses("fd7a:115c:a1e0::2", "fd7a:115c:a1e0:0:0:0:0:2"), 0);
});

test("integer settings reject partial and fractional values", () => {
  assert.equal(clampInteger("7", 1, 10, 3), 7);
  assert.equal(clampInteger(undefined, 1, 10, 5), 5);
  assert.equal(clampInteger("7garbage", 1, 10, 3), 3);
  assert.equal(clampInteger("3.5", 1, 10, 3), 3);
});

test("notification timestamps use the configured time zone and current offset", () => {
  assert.equal(formatLocalTime(0), "1970-01-01 00:00:00 UTC+0");
  assert.equal(formatLocalTime(0, "UTC"), "1970-01-01 00:00:00 UTC+0");
  assert.equal(formatLocalTime(Date.parse("2026-01-01T12:00:00Z") / 1000, "America/New_York"), "2026-01-01 07:00:00 UTC-5");
  assert.equal(formatLocalTime(Date.parse("2026-07-01T12:00:00Z") / 1000, "America/New_York"), "2026-07-01 08:00:00 UTC-4");
  assert.equal(formatLocalTime(0, "Invalid/Zone"), "1970-01-01 00:00:00 UTC+0");
});

test("repeated notification timestamps reuse Intl while keeping DST and invalid-zone fallback", t => {
  const Original = Intl.DateTimeFormat;
  let constructors = 0;
  t.mock.method(Intl, "DateTimeFormat", function (...args) {
    constructors++;
    return new Original(...args);
  });
  assert.equal(formatLocalTime(Date.parse("2026-01-01T12:00:00Z") / 1000, "Europe/Paris"), "2026-01-01 13:00:00 UTC+1");
  assert.equal(formatLocalTime(Date.parse("2026-07-01T12:00:00Z") / 1000, "Europe/Paris"), "2026-07-01 14:00:00 UTC+2");
  assert.equal(constructors, 1);
  assert.equal(formatLocalTime(0, "Invalid/Repeated"), "1970-01-01 00:00:00 UTC+0");
  assert.equal(formatLocalTime(1, "Invalid/Repeated"), "1970-01-01 00:00:01 UTC+0");
  assert.equal(constructors, 2);
});

test("all deployment languages have matching UI messages and invalid values fall back to Chinese", () => {
  const keys = Object.keys(messages.zh).sort();
  for (const lang of ["ja", "en"]) assert.deepEqual(Object.keys(messages[lang]).sort(), keys);
  assert.equal(language("en"), "en");
  assert.equal(language("invalid"), "zh");
  assert.equal(t("invalid", "online"), "在線");
  assert.equal(formatAge(0, 100, "en"), "Not checked yet");
  assert.equal(formatAge(1, 62, "en"), "1 minute ago");
});

test("Tailscale device input is normalized and bounded", () => {
  assert.deepEqual(normalizeTailscaleDevice({
    id: "legacy-1",
    nodeId: "node-1",
    hostname: "original-host\u0000",
    name: "nas-note.example.ts.net",
    addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    tags: ["tag:server"],
    clientConnectivity: { endpoints: ["192.168.1.2:41641", "8.8.8.8:41641"] },
    os: "linux",
    connectedToControl: true,
    lastSeen: "2026-09-20T00:00:00Z",
    expires: "bad-date"
  }), {
    id: "node-1",
    displayName: "nas-note",
    hostname: "original-host",
    name: "nas-note.example.ts.net",
    addresses: ["100.64.0.1", "fd7a:115c:a1e0::1"],
    tags: ["tag:server"],
    publicIp: "8.8.8.8",
    os: "linux",
    connectedToControl: true,
    lastSeen: "2026-09-20T00:00:00Z",
    expires: ""
  });
  assert.throws(() => normalizeTailscaleDevice({ id: "node-1" }), /connectedToControl/);
  assert.throws(() => normalizeTailscaleDevice({ connectedToControl: true }), /id/);
});

test("only configured tags hide devices", () => {
  const hidden = new Set(["tag:personal"]);
  assert.equal(hasHiddenTag({ tags: ["tag:server", "tag:personal"] }, hidden), true);
  assert.equal(hasHiddenTag({ tags: ["TAG:PERSONAL"] }, hidden), true);
  assert.equal(hasHiddenTag({ tags: ["tag:personality"] }, hidden), false);
  assert.equal(hasHiddenTag({ tags: ["tag:personal"] }, new Set()), false);
  assert.equal(hasHiddenTag({}, hidden), false);
});

test("public endpoint extraction excludes tailnet and private addresses", () => {
  assert.equal(extractPublicEndpoint([
    "100.64.0.1:41641",
    "192.168.1.2:41641",
    "8.8.8.8:41641"
  ]), "8.8.8.8");
  assert.equal(extractPublicEndpoint(["[2606:4700:4700::1111]:41641"]), "2606:4700:4700::1111");
  assert.equal(extractPublicEndpoint(["10.0.0.1:41641"]), "");
});

test("endpoint parsing keeps IPv4 preference and stops once a public IPv4 is found", () => {
  let unnecessaryReads = 0;
  const trailing = { toString() { unnecessaryReads++; return "1.1.1.1:41641"; } };
  assert.equal(extractPublicEndpoint(["[2606:4700:4700::1111]:41641", "10.0.0.1:41641", "8.8.8.8:41641", trailing]), "8.8.8.8");
  assert.equal(unnecessaryReads, 0);
});

test("ISO country codes convert to flags safely", () => {
  assert.equal(countryCodeToFlag("JP"), "🇯🇵");
  assert.equal(countryCodeToFlag("us"), "🇺🇸");
  assert.equal(countryCodeToFlag("JPN"), "");
});

test("offline notification requires consecutive API observations", () => {
  let device = { status: "up", consecutive_failures: 0, consecutive_successes: 3 };
  let result = evaluateObservation(device, false, 3);
  assert.equal(result.status, "up");
  device = { ...device, status: result.status, consecutive_failures: result.failures, consecutive_successes: result.successes };
  result = evaluateObservation(device, false, 3);
  assert.equal(result.status, "up");
  device = { ...device, status: result.status, consecutive_failures: result.failures, consecutive_successes: result.successes };
  result = evaluateObservation(device, false, 3);
  assert.equal(result.status, "down");
  assert.equal(result.event, "down");
});

test("a confirmed outage recovers after the first online API observation", () => {
  const result = evaluateObservation({ status: "down", consecutive_failures: 4 }, true, 3);
  assert.equal(result.status, "up");
  assert.equal(result.event, "recovered");
});

test("first online observation establishes state without alert", () => {
  const result = evaluateObservation({ status: "unknown" }, true, 3);
  assert.equal(result.status, "up");
  assert.equal(result.event, null);
});

test("notification retries honor Telegram retry_after", () => {
  const error = Object.assign(new Error("rate limited"), { telegramErrorCode: 429, retryAfter: 17 });
  assert.deepEqual(notificationFailurePlan(error, 2, 1000), { terminal: false, attempts: 3, nextAttemptAt: 1017 });
});

test("permanent and transient notification errors use the correct retry plan", () => {
  const permanent = Object.assign(new Error("bad request"), { telegramErrorCode: 400 });
  assert.equal(notificationFailurePlan(permanent, 0, 1000).terminal, true);
  assert.equal(notificationFailurePlan(new Error("network"), 0, 1000).nextAttemptAt, 1060);
  assert.equal(notificationFailurePlan(new Error("network"), 20, 1000).nextAttemptAt, 4600);
});
