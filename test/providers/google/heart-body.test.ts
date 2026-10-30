import { describe, expect, it, vi } from 'vitest';
import { getBodyLog } from '../../../src/providers/google/body';
import type { GoogleClient } from '../../../src/providers/google/client';
import { getHeartRateRange } from '../../../src/providers/google/heart';
import { BodyLogSchema, HeartRateDaySchema } from '../../../src/providers/types';

function client(fixture: unknown): Pick<GoogleClient, 'requestJson'> {
  return { requestJson: vi.fn(async () => fixture) } as unknown as Pick<
    GoogleClient,
    'requestJson'
  >;
}

describe('getHeartRateRange', () => {
  const fixture = {
    dataPoints: [
      { dailyRestingHeartRate: { date: { year: 2026, month: 7, day: 17 }, beatsPerMinute: '62' } },
      { dailyRestingHeartRate: { date: { year: 2026, month: 7, day: 16 }, beatsPerMinute: '60' } },
    ],
  };
  it('maps beatsPerMinute (string) to restingHeartRate, ascending', async () => {
    const out = await getHeartRateRange(client(fixture), '2026-07-16', '2026-07-17');
    expect(out).toEqual([
      { dateTime: '2026-07-16', value: { restingHeartRate: 60 } },
      { dateTime: '2026-07-17', value: { restingHeartRate: 62 } },
    ]);
    expect(() => out.map((d) => HeartRateDaySchema.parse(d))).not.toThrow();
  });
  it('preserves the reported calculation method without inventing missing metadata', async () => {
    const result = await getHeartRateRange(
      client({
        dataPoints: [
          {
            dailyRestingHeartRate: {
              date: { year: 2026, month: 7, day: 17 },
              beatsPerMinute: '62',
              dailyRestingHeartRateMetadata: { calculationMethod: 'WITH_SLEEP' },
            },
          },
          {
            dailyRestingHeartRate: {
              date: { year: 2026, month: 7, day: 16 },
              beatsPerMinute: '60',
            },
          },
        ],
      }),
      '2026-07-16',
      '2026-07-17',
    );
    expect(result[0]?.value.calculationMethod).toBeUndefined();
    expect(HeartRateDaySchema.parse(result[1]).value.calculationMethod).toBe('WITH_SLEEP');
  });
});

describe('getBodyLog', () => {
  it('converts weightGrams to kg and dates by civilTime', async () => {
    const fixture = {
      dataPoints: [
        {
          dataPointName:
            'users/1000000000000000001/dataTypes/weight/dataPoints/7594568203978154507',
          weight: {
            sampleTime: { civilTime: { date: { year: 2026, month: 7, day: 11 } } },
            weightGrams: 70500,
          },
        },
      ],
    };
    const body = await getBodyLog(client(fixture), '2026-07-01', '2026-07-31');
    expect(body.weight).toEqual([{ date: '2026-07-11', weight: 70.5 }]);
    expect(body.fat).toEqual([]);
    expect(() => BodyLogSchema.parse(body)).not.toThrow();
  });
});
