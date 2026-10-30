import type { Env } from '../../env';
import type {
  ActivityResourceT,
  BodyFatLog,
  BodyLog,
  CardioFitness,
  DailySummary,
  Device,
  ExerciseLog,
  FoodLog,
  FoodLogEntry,
  HealthProvider,
  HeartRateDay,
  HeartRateIntraday,
  HrvDay,
  IntradayDetailLevelT,
  LogActivityInput,
  LogBodyFatInput,
  LogFoodInput,
  LogMealInput,
  LogSleepInput,
  LogWaterInput,
  LogWeightInput,
  Profile,
  RespiratoryRateDay,
  SkinTempDay,
  SleepLog,
  SpO2Day,
  TimeSeries,
  WaterLogEntry,
  WeightLog,
} from '../types';
import { getActivityTimeSeries } from './activity';
import { getBodyLog } from './body';
import { GoogleClient } from './client';
import { listDevices } from './device';
import { getExerciseList } from './exercise';
import {
  compactActivityLevels,
  dailyAggregate,
  detailedRecords,
  exerciseRecords,
  heartRateRollups,
  hourlySteps,
} from './extra';
import { getFoodLog } from './food';
import { getCardioFitness, getHeartRateRange } from './heart';
import { getHeartRateIntraday } from './intraday';
import { getHRV, getRespiratoryRate, getSkinTemperature, getSpO2 } from './metrics';
import { getProfile } from './profile';
import { getSleep, getSleepDetails, getSleepRange } from './sleep';
import { getDailySummary } from './summary';

/** Thrown by write/delete methods not implemented in this read-only edition. */
function notYet(method: string): never {
  throw new Error(`GoogleHealthProvider.${method}() is not implemented in this edition.`);
}

/**
 * GoogleHealthProvider — implements HealthProvider against Google Health
 * API v4 (health.googleapis.com). This edition implements the read surface;
 * the write/delete methods throw `notYet`.
 */
export class GoogleHealthProvider implements HealthProvider {
  private readonly client: GoogleClient;

  constructor(
    env: Env,
    private readonly cacheCollectionReads = false,
  ) {
    this.client = new GoogleClient(env, cacheCollectionReads);
  }

  // --- Read ---
  getProfile(): Promise<Profile> {
    return getProfile(this.client);
  }
  listDevices(): Promise<Device[]> {
    return listDevices(this.client);
  }
  getDailyAggregate(slug: string, key: string, start: string, end: string) {
    return dailyAggregate(this.client, slug, key, start, end);
  }
  getHeartRateRollups(start: string, end: string) {
    return heartRateRollups(this.client, start, end);
  }
  getExerciseRecords(start: string, end: string) {
    return exerciseRecords(this.client, start, end);
  }
  async getDetailedRecords(
    slug: string,
    key: string,
    kind: 'sample' | 'interval' | 'daily',
    start: string,
    end: string,
  ) {
    const points = await detailedRecords(this.client, slug, key, kind, start, end);
    return slug === 'activity-level' ? compactActivityLevels(points) : points;
  }
  getHourlySteps(start: string, end: string) {
    return hourlySteps(this.client, start, end);
  }
  getDailySummary(date: string): Promise<DailySummary> {
    return getDailySummary(this.client, date);
  }
  getActivityTimeSeries(
    resource: ActivityResourceT,
    start: string,
    end: string,
  ): Promise<TimeSeries> {
    return getActivityTimeSeries(this.client, resource, start, end);
  }
  getExerciseList(opts: { beforeDate?: string; limit?: number }): Promise<ExerciseLog[]> {
    return getExerciseList(this.client, opts);
  }
  getHeartRateRange(start: string, end: string): Promise<HeartRateDay[]> {
    return getHeartRateRange(this.client, start, end);
  }
  getHeartRateIntraday(
    date: string,
    detailLevel: IntradayDetailLevelT,
  ): Promise<HeartRateIntraday> {
    return getHeartRateIntraday(this.client, date, detailLevel);
  }
  getSleep(date: string): Promise<SleepLog[]> {
    return getSleep(this.client, date);
  }
  getSleepRange(start: string, end: string): Promise<SleepLog[]> {
    return getSleepRange(this.client, start, end);
  }
  getSleepDetails(start: string, end: string) {
    return getSleepDetails(this.client, start, end);
  }
  getBodyLog(start: string, end: string): Promise<BodyLog> {
    return getBodyLog(this.client, start, end);
  }
  getFoodLog(date: string): Promise<FoodLog> {
    return getFoodLog(this.client, date);
  }
  getSpO2(start: string, end: string): Promise<SpO2Day[]> {
    return getSpO2(this.client, start, end);
  }
  getRespiratoryRate(start: string, end: string): Promise<RespiratoryRateDay[]> {
    return getRespiratoryRate(this.client, start, end);
  }
  getSkinTemperature(start: string, end: string): Promise<SkinTempDay[]> {
    return getSkinTemperature(this.client, start, end, this.cacheCollectionReads);
  }
  getHRV(start: string, end: string): Promise<HrvDay[]> {
    return getHRV(this.client, start, end);
  }
  getCardioFitness(date: string): Promise<CardioFitness> {
    return getCardioFitness(this.client, date);
  }

  // --- Write ---
  logFood(_input: LogFoodInput): Promise<FoodLogEntry> {
    return notYet('logFood');
  }
  logMeal(_input: LogMealInput): Promise<FoodLogEntry[]> {
    return notYet('logMeal');
  }
  logWater(_input: LogWaterInput): Promise<WaterLogEntry> {
    return notYet('logWater');
  }
  logWeight(_input: LogWeightInput): Promise<WeightLog> {
    return notYet('logWeight');
  }
  logBodyFat(_input: LogBodyFatInput): Promise<BodyFatLog> {
    return notYet('logBodyFat');
  }
  logActivity(_input: LogActivityInput): Promise<ExerciseLog> {
    return notYet('logActivity');
  }
  logSleep(_input: LogSleepInput): Promise<SleepLog> {
    return notYet('logSleep');
  }
  deleteFoodLog(_logId: number): Promise<void> {
    return notYet('deleteFoodLog');
  }
  deleteWaterLog(_logId: number): Promise<void> {
    return notYet('deleteWaterLog');
  }
  deleteWeightLog(_logId: number): Promise<void> {
    return notYet('deleteWeightLog');
  }
  deleteBodyFatLog(_logId: number): Promise<void> {
    return notYet('deleteBodyFatLog');
  }
  deleteActivityLog(_logId: number): Promise<void> {
    return notYet('deleteActivityLog');
  }
  deleteSleepLog(_logId: number): Promise<void> {
    return notYet('deleteSleepLog');
  }
}
