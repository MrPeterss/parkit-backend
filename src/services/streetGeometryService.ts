import type { Prisma } from '@prisma/client';

import { prisma } from '../prisma.js';
import { BadRequestError, ServiceUnavailableError } from '../utils/AppError.js';

/** LocationIQ Nominatim-compatible search (US region default; set LOCATIONIQ_BASE_URL for eu1). */
const DEFAULT_LOCATIONIQ_SEARCH_URL = 'https://us1.locationiq.com/v1/search';

/** Minimum delay between LocationIQ requests (same process). */
const MIN_INTERVAL_MS = (() => {
  const raw =
    process.env.LOCATIONIQ_MIN_INTERVAL_MS ??
    process.env.GEOAPIFY_MIN_INTERVAL_MS ??
    process.env.OSM_OVERPASS_MIN_INTERVAL_MS;
  const n = raw ? Number.parseInt(raw, 10) : 3000;
  return Number.isFinite(n) && n >= 0 ? n : 3000;
})();

/** Default free-text context for `q=` (tickets are City of Ithaca, NY). */
const DEFAULT_GEOCODE_CITY = 'Ithaca';
const DEFAULT_GEOCODE_STATE = 'New York';
const DEFAULT_GEOCODE_COUNTRY = 'USA';

export type StreetGeometryPoint = { lat: number; lon: number };

/** One polyline segment (OSM may split a road into multiple ways). */
export type StreetGeometrySegment = {
  /** OSM object id when present; otherwise synthetic. */
  wayId: number;
  tags: Record<string, string>;
  geometry: StreetGeometryPoint[];
};

export type StreetGeometryResponse = {
  street: string;
  segments: StreetGeometrySegment[];
  /** True when no line geometry was returned for this street search. */
  osmNotFound: boolean;
  fetchedAt: string;
};

type LonLat = [number, number];

type GeoJsonGeometry = {
  type?: string;
  coordinates?: unknown;
};

type GeoJsonFeatureCollection = {
  type?: string;
  features?: Array<{
    type?: string;
    properties?: Record<string, unknown>;
    geometry?: GeoJsonGeometry;
  }>;
};

let lastRequestAt = 0;
let queue: Promise<unknown> = Promise.resolve();

function enqueueLocationIq<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(() => runWithThrottle(fn));
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function runWithThrottle<T>(fn: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const wait = Math.max(0, MIN_INTERVAL_MS - (now - lastRequestAt));
  if (wait > 0) {
    await new Promise<void>((resolve) => setTimeout(resolve, wait));
  }
  lastRequestAt = Date.now();
  return fn();
}

function getLocationIqAccessToken(): string {
  const key =
    process.env.LOCATIONIQ_ACCESS_TOKEN?.trim() ??
    process.env.LOCATIONIQ_API_KEY?.trim();
  if (!key) {
    throw new ServiceUnavailableError(
      'Street geometry is not configured (set LOCATIONIQ_ACCESS_TOKEN).',
    );
  }
  return key;
}

function buildSearchQuery(streetName: string): string {
  const city =
    process.env.LOCATIONIQ_GEOCODE_CITY?.trim() ?? DEFAULT_GEOCODE_CITY;
  const state =
    process.env.LOCATIONIQ_STATE?.trim() ?? DEFAULT_GEOCODE_STATE;
  const country =
    process.env.LOCATIONIQ_COUNTRY?.trim() ?? DEFAULT_GEOCODE_COUNTRY;
  return `${streetName.trim()}, ${city}, ${state}, ${country}`;
}

function buildLocationIqSearchUrlForStreet(streetName: string): string {
  const key = getLocationIqAccessToken();
  const base =
    process.env.LOCATIONIQ_BASE_URL?.trim() ?? DEFAULT_LOCATIONIQ_SEARCH_URL;
  const params = new URLSearchParams({
    key,
    q: buildSearchQuery(streetName),
    format: 'json',
    addressdetails: '1',
    polygon_geojson: '1',
    limit: process.env.LOCATIONIQ_LIMIT?.trim() ?? '8',
  });
  const countrycodes = process.env.LOCATIONIQ_COUNTRYCODES?.trim();
  if (countrycodes) {
    params.set('countrycodes', countrycodes);
  }
  const dedupe = process.env.LOCATIONIQ_DEDUPE?.trim();
  if (dedupe) {
    params.set('dedupe', dedupe);
  }
  return `${base}?${params.toString()}`;
}

function propsToStringRecord(
  props: Record<string, unknown> | undefined,
): Record<string, string> {
  if (!props) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'object') {
      try {
        out[k] = JSON.stringify(v);
      } catch {
        out[k] = String(v);
      }
    } else {
      out[k] = typeof v === 'string' ? v : String(v);
    }
  }
  return out;
}

