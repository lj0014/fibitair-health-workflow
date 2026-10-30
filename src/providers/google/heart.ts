import type { CardioFitness, HeartRateDay } from '../types';
import { type CivilDate, civilDateToIso } from './civil';
import type { GoogleClient } from './client';
import { inRange, isRecord, num, reconcile } from './reconcile';

const PAGE = 90;

/** Resting heart rate per day. HR zones (daily-heart-rate-zones) not yet mapped. */
export async function getHeartRateRange(
  client: Pick<GoogleClient, 'requestJson'>,
  start: string,
  end: string,
): Promise<HeartRateDay[]> {
  const dps = await reconcile(client, 'daily-resting-heart-rate', PAGE);
  const out: HeartRateDay[] = [];
  for (const dp of dps) {
    const v = dp.dailyRestingHeartRate;
    if (!isRecord(v) || !isRecord(v.date)) continue;
    const dateTime = civilDateToIso(v.date as unknown as CivilDate);
    if (!inRange(dateTime, start, end)) continue;
    const metadata = v.dailyRestingHeartRateMetadata;
    const calculationMethod =
      isRecord(metadata) && typeof metadata.calculationMethod === 'string'
        ? metadata.calculationMethod
        : undefined;
    out.push({
      dateTime,
      value: {
        restingHeartRate: num(v.beatsPerMinute),
        ...(calculationMethod !== undefined ? { calculationMethod } : {}),
      },
    });
  }
  return out.sort((a, b) => a.dateTime.localeCompare(b.dateTime));
}

/** VO2 max for a day. Field name unverified (no data on the test account). */
export async function getCardioFitness(
  client: Pick<GoogleClient, 'requestJson'>,
  date: string,
): Promise<CardioFitness> {
  const dps = await reconcile(client, 'daily-vo2-max', PAGE);
  for (const dp of dps) {
    const v = dp.dailyVo2Max;
    if (
      isRecord(v) &&
      isRecord(v.date) &&
      civilDateToIso(v.date as unknown as CivilDate) === date
    ) {
      const vo2 = num(v.vo2Max) ?? num(v.value);
      return { dateTime: date, value: { vo2Max: vo2 } };
    }
  }
  return { dateTime: date, value: {} };
}
