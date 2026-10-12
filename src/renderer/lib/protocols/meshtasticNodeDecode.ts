/**
 * Meshtastic node identity / position / telemetry decoding, shared by the renderer
 * (`MeshtasticProtocol.subscribe`) and the main-process background ingest
 * (`src/main/meshtastic-backend/`). Inputs are the `@meshtastic/core` device-event shapes
 * (`{ from, rxTime, data }` packets and NodeDB `NodeInfo`).
 *
 * Node-safe on purpose: no stores, DOM, or `window.electronAPI`.
 */
import { meshtasticHwModelName } from '../hardwareModels';
import { meshtasticPacketRxTimeMs } from '../meshtasticLastHeard';
import { isFiniteNumber, normalizedNodeNum } from './meshtasticTextDecode';
import type { DomainEvent } from './Protocol';

export const MAX_LATITUDE = 90;
export const MAX_LONGITUDE = 180;

/** Scaled 1e-7 lat/lon: finite + range-checked, else undefined (mirrors decodePosition). */
function boundedLatLonFromScaledI(
  latitudeI: number | undefined,
  longitudeI: number | undefined,
): { latitude: number | undefined; longitude: number | undefined } {
  if (!isFiniteNumber(latitudeI) || !isFiniteNumber(longitudeI)) {
    return { latitude: undefined, longitude: undefined };
  }
  const latitude = latitudeI / 1e7;
  const longitude = longitudeI / 1e7;
  if (Math.abs(latitude) > MAX_LATITUDE || Math.abs(longitude) > MAX_LONGITUDE) {
    return { latitude: undefined, longitude: undefined };
  }
  return { latitude, longitude };
}

export function decodeMeshtasticUserPacket(raw: unknown): DomainEvent[] {
  const p = raw as {
    from: number;
    rxTime?: Date | number;
    data?: {
      longName?: string;
      shortName?: string;
      hwModel?: number;
      role?: number;
      publicKey?: Uint8Array;
      isLicensed?: boolean;
    };
  };
  const nodeId = normalizedNodeNum(p.from);
  if (!nodeId) return [];
  const user = p.data ?? {};
  return [
    {
      type: 'node_info',
      payload: {
        nodeId,
        longName: user.longName,
        shortName: user.shortName,
        hwModel: user.hwModel != null ? meshtasticHwModelName(user.hwModel) : undefined,
        role: user.role,
        publicKey: user.publicKey,
        isLicensed: user.isLicensed,
        lastHeardAt: meshtasticPacketRxTimeMs(p.rxTime) || Date.now(),
        fromUserPacket: true,
      },
    },
  ];
}

export function decodeMeshtasticNodeInfo(raw: unknown): DomainEvent[] {
  const p = raw as {
    num?: number;
    user?: {
      longName?: string;
      shortName?: string;
      hwModel?: number;
      role?: number;
      publicKey?: Uint8Array;
    };
    lastHeard?: number;
    snr?: number;
    hopsAway?: number;
    viaMqtt?: boolean;
    isKeyManuallyVerified?: boolean;
    hasXeddsaSigned?: boolean;
    position?: { latitudeI?: number; longitudeI?: number; altitude?: number };
    deviceMetrics?: {
      batteryLevel?: number;
      voltage?: number;
      channelUtilization?: number;
      airUtilTx?: number;
    };
  };
  const nodeId = normalizedNodeNum(p.num);
  if (!nodeId) return [];
  const { latitude, longitude } = boundedLatLonFromScaledI(
    p.position?.latitudeI,
    p.position?.longitudeI,
  );
  return [
    {
      type: 'node_info',
      payload: {
        nodeId,
        longName: p.user?.longName,
        shortName: p.user?.shortName,
        hwModel: p.user?.hwModel != null ? meshtasticHwModelName(p.user.hwModel) : undefined,
        role: p.user?.role,
        publicKey: p.user?.publicKey,
        lastHeardAt: p.lastHeard,
        snr: p.snr,
        hopsAway: p.hopsAway,
        viaMqtt: p.viaMqtt,
        keyManuallyVerified: p.isKeyManuallyVerified === true,
        hasXeddsaSigned: p.hasXeddsaSigned === true,
        latitude,
        longitude,
        altitude: p.position?.altitude,
        batteryLevel: p.deviceMetrics?.batteryLevel,
        voltage: p.deviceMetrics?.voltage,
        channelUtilization: p.deviceMetrics?.channelUtilization,
        airUtilTx: p.deviceMetrics?.airUtilTx,
      },
    },
  ];
}

