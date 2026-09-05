/**
 * Pure map geometry: equirectangular projection over the mainland China
 * bounding box plus SVG path-string generation from GeoJSON rings. No React,
 * no DOM — unit-testable in the node lane.
 */

/** Bounding box in degrees over which the projection is fitted. */
export interface GeoBounds {
  readonly minLon: number
  readonly maxLon: number
  readonly minLat: number
  readonly maxLat: number
}

/** Lon/lat in decimal degrees. */
export interface LonLat {
  readonly lon: number
  readonly lat: number
}

/** Fixed projection window; the viewBox equals this size. */
export const MAP_WIDTH = 1000
export const MAP_HEIGHT = 760

/**
 * China mainland bounding box (roughly lon 73–135, lat 18–54). The South
 * China Sea inset (九段线) feature of the source GeoJSON is dropped from the
 * dataset, so the box intentionally covers the mainland only.
 */
export const CHINA_BOUNDS: GeoBounds = { minLon: 73, maxLon: 135, minLat: 18, maxLat: 54 }

/** Aspect-corrected equirectangular projection of a lon/lat point. */
export function projectPoint(point: LonLat, bounds: GeoBounds = CHINA_BOUNDS): LonLat {
  const spanLon = bounds.maxLon - bounds.minLon
  const spanLat = bounds.maxLat - bounds.minLat
  // Aspect correction: longitude degrees shrink with latitude (cos of mid-lat).
  const midLat = (bounds.minLat + bounds.maxLat) / 2
  const cosMid = Math.cos((midLat * Math.PI) / 180)
  const x = ((point.lon - bounds.minLon) / spanLon) * MAP_WIDTH * cosMid
  const y = ((bounds.maxLat - point.lat) / spanLat) * MAP_HEIGHT
  // Center the corrected width horizontally within the window.
  const correctedWidth = MAP_WIDTH * cosMid
  const offset = (MAP_WIDTH - correctedWidth) / 2
  return { lon: x + offset, lat: y }
}

/**
 * Build the SVG path `d` string for one ring (closed linear ring of
 * [lon, lat] pairs).
 * @param ring - closed ring; the final point may repeat the first.
 * @returns path data, or '' for an empty ring.
 */
export function ringPath(ring: readonly (readonly [number, number])[]): string {
  if (ring.length === 0) return ''
  const parts: string[] = []
  for (const [lon, lat] of ring) {
    const p = projectPoint({ lon, lat })
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${p.lon.toFixed(1)},${p.lat.toFixed(1)}`)
  }
  parts.push('Z')
  return parts.join(' ')
}

/**
 * Build the SVG path `d` string for a GeoJSON geometry of type Polygon or
 * MultiPolygon (the only two types in the province dataset).
 * @param geometry - polygon rings or an array of polygon ring arrays.
 * @returns concatenated path data, or '' for an unknown/empty geometry.
 */
export function geometryPath(
  geometry: { readonly type: string; readonly coordinates: unknown },
): string {
  if (geometry.type === 'Polygon') {
    return polygonPath(geometry.coordinates as readonly (readonly (readonly [number, number])[])[])
  }
  if (geometry.type === 'MultiPolygon') {
    const polys = geometry.coordinates as readonly (readonly (readonly (readonly [number, number])[])[])[]
    return polys.map(polygonPath).join(' ')
  }
  return ''
}

/** Path data for one polygon (an array of rings; holes drawn after the shell). */
function polygonPath(rings: readonly (readonly (readonly [number, number])[])[]): string {
  return rings.map(ringPath).join(' ')
}
