import { Station, IStation } from '../models/Station';

const EARTH_RADIUS_KM = 6371;

/**
 * Haversine formula — great-circle distance between two lat/lng points in km.
 */
export function haversineDistanceKm(
  lat1: number, lng1: number,
  lat2: number, lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Encode lat/lng to a geohash string.
 * Level 7 = ~150m precision cells.
 */
export function encodeGeohash(lat: number, lng: number, precision = 7): string {
  const BASE32 = '0123456789bcdefghjkmnpqrstuvwxyz';
  let minLat = -90, maxLat = 90;
  let minLng = -180, maxLng = 180;
  let geohash = '';
  let bit = 0;
  let bitsTotal = 0;
  let hashValue = 0;
  let isEven = true;

  while (geohash.length < precision) {
    if (isEven) {
      const mid = (minLng + maxLng) / 2;
      if (lng >= mid) { hashValue = (hashValue << 1) | 1; minLng = mid; }
      else { hashValue = hashValue << 1; maxLng = mid; }
    } else {
      const mid = (minLat + maxLat) / 2;
      if (lat >= mid) { hashValue = (hashValue << 1) | 1; minLat = mid; }
      else { hashValue = hashValue << 1; maxLat = mid; }
    }
    isEven = !isEven;
    if (++bit === 5) {
      geohash += BASE32[hashValue];
      bitsTotal += bit;
      bit = 0;
      hashValue = 0;
    }
  }
  return geohash;
}

export interface StationWithDistance {
  station: IStation;
  distanceKm: number;
}

export interface NearbyStationsOptions {
  lat: number;
  lng: number;
  radiusKm?: number;
  cylinderSize?: 3 | 6 | 12;
  limit?: number;
}

/**
 * Find stations within radiusKm of the user's coordinates.
 * Returns stations sorted by Haversine distance ascending.
 */
export async function getNearbyStations(
  options: NearbyStationsOptions
): Promise<StationWithDistance[]> {
  const { lat, lng, radiusKm = 10, cylinderSize, limit = 20 } = options;

  // Approximate bounding box for initial DB filter (faster than full table scan)
  const latDelta = radiusKm / 111;                         // 1° lat ≈ 111 km
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const query: Record<string, unknown> = {
    status: 'active',
    lat: { $gte: lat - latDelta, $lte: lat + latDelta },
    lng: { $gte: lng - lngDelta, $lte: lng + lngDelta },
  };

  if (cylinderSize) {
    query['cylinderListings'] = {
      $elemMatch: {
        size: cylinderSize,
        isAvailable: true,
        stockCount: { $gt: 0 },
      },
    };
  } else {
    // At least one available size
    query['cylinderListings'] = {
      $elemMatch: { isAvailable: true, stockCount: { $gt: 0 } },
    };
  }

  const candidates = await Station.find(query).limit(limit * 3).lean();

  // Precise distance filtering + sort
  const results: StationWithDistance[] = candidates
    .map((station) => ({
      station: station as unknown as IStation,
      distanceKm: haversineDistanceKm(lat, lng, station.lat, station.lng),
    }))
    .filter((r) => r.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, limit);

  return results;
}

/**
 * Find available riders within radius of a point, sorted by distance.
 */
export async function getNearbyRiders(
  lat: number,
  lng: number,
  radiusKm = 5
): Promise<Array<{ riderId: string; distanceKm: number }>> {
  const { Rider } = await import('../models/Rider');
  const latDelta = radiusKm / 111;
  const lngDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));

  const riders = await Rider.find({
    status: 'available',
    kycStatus: 'approved',
    'location.lat': { $gte: lat - latDelta, $lte: lat + latDelta },
    'location.lng': { $gte: lng - lngDelta, $lte: lng + lngDelta },
  })
    .select('_id location')
    .lean();

  return riders
    .map((r) => ({
      riderId: r._id.toString(),
      distanceKm: haversineDistanceKm(lat, lng, r.location!.lat, r.location!.lng),
    }))
    .filter((r) => r.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm);
}