export function decodeMeshtasticPosition(raw: unknown): DomainEvent[] {
  const p = raw as {
    from: number;
    rxTime?: Date | number;
    data: { latitudeI?: number; longitudeI?: number; altitude?: number };
  };
  const nodeId = normalizedNodeNum(p.from);
  if (nodeId === undefined) return [];
  const latitude = (isFiniteNumber(p.data.latitudeI) ? p.data.latitudeI : 0) / 1e7;
  const longitude = (isFiniteNumber(p.data.longitudeI) ? p.data.longitudeI : 0) / 1e7;
  if (Math.abs(latitude) > MAX_LATITUDE || Math.abs(longitude) > MAX_LONGITUDE) return [];
  return [
    {
      type: 'position',
      payload: {
        nodeId,
        latitude,
        longitude,
        altitude: isFiniteNumber(p.data.altitude) ? p.data.altitude : undefined,
        timestamp: meshtasticPacketRxTimeMs(p.rxTime) || Date.now(),
      },
    },
  ];
}

export function decodeMeshtasticTelemetry(raw: unknown): DomainEvent[] {
  const p = raw as {
    from: number;
    rxTime?: Date | number;
    data: {
      variant?: { case?: string; value?: Record<string, unknown> };
      deviceMetrics?: Record<string, unknown>;
    };
  };
  const m: Record<string, unknown> = p.data.variant?.value ?? p.data.deviceMetrics ?? {};
  const num = (key: string): number | undefined => m[key] as number | undefined;
  /** `adc_voltage_ch0`…`ch7` / `one_wire_temperature_ch0`…`ch7` collapse to a sparse array. */
  const channels = (prefix: string): (number | undefined)[] | undefined => {
    const values = Array.from({ length: 8 }, (_, ch) => num(`${prefix}Ch${ch}`));
    return values.some((v) => v !== undefined) ? values : undefined;
  };
  return [
    {
      type: 'telemetry',
      payload: {
        nodeId: p.from,
        timestamp: meshtasticPacketRxTimeMs(p.rxTime) || Date.now(),
        variantCase: p.data.variant?.case ?? (p.data.deviceMetrics ? 'deviceMetrics' : undefined),
        batteryLevel: num('batteryLevel'),
        voltage: num('voltage'),
        channelUtilization: num('channelUtilization'),
        airUtilTx: num('airUtilTx'),
        temperature: num('temperature'),
        relativeHumidity: num('relativeHumidity'),
        barometricPressure: num('barometricPressure'),
        iaq: num('iaq'),
        gasResistance: num('gasResistance'),
        lux: num('lux'),
        windSpeed: num('windSpeed'),
        windDirection: num('windDirection'),
        windGust: num('windGust'),
        windLull: num('windLull'),
        weight: num('weight'),
        rainfall1h: num('rainfall1h'),
        rainfall24h: num('rainfall24h'),
        lightningStrikeCount1h: num('lightningStrikeCount1h'),
        lightningDistanceKm: num('lightningDistanceKm'),
        adcVoltages: channels('adcVoltage'),
        // `oneWireTemperature` (tag 23) is deprecated upstream in favour of the channels.
        oneWireTemperatures: channels('oneWireTemperature'),
        pm10Standard: num('pm10Standard'),
        pm25Standard: num('pm25Standard'),
        pm40Standard: num('pm40Standard'),
        pm100Standard: num('pm100Standard'),
        co2: num('co2'),
        pmTemperature: num('pmTemperature'),
        pmHumidity: num('pmHumidity'),
        pmVocIdx: num('pmVocIdx'),
        pmNoxIdx: num('pmNoxIdx'),
        numPacketsRxBad: num('numPacketsRxBad'),
        numRxDupe: num('numRxDupe'),
        numPacketsRx: num('numPacketsRx'),
        numPacketsTx: num('numPacketsTx'),
      },
    },
  ];
}