function coordinatesToPoints(coords: LonLat[]): StreetGeometryPoint[] {
  return coords.map(([lon, lat]) => ({ lat, lon }));
}

function geometryToSegments(
  geom: GeoJsonGeometry | undefined,
  props: Record<string, string>,
  allocateWayId: () => number,
): StreetGeometrySegment[] {
  const segments: StreetGeometrySegment[] = [];
  if (!geom?.type) return segments;

  if (geom.type === 'LineString') {
    const coords = geom.coordinates as LonLat[] | undefined;
    if (!coords?.length) return segments;
    segments.push({
      wayId: allocateWayId(),
      tags: props,
      geometry: coordinatesToPoints(coords),
    });
    return segments;
  }

  if (geom.type === 'MultiLineString') {
    const multi = geom.coordinates as LonLat[][] | undefined;
    if (!multi?.length) return segments;
    for (const line of multi) {
      if (!line?.length) continue;
      segments.push({
        wayId: allocateWayId(),
        tags: props,
        geometry: coordinatesToPoints(line),
      });
    }
    return segments;
  }

  return segments;
}

/** Nominatim JSON: array of places, each may include `geojson` when polygon_geojson=1. */
function nominatimJsonToSegments(results: unknown[]): StreetGeometrySegment[] {
  const segments: StreetGeometrySegment[] = [];
  let synthetic = 0;

  for (const item of results) {
    if (typeof item !== 'object' || item === null) continue;
    const row = item as Record<string, unknown>;
    const geojson = row.geojson as GeoJsonGeometry | undefined;
    const props = propsToStringRecord(row);

    let baseWayId: number | undefined;
    const rawId = row.osm_id;
    if (typeof rawId === 'number' && Number.isFinite(rawId)) baseWayId = rawId;
    else if (typeof rawId === 'string') {
      const n = Number.parseInt(rawId, 10);
      if (Number.isFinite(n)) baseWayId = n;
    }

    let part = 0;
    const allocateWayId = (): number => {
      if (baseWayId !== undefined && part === 0) {
        part++;
        return baseWayId;
      }
      return synthetic++;
    };

    segments.push(...geometryToSegments(geojson, props, allocateWayId));
  }
  return segments;
}

function featureCollectionToSegments(fc: GeoJsonFeatureCollection): StreetGeometrySegment[] {
  const segments: StreetGeometrySegment[] = [];
  let synthetic = 0;
  for (const feature of fc.features ?? []) {
    const geom = feature.geometry;
    const props = propsToStringRecord(feature.properties);
    const allocateWayId = (): number => synthetic++;
    segments.push(...geometryToSegments(geom, props, allocateWayId));
  }
  return segments;
}

function normalizeLocationIqResponse(data: unknown): StreetGeometrySegment[] {
  if (typeof data === 'object' && data !== null && 'error' in data) {
    const err = (data as { error?: unknown }).error;
    throw new ServiceUnavailableError(
      `LocationIQ: ${typeof err === 'string' ? err : JSON.stringify(err)}`,
    );
  }

  if (
    typeof data === 'object' &&
    data !== null &&
    (data as { type?: string }).type === 'FeatureCollection' &&
    Array.isArray((data as GeoJsonFeatureCollection).features)
  ) {
    return featureCollectionToSegments(data as GeoJsonFeatureCollection);
  }

  if (Array.isArray(data)) {
    return nominatimJsonToSegments(data);
  }

  throw new ServiceUnavailableError(
    'LocationIQ returned an unexpected response shape',
  );
}

async function fetchSegmentsFromLocationIq(
  streetName: string,
): Promise<StreetGeometrySegment[]> {
  const url = buildLocationIqSearchUrlForStreet(streetName);
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        'User-Agent': process.env.LOCATIONIQ_USER_AGENT?.trim() ?? 'ParkItBackend/1.0',
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new ServiceUnavailableError(`LocationIQ request failed: ${message}`);
  }

  if (res.status === 429) {
    throw new ServiceUnavailableError('LocationIQ rate-limited; try again later.');
  }
  if (!res.ok) {
    throw new ServiceUnavailableError(`LocationIQ returned HTTP ${res.status}`);
  }

  const text = await res.text();
  if (text.trimStart().startsWith('<')) {
    throw new ServiceUnavailableError(
      'LocationIQ returned a non-JSON response; try again later.',
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text) as unknown;
  } catch {
    throw new ServiceUnavailableError('LocationIQ returned invalid JSON');
  }

  return normalizeLocationIqResponse(data);
}

