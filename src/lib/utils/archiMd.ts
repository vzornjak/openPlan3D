/**
 * archiMd.ts — reference implementation of the ARCHI.md format (see
 * docs/archi-md-spec.md). Generates a compact, YAML-front-matter + Markdown
 * summary from the same planStatistics() block already computed for plan.json
 * export. Purely derived — never a new source of truth, never read back.
 */
import type { PlanStatisticsBlock } from '$lib/utils/planStatistics';

export interface ArchiMdOptions {
  projectName: string;
  generatedAtISO?: string;
  warnings?: string[];
  /** Namespaced extension data, e.g. { archidrawing: { bimLevel: 'LOD200' } }.
   *  Consumers of THIS file must ignore namespaces they don't recognise. */
  extensions?: Record<string, Record<string, unknown>>;
}

function yamlScalar(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value); // safe quoting, valid YAML
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function yamlBlock(obj: Record<string, unknown>, indent = ''): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (v.length === 0) { lines.push(`${indent}${k}: []`); continue; }
      lines.push(`${indent}${k}:`);
      for (const item of v) lines.push(`${indent}  - ${yamlScalar(item)}`);
    } else if (v !== null && typeof v === 'object') {
      const entries = Object.keys(v as object).length;
      if (entries === 0) { lines.push(`${indent}${k}: {}`); continue; }
      lines.push(`${indent}${k}:`);
      lines.push(yamlBlock(v as Record<string, unknown>, indent + '  '));
    } else {
      lines.push(`${indent}${k}: ${yamlScalar(v)}`);
    }
  }
  return lines.join('\n');
}

/** Builds the ARCHI.md text for a project, per docs/archi-md-spec.md v1. */
export function buildArchiMd(stats: PlanStatisticsBlock, opts: ArchiMdOptions): string {
  const generatedAt = opts.generatedAtISO ?? new Date().toISOString();
  const warnings = opts.warnings ?? [];
  const front: Record<string, unknown> = {
    archi_md_version: 1,
    source: 'openPlan3D',
    project_name: opts.projectName,
    generated_at: generatedAt,
    units: stats.units,
    floors: stats.levels.length,
    rooms: stats.totals.roomCount,
    walls: stats.totals.wallCount,
    doors: stats.totals.doorCount,
    windows: stats.totals.windowCount,
    furniture: stats.totals.furnitureCount,
    living_area_m2: stats.totals.livingArea,
    gross_area_m2: stats.totals.grossArea,
    rooms_without_area: stats.totals.roomsWithoutArea,
    warnings,
    extensions: opts.extensions ?? {},
  };

  const lines: string[] = ['---', yamlBlock(front), '---', ''];

  lines.push(`# ${opts.projectName}`);
  lines.push('');
  lines.push(
    `${stats.levels.length} floor(s), ${stats.totals.roomCount} room(s), ${stats.totals.wallCount} walls, ` +
    `${stats.totals.doorCount} doors, ${stats.totals.windowCount} windows, ${stats.totals.furnitureCount} furniture item(s). ` +
    `Living area ${stats.totals.livingArea} m² · Gross area ${stats.totals.grossArea} m².`
  );
  if (stats.totals.roomsWithoutArea > 0) {
    lines.push(`⚠️ ${stats.totals.roomsWithoutArea} room(s) have no enclosed area — check geometry before trusting area totals.`);
  }
  lines.push('');

  for (const level of stats.levels) {
    lines.push(`## ${level.name} (level ${level.index})`);
    const rooms = stats.rooms.filter(r => r.level === level.index);
    for (const room of rooms) {
      const area = room.floorArea != null ? `${room.floorArea} m²` : (room.floorOpening ? 'floor opening' : 'no area');
      lines.push(`- **${room.name}** — ${area}`);
    }
    lines.push(
      `  Walls: ${level.totals.wallCount} · Doors: ${level.totals.doorCount} · ` +
      `Windows: ${level.totals.windowCount} · Furniture: ${level.totals.furnitureCount}`
    );
    lines.push('');
  }

  if (warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  const extEntries = Object.entries(opts.extensions ?? {}).filter(([, v]) => Object.keys(v).length > 0);
  if (extEntries.length > 0) {
    lines.push('## Extensions');
    for (const [ns, data] of extEntries) {
      lines.push(`- **${ns}**: ${Object.entries(data).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(', ')}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
