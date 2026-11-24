export const TUYA_REGIONS = {
  us: { label: 'Stati Uniti occidentali', baseUrl: 'https://openapi.tuyaus.com' },
  'us-east': { label: 'Stati Uniti orientali', baseUrl: 'https://openapi-ueaz.tuyaus.com' },
  eu: { label: 'Europa centrale', baseUrl: 'https://openapi.tuyaeu.com' },
  'eu-west': { label: 'Europa occidentale', baseUrl: 'https://openapi-weaz.tuyaeu.com' },
  cn: { label: 'Cina', baseUrl: 'https://openapi.tuyacn.com' },
  in: { label: 'India', baseUrl: 'https://openapi.tuyain.com' },
  sg: { label: 'Singapore', baseUrl: 'https://openapi-sg.iotbing.com' },
} as const;

export type TuyaRegion = keyof typeof TUYA_REGIONS;

export interface TuyaConfiguration {
  region: TuyaRegion;
  deviceId: string;
  clientId: string;
  clientSecret: string;
  body: string;
}

export function isTuyaRegion(value: unknown): value is TuyaRegion {
  return typeof value === 'string' && Object.hasOwn(TUYA_REGIONS, value);
}

export function isTuyaConfiguration(value: unknown): value is TuyaConfiguration {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;

  const config = value as Record<string, unknown>;
  return (
    isTuyaRegion(config['region']) &&
    typeof config['deviceId'] === 'string' &&
    !!config['deviceId'].trim() &&
    typeof config['clientId'] === 'string' &&
    !!config['clientId'].trim() &&
    typeof config['clientSecret'] === 'string' &&
    !!config['clientSecret'].trim() &&
    typeof config['body'] === 'string' &&
    isJson(config['body'])
  );
}

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