export async function fetchAndStoreStreetGeometry(
  canonicalStreet: string,
): Promise<StreetGeometrySegment[]> {
  const segments = await fetchSegmentsFromLocationIq(canonicalStreet);
  const notFound = segments.length === 0;
  const jsonSegments = segments as unknown as Prisma.InputJsonValue;

  await prisma.streetGeometry.upsert({
    where: { streetLocation: canonicalStreet },
    create: {
      streetLocation: canonicalStreet,
      segments: jsonSegments,
      notFound,
    },
    update: {
      segments: jsonSegments,
      notFound,
    },
  });

  return segments;
}

/**
 * If `streetLocation` is missing or already stored (including “no line” result), no-ops.
 * Otherwise fetches from LocationIQ (throttled) and upserts `StreetGeometry`.
 */
export async function ensureStreetGeometryStored(
  streetLocation: string | null | undefined,
): Promise<void> {
  const key = streetLocation?.trim();
  if (!key) return;

  const existing = await prisma.streetGeometry.findUnique({
    where: { streetLocation: key },
    select: { streetLocation: true },
  });
  if (existing) return;

  try {
    getLocationIqAccessToken();
  } catch (e) {
    console.warn(
      '[streetGeometry] Skipping fetch — LOCATIONIQ_ACCESS_TOKEN is not set:',
      e instanceof Error ? e.message : e,
    );
    return;
  }

  try {
    await fetchAndStoreStreetGeometry(key);
  } catch (e) {
    console.error(`[streetGeometry] Failed to fetch geometry for "${key}":`, e);
  }
}

/** Distinct ticket streets that do not yet have a `StreetGeometry` row. */
export async function listTicketStreetsMissingGeometry(): Promise<string[]> {
  const rows = await prisma.$queryRaw<Array<{ streetLocation: string }>>`
    SELECT DISTINCT t.streetLocation AS streetLocation
    FROM Ticket t
    WHERE t.streetLocation IS NOT NULL
      AND TRIM(t.streetLocation) != ''
      AND NOT EXISTS (
        SELECT 1 FROM StreetGeometry s WHERE s.streetLocation = t.streetLocation
      )
  `;
  return rows.map((r) => r.streetLocation);
}

/**
 * Sequentially fills missing geometries with pauses between LocationIQ calls.
 * Safe to call on startup; failures are logged and skipped.
 */
export async function backfillMissingStreetGeometriesOnStartup(): Promise<void> {
  const hasKey =
    process.env.LOCATIONIQ_ACCESS_TOKEN?.trim() ||
    process.env.LOCATIONIQ_API_KEY?.trim();
  if (!hasKey) {
    console.warn(
      '[streetGeometry] Backfill skipped — set LOCATIONIQ_ACCESS_TOKEN to fetch street geometry (Nominatim via LocationIQ).',
    );
    return;
  }

  const streets = await listTicketStreetsMissingGeometry();
  if (streets.length === 0) {
    console.log('[streetGeometry] No ticket streets need geometry backfill');
    return;
  }
  console.log(
    `[streetGeometry] Backfilling geometry for ${streets.length} street(s) (${MIN_INTERVAL_MS}ms min interval)`,
  );
  for (const street of streets) {
    await ensureStreetGeometryStored(street);
  }
  console.log('[streetGeometry] Backfill pass finished');
}

/**
 * Match ticket `streetLocation` the same way as street insights: exact, else latest `contains`.
 * Expects an already URL-decoded string.
 */
export async function resolveCanonicalStreetFromTickets(
  streetName: string,
): Promise<string | null> {
  const q = streetName.trim();
  if (!q) return null;

  const exact = await prisma.ticket.findFirst({
    where: { streetLocation: q },
    select: { streetLocation: true },
  });
  if (exact?.streetLocation) return exact.streetLocation;

  const fuzzy = await prisma.ticket.findFirst({
    where: { streetLocation: { contains: q } },
    orderBy: { timestamp: 'desc' },
    select: { streetLocation: true },
  });
  return fuzzy?.streetLocation ?? null;
}

function safeDecodeURIComponent(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export async function getStreetGeometryResponse(
  streetParam: string,
): Promise<StreetGeometryResponse> {
  const decoded = safeDecodeURIComponent(streetParam).trim();
  if (!decoded) {
    throw new BadRequestError('Street name is required');
  }

  const canonical =
    (await resolveCanonicalStreetFromTickets(decoded)) ?? decoded;

  let row = await prisma.streetGeometry.findUnique({
    where: { streetLocation: canonical },
  });

  if (!row) {
    await enqueueLocationIq(() => fetchAndStoreStreetGeometry(canonical));
    row = await prisma.streetGeometry.findUnique({
      where: { streetLocation: canonical },
    });
  }

  if (!row) {
    throw new ServiceUnavailableError('Could not persist street geometry');
  }

  const segments = row.segments as unknown as StreetGeometrySegment[];

  return {
    street: canonical,
    segments,
    osmNotFound: row.notFound,
    fetchedAt: row.fetchedAt.toISOString(),
  };
}
