/**
 * Multi-session RoomPlan capture flattening.
 *
 * Apple's RoomPlan app, when a scan is paused and resumed (the common
 * workflow for scanning a multi-story home floor by floor), exports a
 * `{ captureSessions: [{ roomplanSessions: [...] }] }` wrapper instead of
 * the flat `{ walls, doors, ... }` shape `importRoomPlanFloors` understands.
 * Each `roomplanSessions[]` entry is a COMPLETE independent capture (its own
 * walls/doors/windows/objects/floors/sections) with its own ARKit world
 * origin (`referenceOriginTransform`) — critically, two sessions' `story`
 * fields are OFTEN BOTH 0 (RoomPlan's default), even when they are
 * genuinely different floors, because the capturing app has no built-in
 * concept of "which floor is this" to write into the export.
 *
 * This flattens that nested shape into the single flat object
 * `importRoomPlanFloors`/`createProjectFromRoomPlan` already handle, so nothing
 * downstream (validation, straightening, room detection) needs to know
 * multi-session captures exist. Two things must happen before that flatten:
 *
 *  1. Assign a real per-session story index when the source `story` fields
 *     don't already distinguish the sessions (elevation clustering — see
 *     `assignSessionStories`).
 *  2. Bring every session into ONE shared coordinate system before merging
 *     wall/door/etc coordinates, or two floors captured with different
 *     ARKit origins render on top of each other as geometric nonsense (see
 *     `alignSessions`, which only ever applies a translation + right-angle
 *     yaw, and only when it's been cross-checked against the OTHER
 *     session's wall footprint — never a blind guess).
 */

interface RPSurface {
  identifier?: string;
  story?: number;
  transform?: number[];
  dimensions?: number[];
  [key: string]: unknown;
}

interface RPSession {
  walls?: RPSurface[];
  doors?: RPSurface[];
  windows?: RPSurface[];
  openings?: RPSurface[];
  objects?: RPSurface[];
  floors?: RPSurface[];
  sections?: { center?: number[]; story?: number; [key: string]: unknown }[];
  referenceOriginTransform?: number[];
  story?: number;
  [key: string]: unknown;
}

/** True only for the nested `{ captureSessions: [{ roomplanSessions: [...] }] }` export shape. */
export function isMultiSessionCapture(data: unknown): data is { captureSessions: { roomplanSessions: RPSession[] }[] } {
  const d = data as { captureSessions?: unknown };
  return !!d && Array.isArray(d.captureSessions) && d.captureSessions.length > 0 &&
    d.captureSessions.every(cs => cs && Array.isArray((cs as { roomplanSessions?: unknown }).roomplanSessions));
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/** Median floor-surface Y (ARKit up axis), falling back to the lowest wall
 *  bottom when a session has no floor surfaces. Same convention as our
 *  ArchiDrawing web importer (roomplan-core.js's floorElevation). */
function sessionElevation(session: RPSession): number | null {
  const floorYs = (session.floors ?? [])
    .map(f => f.transform?.[13])
    .filter((y): y is number => typeof y === 'number' && Number.isFinite(y));
  if (floorYs.length > 0) return median(floorYs);
  const wallBottoms = (session.walls ?? [])
    .map(w => (w.transform && w.dimensions) ? w.transform[13] - w.dimensions[1] / 2 : null)
    .filter((y): y is number => typeof y === 'number' && Number.isFinite(y));
  return wallBottoms.length > 0 ? median(wallBottoms) : null;
}

const STORY_ELEVATION_TOLERANCE_M = 0.8;

/**
 * A per-session story index, one entry per `roomplanSessions[]` item, in the
 * same order. Uses each session's own `story` field when those values
 * genuinely differ across sessions; otherwise clusters sessions by their
 * median floor elevation (0.8m tolerance — a session more than that above
 * the previous cluster's mean starts a new floor).
 */
export function assignSessionStories(sessions: RPSession[]): number[] {
  if (sessions.length <= 1) return sessions.map(() => 0);
  const sourceStories = sessions.map(s => (typeof s.story === 'number' ? s.story : null));
  if (sourceStories.every(v => v !== null) && new Set(sourceStories).size > 1) {
    return sourceStories as number[];
  }
  const elevations = sessions.map(sessionElevation);
  if (!elevations.every(e => e !== null)) return sessions.map(() => 0);
  const withIndex = (elevations as number[]).map((e, i): [number, number] => [i, e]);
  withIndex.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const stories = new Array(sessions.length).fill(0);
  let story = 0;
  let clusterValues = [withIndex[0][1]];
  stories[withIndex[0][0]] = 0;
  for (let k = 1; k < withIndex.length; k++) {
    const [idx, elevation] = withIndex[k];
    const clusterMean = clusterValues.reduce((a, b) => a + b, 0) / clusterValues.length;
    if (elevation - clusterMean > STORY_ELEVATION_TOLERANCE_M) { story += 1; clusterValues = [elevation]; }
    else clusterValues.push(elevation);
    stories[idx] = story;
  }
  return stories;
}

function transformsEqual(a?: number[], b?: number[], tol = 1e-4): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== 16 || b.length !== 16) return false;
  return a.every((v, i) => Math.abs(v - b[i]) <= tol);
}

