/* Capture-metadata harness — v23.11.0
 *
 * Standalone, dependency-free smoke/regression checks for the capture
 * metadata implementation in js/app-core.js (CaptureMeta + State.gpsFixBuffer).
 * The project ships no build tooling, so this loads app-core.js inside a Node
 * `vm` context with minimal browser stubs and exercises the pure helpers,
 * the apply/merge orchestration, the previous-similar matcher, and the
 * additive normalization migration.
 *
 * Run:  node tests/capture-meta.harness.js
 * Exit: 0 = all pass, 1 = a check failed (or load error).
 *
 * These checks never touch the live alert engine; they assert that
 * CaptureMeta leaves captureBearing / heading untouched and that the new
 * metadata fields are produced correctly.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const noop = () => {};
const store = {};
const localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const elStub = () => ({
  style: {}, classList: { toggle: noop, add: noop, remove: noop, contains: () => false },
  querySelectorAll: () => [], addEventListener: noop, textContent: '', innerHTML: '', value: '',
});
const sandbox = {
  document: {
    getElementById: () => elStub(), querySelector: () => null, querySelectorAll: () => [],
    addEventListener: noop, createElement: () => elStub(), body: elStub(),
  },
  navigator: { geolocation: { watchPosition: () => 1, clearWatch: noop }, onLine: true, vibrate: noop },
  localStorage, console,
  setTimeout, clearTimeout, setInterval, clearInterval,
  Date, Math, JSON, Map, Set, Array, Object, String, Number, isNaN, parseInt, parseFloat, TextEncoder,
  addEventListener: noop,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const corePath = path.join(__dirname, '..', 'js', 'app-core.js');
const core = fs.readFileSync(corePath, 'utf8');
// `const` declarations do not attach to the context's global object, so append
// an epilogue that exposes the bits we test.
const epilogue = '\n;globalThis.CaptureMeta=CaptureMeta;globalThis.State=State;' +
  'globalThis.Utils=Utils;globalThis.Speed=Speed;globalThis.Audio=Audio;globalThis.Storage=Storage;';
try {
  vm.runInContext(core + epilogue, sandbox, { filename: 'app-core.js' });
} catch (e) {
  console.error('LOAD ERROR:', e.message);
  console.error(e.stack.split('\n').slice(0, 6).join('\n'));
  process.exit(1);
}
const { CaptureMeta, State } = sandbox;

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; } else { fail++; console.log('  FAIL:', name); } };
const approx = (a, b, tol) => Math.abs(a - b) < (tol == null ? 0.001 : tol);
const iso = ms => new Date(ms).toISOString();
const now = Date.now();

// Baseline State so helpers that read State don't throw.
State.data = { points: [] };
State.settings = { soundAlerts: {} };

console.log('--- 1. resolveCaptureHeading priority + capture scenarios ---');
// Stationary capture: no avg heading, no GPS heading, device heading present
// -> compass summary, motion stationary.
{
  const snap = { avgHeading: null, rawGpsHeadingDeg: null, speedMps: 0, deviceHeading: 300, lat: 1, lng: 1, accuracyM: 6, gpsAgeMs: 500 };
  const r = CaptureMeta.resolveCaptureHeading(snap);
  check('stationary -> compass summary', r.headingSource === 'compass' && r.headingDeg === 300);
  check('stationary motion', CaptureMeta.deriveCaptureMotionState(snap) === 'stationary');
  check('stationary dirQuality weak', CaptureMeta.deriveDirectionQuality(snap, r) === 'weak');
}
// Moving capture WITH GPS heading (avg null to isolate the GPS branch).
{
  const snap = { avgHeading: null, rawGpsHeadingDeg: 217, speedMps: 18, deviceHeading: 10 };
  const r = CaptureMeta.resolveCaptureHeading(snap);
  check('moving gps -> gps source', r.headingSource === 'gps' && r.headingDeg === 217);
  check('moving gps dirQuality good', CaptureMeta.deriveDirectionQuality(snap, r) === 'good');
  check('moving motion moving', CaptureMeta.deriveCaptureMotionState(snap) === 'moving');
}
// Moving capture using COMPUTED heading (no avg, no GPS heading, fixes >= 8m).
{
  const fixA = { lat: 40.0000, lng: -73.0000 };
  const fixB = { lat: 40.0010, lng: -73.0000 }; // ~111 m due north
  const snap = { avgHeading: null, rawGpsHeadingDeg: null, speedMps: 12, prevFix: fixA, lastFix: fixB, deviceHeading: 180 };
  const r = CaptureMeta.resolveCaptureHeading(snap);
  check('moving computed -> computed source', r.headingSource === 'computed');
  check('moving computed bearing ~0deg', approx(Math.round(r.headingDeg), 0));
  check('computed dirQuality usable', CaptureMeta.deriveDirectionQuality(snap, r) === 'usable');
}
// Computed skipped when movement < 8m -> falls through to compass.
{
  const fixA = { lat: 40.0000, lng: -73.0000 };
  const fixClose = { lat: 40.00001, lng: -73.0000 }; // ~1.1 m
  const r = CaptureMeta.resolveCaptureHeading({ avgHeading: null, rawGpsHeadingDeg: null, prevFix: fixA, lastFix: fixClose, deviceHeading: 90 });
  check('tiny move -> compass (not computed)', r.headingSource === 'compass');
}
// GPS heading ignored when too slow -> compass.
{
  const r = CaptureMeta.resolveCaptureHeading({ avgHeading: null, rawGpsHeadingDeg: 50, speedMps: 0.5, deviceHeading: 90 });
  check('slow gps ignored -> compass', r.headingSource === 'compass');
}
// No heading available at all -> none.
{
  const r = CaptureMeta.resolveCaptureHeading({ avgHeading: null, rawGpsHeadingDeg: null });
  check('no heading -> none', r.headingSource === 'none' && r.headingDeg === null);
  check('none dirQuality none', CaptureMeta.deriveDirectionQuality({}, r) === 'none');
}
// Average wins over everything (preserves existing captureBearing source).
{
  const r = CaptureMeta.resolveCaptureHeading({ avgHeading: 88, rawGpsHeadingDeg: 200, speedMps: 20, deviceHeading: 5 });
  check('average outranks gps/compass', r.headingSource === 'average' && r.headingDeg === 88);
}

console.log('--- 2. captureQuality rollup ---');
check('q good', CaptureMeta.deriveCaptureQuality({ lat: 1, lng: 1, accuracyM: 8, gpsAgeMs: 1000 }, 'good') === 'good');
check('q usable', CaptureMeta.deriveCaptureQuality({ lat: 1, lng: 1, accuracyM: 20, gpsAgeMs: 1000 }, 'weak') === 'usable');
check('q weak', CaptureMeta.deriveCaptureQuality({ lat: 1, lng: 1, accuracyM: 40, gpsAgeMs: 1000 }, 'none') === 'weak');
check('q bad (accuracy)', CaptureMeta.deriveCaptureQuality({ lat: 1, lng: 1, accuracyM: 80, gpsAgeMs: 1000 }, 'good') === 'bad');
check('q bad (stale)', CaptureMeta.deriveCaptureQuality({ lat: 1, lng: 1, accuracyM: 5, gpsAgeMs: 99999 }, 'good') === 'bad');
check('q bad (no lat/lng)', CaptureMeta.deriveCaptureQuality({ lat: null, lng: null, accuracyM: 5 }, 'good') === 'bad');

console.log('--- 3. applyCaptureMetadata: captureBearing/heading safety ---');
// Simulate post-onTick State for a moving capture with an averaged heading.
State.pos = { lat: 40.0, lng: -73.0 };
State.accuracy = 8; State.altitude = 100; State.altitudeAccuracy = 5;
State.gpsTimestamp = now - 1000; State.speedMps = 20; State.headingSource = 'gps'; State.deviceHeading = 270;
State.headingHistory = [{ t: now, deg: 90 }, { t: now, deg: 91 }, { t: now, deg: 89 }];
State.gpsFixBuffer = [
  { lat: 39.999, lng: -73.0, accuracyM: 9, altitudeM: 99, altitudeAccuracyM: 5, gpsTimestamp: now - 3000, rawGpsHeadingDeg: 90, rawSpeedMps: 20 },
  { lat: 40.0, lng: -73.0, accuracyM: 8, altitudeM: 100, altitudeAccuracyM: 5, gpsTimestamp: now - 1000, rawGpsHeadingDeg: 90, rawSpeedMps: 20 },
];
{
  const avg = State.avgHeading();
  const cam = { id: 'c1', type: 'speed_camera', lat: 40.0, lng: -73.0, createdAt: iso(now), captureBearing: avg, directional: true, side: 'right' };
  const before = cam.captureBearing;
  CaptureMeta.applyCaptureMetadata(cam);
  check('apply: captureBearing UNCHANGED', cam.captureBearing === before);
  check('apply: heading NOT written (stays undefined)', cam.heading === undefined);
  check('apply: headingDeg === captureBearing', cam.headingDeg === cam.captureBearing);
  check('apply: headingSource average', cam.headingSource === 'average');
  check('apply: dirQuality good (moving avg)', cam.directionQuality === 'good');
  check('apply: motion moving', cam.captureMotionState === 'moving');
  check('apply: quality good', cam.captureQuality === 'good');
  check('apply: capturedAt set', !!cam.capturedAt);
  check('apply: accuracyM=8', cam.accuracyM === 8);
  check('apply: altitude fields', cam.altitudeM === 100 && cam.altitudeAccuracyM === 5);
  check('apply: side estimate from explicit side', cam.sideOfRoadEstimate === 'right' && cam.sideOfRoadConfidence === 1);
  check('apply: heartbeat shape', cam.heartbeatAtCapture && typeof cam.heartbeatAtCapture.gpsFresh === 'boolean' && typeof cam.heartbeatAtCapture.storageOk === 'boolean');
  check('apply: alertSoundId resolved or null', cam.alertSoundId === null || typeof cam.alertSoundId === 'string');
  check('apply: configuredAlertDistanceM number', typeof cam.configuredAlertDistanceM === 'number');
  check('apply: repetition = prevSimilar+1', cam.repetitionCount === cam.previousSimilarCount + 1);
  check('apply: counters seeded 0', cam.confirmedCount === 0 && cam.falsePositiveCount === 0);
}
// Stationary camera with NO captureBearing -> captureBearing must STAY null.
{
  State.headingHistory = []; State.speedMps = 0;
  State.gpsFixBuffer = [{ lat: 40.0, lng: -73.0, accuracyM: 8, gpsTimestamp: now - 1000, rawGpsHeadingDeg: null, rawSpeedMps: 0, altitudeM: 100, altitudeAccuracyM: 5 }];
  const cam2 = { id: 'c2', type: 'speed_camera', lat: 40.0, lng: -73.0, createdAt: iso(now), captureBearing: null, directional: true };
  CaptureMeta.applyCaptureMetadata(cam2);
  check('apply2: captureBearing stays null', cam2.captureBearing === null);
  check('apply2: heading untouched', cam2.heading === undefined);
  check('apply2: headingDeg from compass summary', cam2.headingDeg === 270 && cam2.headingSource === 'compass');
  check('apply2: motion stationary', cam2.captureMotionState === 'stationary');
}

console.log('--- 4. mergeCaptureMetadata ---');
// Existing point with NO direction adopts new heading + captureBearing (spec §11).
{
  const nearby = { id: 'n1', type: 'speed_camera', lat: 40, lng: -73, confidence: 2 };
  const inc = { id: 'i1', type: 'speed_camera', headingDeg: 90, headingSource: 'average', directionQuality: 'good', captureBearing: 90, side: 'left' };
  CaptureMeta.mergeCaptureMetadata(nearby, inc);
  check('merge: repetition seeded confidence+1', nearby.repetitionCount === 3);
  check('merge: adopts headingDeg', nearby.headingDeg === 90);
  check('merge: adopts captureBearing (was none)', nearby.captureBearing === 90);
  check('merge: adopts heading (was none)', nearby.heading === 90);
  check('merge: explicit side wins', nearby.sideOfRoadEstimate === 'left' && nearby.sideOfRoadConfidence === 1);
  check('merge: lastSeenAt set', !!nearby.lastSeenAt);
}
// Existing point WITH strong heading is not weakened.
{
  const nearby = { id: 'n2', type: 'speed_camera', lat: 40, lng: -73, captureBearing: 200, heading: 200, headingDeg: 200, headingSource: 'average', repetitionCount: 5 };
  const incWeak = { id: 'i2', type: 'speed_camera', headingDeg: 30, headingSource: 'compass', directionQuality: 'weak', captureBearing: 30 };
  CaptureMeta.mergeCaptureMetadata(nearby, incWeak);
  check('merge: keeps strong captureBearing', nearby.captureBearing === 200);
  check('merge: keeps strong headingDeg', nearby.headingDeg === 200);
  check('merge: repetition increments', nearby.repetitionCount === 6);
}
// Existing point with no captureBearing AND incoming has no captureBearing:
// headingDeg adopted but captureBearing/heading stay null (no scoring impact).
{
  const nearby = { id: 'n2b', type: 'speed_camera', lat: 40, lng: -73 };
  const incNoCB = { id: 'i2b', type: 'speed_camera', headingDeg: 120, headingSource: 'compass', directionQuality: 'weak', captureBearing: null };
  CaptureMeta.mergeCaptureMetadata(nearby, incNoCB);
  check('merge: headingDeg adopted', nearby.headingDeg === 120);
  check('merge: captureBearing stays null (no real bearing)', nearby.captureBearing == null);
  check('merge: heading stays null (no real bearing)', nearby.heading == null);
}
// No explicit side -> existing estimate preserved.
{
  const nearby = { id: 'n3', type: 'petrol', lat: 1, lng: 1, sideOfRoadEstimate: 'right', sideOfRoadConfidence: 1, repetitionCount: 1 };
  CaptureMeta.mergeCaptureMetadata(nearby, { id: 'i3', type: 'petrol' });
  check('merge: preserves existing side estimate', nearby.sideOfRoadEstimate === 'right' && nearby.sideOfRoadConfidence === 1);
}

console.log('--- 5. getPreviousSimilarCaptures ---');
State.data.points = [
  { id: 'p1', type: 'speed_camera', lat: 40.0000, lng: -73.0000, captureBearing: 90, createdAt: iso(now - 5 * 60000) },   // 5 min, same dir
  { id: 'p2', type: 'speed_camera', lat: 40.0005, lng: -73.0000, captureBearing: 95, createdAt: iso(now - 10 * 60000) },  // 10 min, ~55m, same dir
  { id: 'p3', type: 'speed_camera', lat: 40.0000, lng: -73.0000, captureBearing: 270, createdAt: iso(now - 3 * 60000) },  // opposite dir -> excluded
  { id: 'p4', type: 'petrol',       lat: 40.0000, lng: -73.0000, createdAt: iso(now - 2 * 60000) },                       // diff type -> excluded
  { id: 'p5', type: 'speed_camera', lat: 40.0000, lng: -73.0000, captureBearing: 90, createdAt: iso(now - 30 * 60000) },  // 30 min -> outside window
  { id: 'p6', type: 'speed_camera', lat: 41.0000, lng: -73.0000, captureBearing: 90, createdAt: iso(now - 1 * 60000) },   // ~111km -> outside dist
];
{
  const np = { id: 'new', type: 'speed_camera', lat: 40.0, lng: -73.0, captureBearing: 92, capturedAt: iso(now) };
  const sim = CaptureMeta.getPreviousSimilarCaptures(np);
  check('similar: same-direction within 20min -> p1,p2', sim.count === 2 && sim.ids.includes('p1') && sim.ids.includes('p2'));
  check('similar: rejects opposite direction (p3)', !sim.ids.includes('p3'));
  check('similar: rejects different type (p4)', !sim.ids.includes('p4'));
  check('similar: rejects outside 20min window (p5)', !sim.ids.includes('p5'));
  check('similar: rejects outside 500m (p6)', !sim.ids.includes('p6'));
  check('similar: most-recent first', sim.ids[0] === 'p1');
}
{
  // No-direction new point matches only no-direction points of same type.
  const npND = { id: 'nd', type: 'petrol', lat: 40.0, lng: -73.0, capturedAt: iso(now) };
  const sim = CaptureMeta.getPreviousSimilarCaptures(npND);
  check('similar: no-direction matches no-direction same type', sim.count === 1 && sim.ids[0] === 'p4');
}
{
  // Cap at 3 results.
  const many = [];
  for (let i = 0; i < 6; i++) many.push({ id: 'm' + i, type: 'gate', lat: 40.0, lng: -73.0, createdAt: iso(now - (i + 1) * 60000) });
  State.data.points = many;
  const sim = CaptureMeta.getPreviousSimilarCaptures({ id: 'mg', type: 'gate', lat: 40.0, lng: -73.0, capturedAt: iso(now) });
  check('similar: capped at 3', sim.count === 3 && sim.ids.length === 3);
  check('similar: count equals ids length', sim.count === sim.ids.length);
}

console.log('--- 6. normalize: old local point ---');
{
  const legacy = [
    { id: 'L1', type: 'speed_camera', lat: 1, lng: 1, captureBearing: 120, confidence: 3, gpsAccuracy: 14, createdAt: iso(now), side: 'left' },
    { id: 'L2', type: 'petrol', lat: 2, lng: 2, createdAt: iso(now) },
    { id: 'L3', type: 'speed_change', lat: 3, lng: 3, createdAt: iso(now) },
  ];
  const touched = CaptureMeta.normalize(legacy);
  check('normalize: touched all 3', touched === 3);
  const L1 = legacy[0], L2 = legacy[1], L3 = legacy[2];
  check('L1 capturedAt from createdAt', L1.capturedAt === L1.createdAt);
  check('L1 accuracyM from gpsAccuracy', L1.accuracyM === 14);
  check('L1 headingDeg=captureBearing', L1.headingDeg === 120);
  check('L1 heading=captureBearing', L1.heading === 120);
  check('L1 headingSource average', L1.headingSource === 'average');
  check('L1 dirQuality usable', L1.directionQuality === 'usable');
  check('L1 repetition=confidence', L1.repetitionCount === 3);
  check('L1 side estimate left', L1.sideOfRoadEstimate === 'left' && L1.sideOfRoadConfidence === 1);
  check('L1 directional true (camera)', L1.directional === true);
  check('L1 legacy fields preserved', L1.captureBearing === 120 && L1.confidence === 3 && L1.gpsAccuracy === 14 && L1.side === 'left' && !!L1.createdAt);
  check('L2 no heading -> none', L2.headingSource === 'none' && L2.directionQuality === 'none' && L2.headingDeg === undefined);
  check('L2 side unknown', L2.sideOfRoadEstimate === 'unknown' && L2.sideOfRoadConfidence === 0);
  check('L2 repetition default 1', L2.repetitionCount === 1);
  check('L2 directional false (petrol)', L2.directional === false);
  check('L3 directional false (speed_change)', L3.directional === false);
  // Idempotent.
  check('normalize idempotent', CaptureMeta.normalize(legacy) === 0);
}

console.log('--- 7. normalize: imported old backup point (import path) ---');
{
  // Mirrors UI import: CaptureMeta.normalize(addedPoints) on points lacking metadata.
  const imported = [
    { id: 'IMP1', type: 'mobile_camera', lat: 10, lng: 10, captureBearing: 45, confidence: 2, createdAt: iso(now) },
    { id: 'IMP2', type: 'gate', lat: 11, lng: 11 }, // no createdAt at all
  ];
  const touched = CaptureMeta.normalize(imported);
  check('import-normalize: touched both', touched === 2);
  check('IMP1 headingDeg=captureBearing', imported[0].headingDeg === 45);
  check('IMP1 accuracyM absent (no gpsAccuracy)', imported[0].accuracyM === undefined);
  check('IMP1 captureQuality derived (acc unknown -> weak)', imported[0].captureQuality === 'weak');
  check('IMP1 directional true (camera)', imported[0].directional === true);
  check('IMP2 capturedAt null (no createdAt)', imported[1].capturedAt === null);
  check('IMP2 side unknown', imported[1].sideOfRoadEstimate === 'unknown');
  check('IMP2 legacy untouched (no fabricated bearing)', imported[1].captureBearing === undefined && imported[1].heading === undefined);
}

console.log(`\nCapture-metadata harness: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
