# ARCHI.md — format spec (v1)

`ARCHI.md` is a compact, human- and LLM-readable summary of a floor-plan
project's current state. It is generated FROM existing data (RoomPlan
exports, `plan.json`, `planStatistics`) — never a new source of truth, never
read back into any app. Its only job: let anyone (person or agent) opening a
project understand *what it is and where it stands* in a few seconds,
without re-parsing hundreds of KB of raw geometry.

Designed to work across projects that don't share a codebase — openPlan3D,
ArchiDrawing, or any future importer — as long as each can produce the
handful of fields below from whatever internal shape it uses.

## Why this shape

- **YAML front-matter + Markdown body**: front-matter is trivially parsed by
  any tool/script (`gray-matter`, `python-frontmatter`, a 5-line regex) for
  strict fields; the Markdown body is what a human or an LLM actually reads
  first. Neither needs the other — both stay useful even if a producer only
  fills one.
- **Only the most-important numbers, not everything computed**: this is NOT
  a dump of `planStatistics`. It answers "what/how big/how many/anything
  broken" — nothing about pricing detail, per-wall thickness, exact
  coordinates. Anyone who needs those reads the full `plan.json` next; this
  file's only purpose is deciding WHETHER they need to.
- **Extension fields are namespaced and optional**: a producer can add
  anything under `extensions.<namespace>` without breaking any other
  reader. Unknown extensions must be ignored, never treated as errors.

## Front-matter fields (all producers should fill what applies)

```yaml
---
archi_md_version: 1
source: "openPlan3D"        # or "ArchiDrawing", "roomplan-raw", etc — free text, identifies the producer
project_name: "Family House — Zagreb"
generated_at: "2026-09-25T19:40:00Z"   # ISO 8601, when THIS file was generated (not project creation)
units: "metres"
floors: 2
rooms: 6
walls: 20
doors: 4
windows: 4
furniture: 13
living_area_m2: 84.5
gross_area_m2: 92.1
rooms_without_area: 0        # count of rooms with broken/open geometry — 0 means clean
warnings: []                  # short strings, e.g. multi-session alignment notes; empty when nothing to flag
extensions: {}                 # optional, namespaced, e.g. extensions.archidrawing.bimLevel: "LOD200"
---
```

Every field is optional EXCEPT `archi_md_version` and `source` — a reader
must be able to tell what wrote the file and which spec version to expect,
even from a minimal/partial producer.

## Markdown body

Free-form, but by convention:
1. `# <project name>` heading
2. One-paragraph summary line (counts + areas) — mirrors the front-matter
   for humans skimming without a YAML parser
3. Per-floor breakdown (name, rooms + areas, wall/door/window/furniture counts)
4. `## Warnings` section — only present when `warnings` is non-empty
5. `## Extensions` section — only present when a producer has extension
   content worth surfacing in prose, not just machine fields

## Compatibility rule

A NEW producer only needs to implement (front-matter + one paragraph) to be
spec-compliant — everything else is progressive enhancement. A reader must
never fail on a file missing optional sections; treat absence as "producer
didn't have that data available," not an error.

## Where the reference implementation lives

`src/lib/utils/archiMd.ts` in `vzornjak/openPlan3D` — builds this from the
same `planStatistics()` block already computed for `plan.json` export, plus
any `notes` from `roomplanSessionFlatten.ts` as `warnings`.