function rotateXZ(x: number, z: number, cos: number, sin: number): [number, number] {
  return [x * cos - z * sin, x * sin + z * cos];
}

function wallCenterlinePoints(session: RPSession): [number, number][] {
  return (session.walls ?? [])
    .filter(w => Array.isArray(w.transform) && w.transform.length === 16)
    .map(w => [w.transform![12], w.transform![14]]);
}

const OVERLAP_CELL_M = 0.3;
const OVERLAP_BAND_M = 0.25;
const MIN_ACCEPT_OVERLAP = 0.35;

/** Wall-footprint intersection-over-union on a shared raster grid — same
 *  cross-check used by ArchiDrawing's story-alignment.js, chosen there after
 *  an axis-aligned bounding-box check was found to accept a genuinely wrong
 *  alignment (a rotated shape's bbox stays "overlapping" regardless of
 *  rotation). Only a real footprint match is trusted. */
function footprintOverlapIoU(a: [number, number][], b: [number, number][]): number {
  if (!a.length || !b.length) return 0;
  const all = a.concat(b);
  const xs = all.map(p => p[0]), zs = all.map(p => p[1]);
  const pad = OVERLAP_BAND_M * 2;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minZ = Math.min(...zs) - pad, maxZ = Math.max(...zs) + pad;
  const gw = Math.max(1, Math.ceil((maxX - minX) / OVERLAP_CELL_M));
  const gh = Math.max(1, Math.ceil((maxZ - minZ) / OVERLAP_CELL_M));
  if (gw * gh > 200000) return 0;
  const markA = new Uint8Array(gw * gh), markB = new Uint8Array(gw * gh);
  const mark = (grid: Uint8Array, pts: [number, number][]) => {
    for (const [x, z] of pts) {
      const cx0 = Math.max(0, Math.floor((x - OVERLAP_BAND_M - minX) / OVERLAP_CELL_M));
      const cx1 = Math.min(gw - 1, Math.floor((x + OVERLAP_BAND_M - minX) / OVERLAP_CELL_M));
      const cz0 = Math.max(0, Math.floor((z - OVERLAP_BAND_M - minZ) / OVERLAP_CELL_M));
      const cz1 = Math.min(gh - 1, Math.floor((z + OVERLAP_BAND_M - minZ) / OVERLAP_CELL_M));
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) grid[cz * gw + cx] = 1;
    }
  };
  mark(markA, a); mark(markB, b);
  let both = 0, either = 0;
  for (let i = 0; i < gw * gh; i++) { if (markA[i] && markB[i]) both++; if (markA[i] || markB[i]) either++; }
  return either > 0 ? both / either : 0;
}

function dominantWallAngle(session: RPSession): number | null {
  let cosSum = 0, sinSum = 0, total = 0;
  for (const w of session.walls ?? []) {
    if (!Array.isArray(w.transform) || w.transform.length !== 16) continue;
    const length = w.dimensions?.[0];
    if (typeof length !== 'number' || !(length > 0)) continue;
    const angle = Math.atan2(-w.transform[2], w.transform[0]);
    cosSum += length * Math.cos(4 * angle);
    sinSum += length * Math.sin(4 * angle);
    total += length;
  }
  if (total <= 0 || Math.hypot(cosSum, sinSum) <= 1e-9) return null;
  return Math.atan2(sinSum, cosSum) / 4;
}

