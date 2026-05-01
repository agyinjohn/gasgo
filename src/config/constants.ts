export const CONSTANTS = {
  // Cylinder sizes in kg
  CYLINDER_SIZES: [3, 6, 12] as const,

  // Order types
  ORDER_TYPES: ['fill', 'delivery', 'exchange'] as const,

  // Order statuses
  ORDER_STATUS: {
    PENDING: 'pending',
    ACCEPTED: 'accepted',
    AT_STATION: 'at_station',
    EN_ROUTE: 'en_route',
    DELIVERED: 'delivered',
    CANCELLED: 'cancelled',
  } as const,

  // Rider statuses
  RIDER_STATUS: {
    OFFLINE: 'offline',
    AVAILABLE: 'available',
    BUSY: 'busy',
    ON_BREAK: 'on_break',
  } as const,

  // Station statuses
  STATION_STATUS: {
    PENDING: 'pending',
    ACTIVE: 'active',
    SUSPENDED: 'suspended',
    BANNED: 'banned',
  } as const,

  // Dispatch
  DISPATCH_RADIUS_KM: parseInt(process.env.DEFAULT_DISPATCH_RADIUS_KM || '5'),
  DISCOVERY_RADIUS_KM: parseInt(process.env.DEFAULT_DISCOVERY_RADIUS_KM || '10'),
  MAX_DISCOVERY_RADIUS_KM: parseInt(process.env.MAX_DISCOVERY_RADIUS_KM || '25'),
  ORDER_ACCEPT_TIMEOUT_MS: parseInt(process.env.ORDER_ACCEPT_TIMEOUT_SECONDS || '60') * 1000,
  MAX_DISPATCH_ATTEMPTS: parseInt(process.env.MAX_DISPATCH_ATTEMPTS || '3'),

  // OTP
  OTP_LENGTH: 4,
  OTP_EXPIRES_MINUTES: 30,
  OTP_MAX_ATTEMPTS: 3,

  // Platform
  PLATFORM_COMMISSION_PCT: parseFloat(process.env.PLATFORM_COMMISSION_PCT || '10'),

  // GPS tracking interval (ms)
  GPS_INTERVAL_MS: 12000, // 12 seconds
} as const;

export type CylinderSize = (typeof CONSTANTS.CYLINDER_SIZES)[number];
export type OrderType = (typeof CONSTANTS.ORDER_TYPES)[number];
export type OrderStatus = (typeof CONSTANTS.ORDER_STATUS)[keyof typeof CONSTANTS.ORDER_STATUS];
export type RiderStatus = (typeof CONSTANTS.RIDER_STATUS)[keyof typeof CONSTANTS.RIDER_STATUS];
export type StationStatus = (typeof CONSTANTS.STATION_STATUS)[keyof typeof CONSTANTS.STATION_STATUS];
