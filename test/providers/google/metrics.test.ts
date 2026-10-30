import { describe, expect, it, vi } from 'vitest';
import { GoogleClient } from '../../../src/providers/google/client';
import { detailedRecords } from '../../../src/providers/google/extra';
import {
  getHRV,
  getRespiratoryRate,
  getSkinTemperature,
  getSpO2,
} from '../../../src/providers/google/metrics';
import {
  HrvDaySchema,
  RespiratoryRateDaySchema,
  SkinTempDaySchema,
  SpO2DaySchema,
} from '../../../src/providers/types';
import { createMockEnv } from '../../helpers/mock-env';

// Synthetic fixtures in the shape of live reconcile (no filter) responses.
function client(fixture: unknown): Pick<GoogleClient, 'requestJson'> {
  return { requestJson: vi.fn(async () => fixture) } as unknown as Pick<
    GoogleClient,
    'requestJson'
  >;
}

describe('getHRV', () => {
  const fixture = {
    dataPoints: [
      {
        dailyHeartRateVariability: {
          date: { year: 2026, month: 7, day: 17 },
          averageHeartRateVariabilityMilliseconds: 55,
          deepSleepRootMeanSquareOfSuccessiveDifferencesMilliseconds: 45.5,
        },
      },
      {
        dailyHeartRateVariability: {
          date: { year: 2026, month: 7, day: 16 },
          averageHeartRateVariabilityMilliseconds: 50.5,
        },
      },
    ],
  };
  it('maps averageHRV -> dailyRmssd and deep RMSSD -> deepRmssd, ascending', async () => {
    const out = await getHRV(client(fixture), '2026-07-16', '2026-07-17');
    expect(out).toEqual([
      { dateTime: '2026-07-16', value: { dailyRmssd: 50.5, deepRmssd: undefined } },
      { dateTime: '2026-07-17', value: { dailyRmssd: 55, deepRmssd: 45.5 } },
    ]);
    expect(() => out.map((d) => HrvDaySchema.parse(d))).not.toThrow();
  });
  it('filters out days outside the requested range', async () => {
    const out = await getHRV(client(fixture), '2026-07-17', '2026-07-17');
    expect(out.map((d) => d.dateTime)).toEqual(['2026-07-17']);
  });
  it('retains optional non-REM heart rate and entropy, including zero', async () => {
    const result = await getHRV(
      client({
        dataPoints: [
          {
            dailyHeartRateVariability: {
              date: { year: 2026, month: 7, day: 17 },
              averageHeartRateVariabilityMilliseconds: 55,
              nonRemHeartRateBeatsPerMinute: '61',
              entropy: 0,
            },
          },
        ],
      }),
      '2026-07-17',
      '2026-07-17',
    );
    expect(HrvDaySchema.parse(result[0]).value).toMatchObject({
      dailyRmssd: 55,
      nonRemHeartRateBeatsPerMinute: 61,
      entropy: 0,
    });
  });
});

describe('getSpO2', () => {
  it('maps average and confidence bounds without claiming extrema', async () => {
    const fixture = {
      dataPoints: [
        {
          dailyOxygenSaturation: {
            date: { year: 2026, month: 7, day: 16 },
            averagePercentage: 97.5,
            lowerBoundPercentage: 95.2,
            upperBoundPercentage: 99.1,
          },
        },
      ],
    };
    const out = await getSpO2(client(fixture), '2026-07-16', '2026-07-16');
    expect(out).toEqual([
      {
        dateTime: '2026-07-16',
        value: { avg: 97.5, lowerBoundPercentage: 95.2, upperBoundPercentage: 99.1 },
      },
    ]);
    expect(() => SpO2DaySchema.parse(out[0])).not.toThrow();
  });
});

describe('getRespiratoryRate', () => {
  it('maps breathsPerMinute to breathingRate', async () => {
    const fixture = {
      dataPoints: [
        {
          dailyRespiratoryRate: { date: { year: 2026, month: 7, day: 17 }, breathsPerMinute: 16.5 },
        },
      ],
    };
    const out = await getRespiratoryRate(client(fixture), '2026-07-17', '2026-07-17');
    expect(out).toEqual([{ dateTime: '2026-07-17', value: { breathingRate: 16.5 } }]);
    expect(() => RespiratoryRateDaySchema.parse(out[0])).not.toThrow();
  });
});

describe('getSkinTemperature', () => {
  it('derives nightlyRelative = nightly - baseline (absolute °C confirmed)', async () => {
    const fixture = {
      dataPoints: [
        {
          dailySleepTemperatureDerivations: {
            date: { year: 2026, month: 7, day: 17 },
            nightlyTemperatureCelsius: 34.2,
            baselineTemperatureCelsius: 33.9,
          },
        },
      ],
    };
    const out = await getSkinTemperature(client(fixture), '2026-07-17', '2026-07-17');
    expect(out[0]?.value.nightlyRelative).toBeCloseTo(0.3, 2);
    expect(() => SkinTempDaySchema.parse(out[0])).not.toThrow();
  });

  it('shares the bounded source records between summary and detail in one collection', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            dataPoints: [
              {
                dailySleepTemperatureDerivations: {
                  date: { year: 2026, month: 7, day: 17 },
                  nightlyTemperatureCelsius: 34.2,
                  baselineTemperatureCelsius: 33.9,
                },
              },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      const env = createMockEnv({
        access_token: 'tok',
        refresh_token: 'r',
        expires_at: String(Math.floor(Date.now() / 1000) + 3600),
      });
      const google = new GoogleClient(env, true);
      const summary = await getSkinTemperature(google, '2026-07-17', '2026-07-17', true);
      const details = await detailedRecords(
        google,
        'daily-sleep-temperature-derivations',
        'dailySleepTemperatureDerivations',
        'daily',
        '2026-07-17',
        '2026-07-17',
      );
      expect(summary[0]?.value.nightlyRelative).toBeCloseTo(0.3, 2);
      expect(details).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