/**
 * A translation + right-angle yaw to bring `session` onto `reference`'s
 * coordinate system, or null when there isn't enough evidence to trust one.
 * Deliberately conservative (ported from ArchiDrawing's story-alignment.js,
 * see that file for the full reasoning and the failure modes it was tuned
 * against): tries a coarse-then-fine translation search seeded near each
 * session's centroid, at all 4 right-angle candidates around the two
 * sessions' relative wall-grid angle, and accepts only the candidate whose
 * wall footprints actually overlap (IoU) above MIN_ACCEPT_OVERLAP. Returns
 * null rather than a low-confidence guess — a rejected alignment is safer
 * than a wrong one for a tool whose numbers feed real measurements.
 */
function alignSessionToReference(session: RPSession, reference: RPSession): { dx: number; dz: number; yawRad: number } | null {
  const refAngle = dominantWallAngle(reference);
  const thisAngle = dominantWallAngle(session);
  if (refAngle == null || thisAngle == null) return null;
  const baseYaw = refAngle - thisAngle;

  const refPts = wallCenterlinePoints(reference);
  const thisPts = wallCenterlinePoints(session);
  if (!refPts.length || !thisPts.length) return null;

  const centroid = (pts: [number, number][]): [number, number] =>
    [pts.reduce((a, p) => a + p[0], 0) / pts.length, pts.reduce((a, p) => a + p[1], 0) / pts.length];
  const [refCx, refCz] = centroid(refPts);
  const [thisCx, thisCz] = centroid(thisPts);

  let best: { dx: number; dz: number; yawRad: number; overlap: number } | null = null;
  for (let k = 0; k < 4; k++) {
    const yawRad = baseYaw + k * (Math.PI / 2);
    const cos = Math.cos(yawRad), sin = Math.sin(yawRad);
    const [rcx, rcz] = rotateXZ(thisCx, thisCz, cos, sin);
    const dx0 = refCx - rcx, dz0 = refCz - rcz;
    let local: { dx: number; dz: number; overlap: number } | null = null;
    for (const [step, radius] of [[0.5, 2.0], [0.1, 0.6]] as const) {
      const cx: number = local ? local.dx : dx0;
      const cz: number = local ? local.dz : dz0;
      for (let ddx = -radius; ddx <= radius + 1e-9; ddx += step) {
        for (let ddz = -radius; ddz <= radius + 1e-9; ddz += step) {
          const dx = cx + ddx, dz = cz + ddz;
          const transformed = thisPts.map(([x, z]): [number, number] => { const [rx, rz] = rotateXZ(x, z, cos, sin); return [rx + dx, rz + dz]; });
          const overlap = footprintOverlapIoU(refPts, transformed);
          if (!local || overlap > local.overlap) local = { dx, dz, overlap };
        }
      }
    }
    if (local && (!best || local.overlap > best.overlap)) best = { yawRad, dx: local.dx, dz: local.dz, overlap: local.overlap };
  }
  return best && best.overlap >= MIN_ACCEPT_OVERLAP ? { dx: best.dx, dz: best.dz, yawRad: best.yawRad } : null;
}

function applyTransformToSession(session: RPSession, dx: number, dz: number, yawRad: number): RPSession {
  const cos = Math.cos(yawRad), sin = Math.sin(yawRad);
  const transformItem = (item: RPSurface): RPSurface => {
    if (!Array.isArray(item.transform) || item.transform.length !== 16) return item;
    const t = [...item.transform];
    // Rotate the X and Z basis columns (offsets 0 and 8) and the position (offset 12/14).
    for (const col of [0, 8]) {
      const x = t[col], z = t[col + 2];
      t[col] = x * cos - z * sin;
      t[col + 2] = x * sin + z * cos;
    }
    const px = t[12], pz = t[14];
    t[12] = px * cos - pz * sin + dx;
    t[14] = px * sin + pz * cos + dz;
    return { ...item, transform: t };
  };
  const transformSection = (s: { center?: number[]; [key: string]: unknown }) => {
    if (!Array.isArray(s.center) || s.center.length < 3) return s;
    const [rx, rz] = rotateXZ(s.center[0], s.center[2], cos, sin);
    return { ...s, center: [rx + dx, s.center[1], rz + dz] };
  };
  return {
    ...session,
    walls: (session.walls ?? []).map(transformItem),
    doors: (session.doors ?? []).map(transformItem),
    windows: (session.windows ?? []).map(transformItem),
    openings: (session.openings ?? []).map(transformItem),
    objects: (session.objects ?? []).map(transformItem),
    floors: (session.floors ?? []).map(transformItem),
    sections: (session.sections ?? []).map(transformSection),
  };
}

