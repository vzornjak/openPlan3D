import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isRoomPlanJson, createProjectFromRoomPlan, importRoomPlanFloors } from '$lib/utils/roomplanImport';
import { isMultiSessionCapture, assignSessionStories, flattenMultiSessionCapture } from '$lib/utils/roomplanSessionFlatten';

// Real capture from a home scanned floor-by-floor (app paused/resumed between
// stories) via Apple's own RoomPlan export — the nested
// captureSessions[].roomplanSessions[] shape, NOT the flat shape every other
// fixture in this suite uses. Both sessions report story: 0 (RoomPlan's
// default), so distinguishing them relies on elevation clustering, and both
// share one referenceOriginTransform, so alignment is a no-op here — the
// harder alignment path is covered by the synthetic tests below.
const multiSession = () => JSON.parse(readFileSync(new URL('./fixtures/multi-session-real.roomplan.json', import.meta.url), 'utf8'));

describe('multi-session RoomPlan capture flattening', () => {
  it('recognises the nested captureSessions shape', () => {
    expect(isMultiSessionCapture(multiSession())).toBe(true);
    expect(isMultiSessionCapture({ walls: [] })).toBe(false);
    expect(isMultiSessionCapture(null)).toBe(false);
  });

  it('is accepted by isRoomPlanJson without needing to be flattened first', () => {
    expect(isRoomPlanJson(multiSession())).toBe(true);
  });

  it('imports both sessions as separate floors via elevation clustering when story fields do not distinguish them', () => {
    const raw = multiSession();
    const sessions = raw.captureSessions.flatMap((cs: any) => cs.roomplanSessions);
    expect(sessions.every((s: any) => s.story === 0)).toBe(true); // confirms the hard case: source story is uninformative

    const floors = importRoomPlanFloors(raw);
    expect(floors.length).toBe(2);
    expect(floors[0].level).toBe(0);
    expect(floors[1].level).toBe(1);
    // Every wall from the source capture must survive the flatten+import —
    // none silently dropped, none duplicated.
    const totalSourceWalls = sessions.reduce((n: number, s: any) => n + (s.walls?.length ?? 0), 0);
    const totalImportedWalls = floors.reduce((n, f) => n + f.walls.length, 0);
    expect(totalImportedWalls).toBe(totalSourceWalls);
  });

  it('createProjectFromRoomPlan builds a usable multi-floor project from the raw capture', () => {
    const project = createProjectFromRoomPlan(multiSession(), 'Multi-session import');
    expect(project.floors.length).toBe(2);
    expect(project.floors.every(f => f.walls.length > 0)).toBe(true);
  });

  it('assigns distinct stories when source story fields DO already distinguish sessions', () => {
    const sessions = [{ story: 0, walls: [] }, { story: 1, walls: [] }, { story: 1, walls: [] }];
    expect(assignSessionStories(sessions as any)).toEqual([0, 1, 1]);
  });

  it('clusters by floor elevation when story fields are all identical or absent', () => {
    const groundWall = { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 0, 1], dimensions: [3, 2.5, 0.1] };
    const upperWall = { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 4.1, 0, 1], dimensions: [3, 2.5, 0.1] };
    const sessions = [{ walls: [groundWall] }, { walls: [upperWall] }];
    expect(assignSessionStories(sessions as any)).toEqual([0, 1]);
  });

  it('does not invent a story split from ordinary scan noise within one floor', () => {
    const a = { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.0, 0, 1], dimensions: [3, 2.5, 0.1] };
    const b = { transform: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1.2, 0, 1], dimensions: [3, 2.5, 0.1] };
    const sessions = [{ walls: [a] }, { walls: [b] }];
    expect(assignSessionStories(sessions as any)).toEqual([0, 0]);
  });

  it('leaves already origin-sharing sessions on the same floor untouched (no spurious alignment)', () => {
    const shared = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const a = { story: 0, referenceOriginTransform: shared, walls: [{ identifier: 'a', transform: [1,0,0,0,0,1,0,0,0,0,1,0,1,1,1,1], dimensions: [3,2.5,0] }] };
    const b = { story: 0, referenceOriginTransform: shared, walls: [{ identifier: 'b', transform: [1,0,0,0,0,1,0,0,0,0,1,0,2,1,2,1], dimensions: [3,2.5,0] }] };
    const { data, notes } = flattenMultiSessionCapture({ captureSessions: [{ roomplanSessions: [a, b] }] });
    expect((data.walls as any[]).find(w => w.identifier === 'b')!.transform).toEqual(b.walls[0].transform);
    expect(notes.some(n => n.includes('already share'))).toBe(true);
  });

  it('rejects an alignment it cannot confidently verify rather than guessing (mismatched footprints)', () => {
    // Two sessions with genuinely unrelated wall layouts (an L-shape vs a
    // long corridor, at a different scale) and different origins — there is
    // no correct rigid alignment between them, so the flatten must leave
    // the second session's coordinates untouched and say so, rather than
    // silently producing a plausible-looking but wrong merge. A single-wall
    // "room" was tried first and rejected as a test case: two isolated line
    // segments always have SOME rotation+translation that overlaps them
    // perfectly, which is a correct match for that trivial geometry, not a
    // false positive — real floor plans (multiple connected walls) are what
    // the cross-check actually has to discriminate.
    const originA = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const originB = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 500, 0, 500, 1];
    const wall = (id: string, x: number, z: number, len: number, rotated: boolean) => ({
      identifier: id, dimensions: [len, 2.5, 0],
      transform: rotated
        ? [0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, x, 1, z, 1]
        : [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 1, z, 1],
    });
    // Session A: a small square room, ~3m sides.
    const a = {
      story: 0, referenceOriginTransform: originA,
      walls: [
        wall('a1', 1.5, 0, 3, false), wall('a2', 1.5, 3, 3, false),
        wall('a3', 0, 1.5, 3, true), wall('a4', 3, 1.5, 3, true),
      ],
    };
    // Session B: a long, narrow corridor, ~12m — no rigid transform maps a
    // 3x3 square onto a 1x12 corridor, so every candidate must score low.
    const b = {
      story: 0, referenceOriginTransform: originB,
      walls: [
        wall('b1', 6, 0, 12, false), wall('b2', 6, 1, 12, false),
        wall('b3', 0, 0.5, 1, true), wall('b4', 12, 0.5, 1, true),
      ],
    };
    const { data, notes } = flattenMultiSessionCapture({ captureSessions: [{ roomplanSessions: [a, b] }] });
    const bWall = (data.walls as any[]).find(w => w.identifier === 'b1')!;
    expect(bWall.transform).toEqual(b.walls[0].transform); // untouched, not force-aligned
    expect(notes.some(n => n.includes('could not confidently align'))).toBe(true);
  });
});
