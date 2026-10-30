import type { HrvDay, RespiratoryRateDay, SkinTempDay, SpO2Day } from '../types';
import { type CivilDate, civilDateToIso } from './civil';
import type { GoogleClient } from './client';
import { detailedRecords } from './extra';
import { inRange, isRecord, num, reconcile } from './reconcile';

const PAGE = 90; // daily metrics: 90 days is the range ceiling

type DailyPoint = { dateTime: string; v: Record<string, unknown> };

/** Extract `{dateTime, valueObject}` from reconcile dataPoints keyed by `camelKey`. */
function dailyPoints(
  dps: Array<Record<string, unknown>>,
  camelKey: string,
  start: string,
  end: string,
): DailyPoint[] {
  const out: DailyPoint[] = [];
  for (const dp of dps) {
    const v = dp[camelKey];
    if (!isRecord(v) || !isRecord(v.date)) continue;
    const dateTime = civilDateToIso(v.date as unknown as CivilDate);
    if (inRange(dateTime, start, end)) out.push({ dateTime, v });
  }
  return out.sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}

export async function getHRV(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<HrvDay[]> {
  const dps = await reconcile(client, 'daily-heart-rate-variability', PAGE);
  return dailyPoints(dps, 'dailyHeartRateVariability', start, end).map(({ dateTime, v }) => ({
    dateTime,
    value: {
      dailyRmssd: num(v.averageHeartRateVariabilityMilliseconds),
      deepRmssd: num(v.deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds),
      ...(num(v.nonRemHeartRateBeatsPerMinute) !== undefined
        ? { nonRemHeartRateBeatsPerMinute: num(v.nonRemHeartRateBeatsPerMinute) }
        : {}),
      ...(num(v.entropy) !== undefined ? { entropy: num(v.entropy) } : {}),
    },
  }));
}

export async function getSpO2(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<SpO2Day[]> {
  const dps = await reconcile(client, 'daily-oxygen-saturation', PAGE);
  return dailyPoints(dps, 'dailyOxygenSaturation', start, end).map(({ dateTime, v }) => ({
    dateTime,
    value: {
      avg: num(v.averagePercentage),
      lowerBoundPercentage: num(v.lowerBoundPercentage),
      upperBoundPercentage: num(v.upperBoundPercentage),
    },
  }));
}

export async function getRespiratoryRate(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<RespiratoryRateDay[]> {
  const dps = await reconcile(client, 'daily-respiratory-rate', PAGE);
  return dailyPoints(dps, 'dailyRespiratoryRate', start, end).map(({ dateTime, v }) => ({
    dateTime,
    value: { breathingRate: num(v.breathsPerMinute) },
  }));
}

export async function getSkinTemperature(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
  bounded = false,
): Promise<SkinTempDay[]> {
  const points = bounded
    ? (
        await detailedRecords(
          client,
          'daily-sleep-temperature-derivations',
          'dailySleepTemperatureDerivations',
          'daily',
          start,
          end,
        )
      )
        .filter((p): p is { day: string; value: Record<string, unknown> } => isRecord(p.value))
        .map((p) => ({ dateTime: p.day, v: p.value }))
        .sort((a, b) => a.dateTime.localeCompare(b.dateTime))
    : dailyPoints(
        await reconcile(client, 'daily-sleep-temperature-derivations', PAGE),
        'dailySleepTemperatureDerivations',
        start,
        end,
      );
  return points.map(({ dateTime, v }) => {
    const nightly = num(v.nightlyTemperatureCelsius);
    const baseline = num(v.baselineTemperatureCelsius);
    // v4 gives absolute °C + baseline; Fitbit's field is the nightly delta.
    const nightlyRelative =
      nightly !== undefined && baseline !== undefined
        ? Math.round((nightly - baseline) * 100) / 100
        : undefined;
    return { dateTime, value: { nightlyRelative }, logType: 'sleep' };
  });
}
