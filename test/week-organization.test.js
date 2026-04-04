import test from 'node:test';
import assert from 'node:assert/strict';
import { getISOWeekNumber } from '../dist/media/organization.js';

test('getISOWeekNumber returns correct week for mid-year date', () => {
  // 2026-04-04 is a Saturday in ISO week 14
  const result = getISOWeekNumber(new Date(2026, 3, 4)); // April 4, 2026
  assert.equal(result.year, 2026);
  assert.equal(result.week, 14);
});

test('getISOWeekNumber handles Jan 1 edge case', () => {
  // Jan 1, 2026 is a Thursday — ISO week 1
  const result = getISOWeekNumber(new Date(2026, 0, 1));
  assert.equal(result.year, 2026);
  assert.equal(result.week, 1);
});

test('getISOWeekNumber handles year boundary (Dec 31)', () => {
  // Dec 31, 2025 is a Wednesday — ISO week 1 of 2026
  const result = getISOWeekNumber(new Date(2025, 11, 31));
  assert.equal(result.year, 2026);
  assert.equal(result.week, 1);
});

test('getISOWeekNumber handles year where Jan 1 is in previous year week', () => {
  // Jan 1, 2023 is a Sunday — ISO week 52 of 2022
  const result = getISOWeekNumber(new Date(2023, 0, 1));
  assert.equal(result.year, 2022);
  assert.equal(result.week, 52);
});

test('getISOWeekNumber handles week 53', () => {
  // 2020 has 53 ISO weeks. Dec 31, 2020 (Thursday) is W53
  const result = getISOWeekNumber(new Date(2020, 11, 31));
  assert.equal(result.year, 2020);
  assert.equal(result.week, 53);
});

test('getISOWeekNumber returns consistent results for same week', () => {
  // Monday and Friday of the same week should return the same week number
  const monday = getISOWeekNumber(new Date(2026, 2, 30)); // March 30
  const friday = getISOWeekNumber(new Date(2026, 3, 3));   // April 3
  assert.equal(monday.week, friday.week);
  assert.equal(monday.year, friday.year);
});
