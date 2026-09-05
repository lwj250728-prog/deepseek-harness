import { describe, expect, it } from 'vitest'
import { CHINA_FEATURES } from '../src/client/china-geo.ts'
import {
  CHINA_BOUNDS, geometryPath, MAP_HEIGHT, MAP_WIDTH, projectPoint, ringPath,
} from '../src/client/geometry.ts'

describe('projectPoint', () => {
  it('maps the bounds origin to the top-left and the far corner to the bottom-right', () => {
    const topLeft = projectPoint({ lon: CHINA_BOUNDS.minLon, lat: CHINA_BOUNDS.maxLat })
    // cos of mid-lat shrinks the x span; the origin lands inside, not at 0.
    expect(topLeft.lon).toBeGreaterThanOrEqual(0)
    expect(topLeft.lon).toBeLessThan(MAP_WIDTH / 2)
    expect(topLeft.lat).toBe(0)
    const bottomRight = projectPoint({ lon: CHINA_BOUNDS.maxLon, lat: CHINA_BOUNDS.minLat })
    expect(bottomRight.lon).toBeLessThanOrEqual(MAP_WIDTH)
    expect(bottomRight.lon).toBeGreaterThan(MAP_WIDTH / 2)
    expect(bottomRight.lat).toBe(MAP_HEIGHT)
  })

  it('keeps x monotonic in longitude and y monotonic in latitude', () => {
    const west = projectPoint({ lon: 90, lat: 30 })
    const east = projectPoint({ lon: 100, lat: 30 })
    const north = projectPoint({ lon: 95, lat: 40 })
    const south = projectPoint({ lon: 95, lat: 30 })
    expect(east.lon).toBeGreaterThan(west.lon)
    expect(south.lat).toBeGreaterThan(north.lat)
  })

  it('centers the corrected width within the window', () => {
    const left = projectPoint({ lon: CHINA_BOUNDS.minLon, lat: 30 })
    const right = projectPoint({ lon: CHINA_BOUNDS.maxLon, lat: 30 })
    const span = right.lon - left.lon
    const midLon = (CHINA_BOUNDS.minLon + CHINA_BOUNDS.maxLon) / 2
    const mid = projectPoint({ lon: midLon, lat: 30 })
    expect(Math.abs(mid.lon - MAP_WIDTH / 2)).toBeLessThan(0.001)
    expect(span).toBeGreaterThan(0)
    expect(span).toBeLessThan(MAP_WIDTH)
  })
})

describe('ringPath', () => {
  it('returns an empty string for an empty ring', () => {
    expect(ringPath([])).toBe('')
  })

  it('builds a closed path starting with M and ending with Z', () => {
    const d = ringPath([[73, 54], [100, 54], [100, 40]])
    expect(d.startsWith('M')).toBe(true)
    expect(d.endsWith('Z')).toBe(true)
    expect(d.split(' ').some(part => part.startsWith('L'))).toBe(true)
  })
})

describe('geometryPath', () => {
  it('renders a Polygon from its rings', () => {
    const d = geometryPath({ type: 'Polygon', coordinates: [[[73, 54], [80, 54], [80, 50], [73, 54]]] })
    expect(d).toMatch(/^M/)
    expect(d.endsWith('Z')).toBe(true)
  })

  it('renders a MultiPolygon by joining polygon paths', () => {
    const d = geometryPath({
      type: 'MultiPolygon',
      coordinates: [
        [[[73, 54], [80, 54], [80, 50], [73, 54]]],
        [[[120, 30], [122, 30], [122, 28], [120, 30]]],
      ],
    })
    const pathCount = (d.match(/Z/g) ?? []).length
    expect(pathCount).toBe(2)
  })

  it('returns an empty string for unknown geometry types', () => {
    expect(geometryPath({ type: 'LineString', coordinates: [] })).toBe('')
  })

  it('renders real province data without throwing and with sensible bounds', () => {
    expect(CHINA_FEATURES.length).toBeGreaterThan(30)
    for (const feature of CHINA_FEATURES) {
      const d = geometryPath(feature.geometry)
      expect(d.length).toBeGreaterThan(0)
    }
  })
})