export interface FlattenResult {
  data: Record<string, unknown>;
  /** One entry per session that needed alignment (skipped when every
   *  session already shares an origin) — surfaced so the UI can tell the
   *  user what happened, same spirit as ArchiDrawing's storyAlignment
   *  warnings. Empty when nothing needed aligning. */
  notes: string[];
}

/**
 * Flatten a `{ captureSessions: [{ roomplanSessions: [...] }] }` capture
 * into the single flat object `importRoomPlanFloors` already understands.
 * Call this BEFORE `isRoomPlanJson`/`validateRoomPlan`/`createProjectFromRoomPlan`
 * — it produces exactly their expected shape, so nothing downstream changes.
 */
export function flattenMultiSessionCapture(raw: { captureSessions: { roomplanSessions: RPSession[] }[] }): FlattenResult {
  const sessions = raw.captureSessions.flatMap(cs => cs.roomplanSessions);
  const notes: string[] = [];

  if (sessions.length === 0) return { data: {}, notes };
  if (sessions.length === 1) {
    const [only] = sessions;
    return { data: { ...only, story: 0 }, notes };
  }

  const storyIndices = assignSessionStories(sessions);
  if (new Set(storyIndices).size === sessions.length && sessions.every(s => typeof s.story !== 'number')) {
    // no source story hints and elevation didn't cluster anything together —
    // still fine, each session just becomes its own floor in capture order
  }

  // Group sessions by assigned story so origin-sharing / alignment is only
  // ever compared WITHIN a floor's own session(s) — sessions on different
  // floors have no reason to share a coordinate system in the first place.
  const byStory = new Map<number, number[]>(); // story -> session indices
  storyIndices.forEach((story, i) => {
    if (!byStory.has(story)) byStory.set(story, []);
    byStory.get(story)!.push(i);
  });

  const alignedSessions: RPSession[] = sessions.map(s => s);
  for (const [story, indices] of byStory) {
    if (indices.length <= 1) continue;
    const reference = sessions[indices[0]];
    for (const i of indices.slice(1)) {
      const candidate = sessions[i];
      if (transformsEqual(reference.referenceOriginTransform, candidate.referenceOriginTransform)) {
        notes.push(`Story ${story}: sessions already share one coordinate system, no alignment needed.`);
        continue;
      }
      const transform = alignSessionToReference(candidate, reference);
      if (!transform) {
        notes.push(`Story ${story}: could not confidently align an extra session to the rest of this floor (kept its own coordinates — walls from this session may not line up).`);
        continue;
      }
      alignedSessions[i] = applyTransformToSession(candidate, transform.dx, transform.dz, transform.yawRad);
      notes.push(`Story ${story}: aligned an extra session onto this floor's coordinate system.`);
    }
  }

  const withStory = alignedSessions.map((s, i) => ({ ...s, story: storyIndices[i] }));
  // Each element's OWN story field is overwritten with its session's
  // assigned index (not just filled in when absent): a raw RoomPlan export
  // stamps story: 0 on every element by default, even genuinely-upper-floor
  // ones, since the capturing app has no cross-session floor concept — that
  // stale 0 would otherwise win over the real per-session index computed
  // above via assignSessionStories() (elevation clustering).
  const merge = (key: 'walls' | 'doors' | 'windows' | 'openings' | 'objects' | 'floors' | 'sections') =>
    withStory.flatMap(s => (s[key] ?? []).map((item: any) => ({ ...item, story: s.story })));

  return {
    data: {
      walls: merge('walls'),
      doors: merge('doors'),
      windows: merge('windows'),
      openings: merge('openings'),
      objects: merge('objects'),
      floors: merge('floors'),
      sections: merge('sections'),
      stories: [...new Set(storyIndices)].sort((a, b) => a - b).map(index => ({ index, name: index === 0 ? 'Ground Floor' : `Floor ${index}` })),
    },
    notes,
  };
}
