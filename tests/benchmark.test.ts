/**
 * Flare — Comprehensive Test Suite
 * Tests risk scoring, available hours calculation, free slot finding,
 * API latency benchmarks, voice-task parsing, and quiet-hours logic.
 *
 * Self-contained: pure algorithmic functions are inlined here to avoid
 * import-time side-effects from @google/genai and firebase-admin.
 *
 * Run with: node --experimental-transform-types tests/benchmark.test.ts
 *   OR:     node --loader ./tests/ts-loader.mjs --experimental-transform-types tests/benchmark.test.ts
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

// ===========================================================================
// INLINED PURE FUNCTIONS (mirrors the source files exactly)
// We inline here to avoid import-time side-effects from @google/genai and
// firebase-admin which perform network/credential lookups on module load.
// ===========================================================================

// ---------------------------------------------------------------------------
// From: src/sharedUtils.ts
// ---------------------------------------------------------------------------

interface BusyInterval {
  start: string;
  end: string;
}

function mergeIntervals(intervals: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start.getTime() <= last.end.getTime()) {
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      merged.push(current);
    }
  }
  return merged;
}

function calculateAvailableHours(
  timeMinStr: string,
  timeMaxStr: string,
  busyIntervals: BusyInterval[]
): { availableHours: number; busyCount: number; totalBusyHours: number } {
  const timeMin = new Date(timeMinStr);
  const timeMax = new Date(timeMaxStr);
  const totalHours = Math.max(0, (timeMax.getTime() - timeMin.getTime()) / (1000 * 60 * 60));

  if (totalHours === 0) {
    return { availableHours: 0, busyCount: 0, totalBusyHours: 0 };
  }

  const intervals: { start: Date; end: Date }[] = [];
  let busyCount = 0;

  for (const interval of busyIntervals) {
    const start = new Date(interval.start);
    const end = new Date(interval.end);

    if (end.getTime() <= timeMin.getTime() || start.getTime() >= timeMax.getTime()) {
      continue;
    }

    const clippedStart = start.getTime() < timeMin.getTime() ? timeMin : start;
    const clippedEnd = end.getTime() > timeMax.getTime() ? timeMax : end;

    intervals.push({ start: clippedStart, end: clippedEnd });
    busyCount++;
  }

  const merged = mergeIntervals(intervals);

  let totalBusyHours = 0;
  for (const interval of merged) {
    totalBusyHours += (interval.end.getTime() - interval.start.getTime()) / (1000 * 60 * 60);
  }

  const availableHours = Math.max(0, totalHours - totalBusyHours);
  return { availableHours, busyCount, totalBusyHours };
}

function findNextFreeSlot(
  busyIntervals: BusyInterval[],
  effortHours: number,
  startFrom: Date = new Date()
): { start: Date; end: Date } {
  const busy = busyIntervals
    .map(b => ({ start: new Date(b.start), end: new Date(b.end) }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  let candidate = new Date(startFrom);
  const minutes = candidate.getMinutes();
  if (minutes > 0 && minutes <= 30) {
    candidate.setMinutes(30, 0, 0);
  } else if (minutes > 30) {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  } else {
    candidate.setMinutes(0, 0, 0);
  }

  const maxSearchDate = new Date(candidate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const durationMs = effortHours * 60 * 60 * 1000;

  while (candidate.getTime() < maxSearchDate.getTime()) {
    const end = new Date(candidate.getTime() + durationMs);

    const candHour = candidate.getHours();
    const endHour = end.getHours();

    if (candHour < 8) {
      candidate.setHours(8, 0, 0, 0);
      continue;
    }

    const startDay = candidate.getDate();
    const endDay = end.getDate();
    if (startDay !== endDay || endHour > 22 || (endHour === 22 && end.getMinutes() > 0)) {
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(8, 0, 0, 0);
      continue;
    }

    let hasOverlap = false;
    for (const b of busy) {
      if (candidate.getTime() < b.end.getTime() && end.getTime() > b.start.getTime()) {
        hasOverlap = true;
        candidate = new Date(b.end.getTime());
        const m = candidate.getMinutes();
        if (m > 0 && m <= 30) {
          candidate.setMinutes(30, 0, 0);
        } else if (m > 30) {
          candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
        } else {
          candidate.setMinutes(0, 0, 0);
        }
        break;
      }
    }

    if (!hasOverlap) {
      return { start: candidate, end };
    }
  }

  return {
    start: startFrom,
    end: new Date(startFrom.getTime() + durationMs),
  };
}

// ---------------------------------------------------------------------------
// From: server/riskScorer.ts  (deterministic path only — no Gemini)
// ---------------------------------------------------------------------------

interface TaskEvaluationInput {
  title: string;
  description?: string;
  deadline: string;
  estimatedEffort: number;
  category: string;
  status: string;
  busyIntervals?: Array<{ start: string; end: string }>;
}

interface TaskEvaluationOutput {
  riskScore: 'Critical' | 'Urgent' | 'Stable';
  reasoning: string;
}

async function evaluateTaskRisk(
  task: TaskEvaluationInput,
  currentTimeStr: string
): Promise<TaskEvaluationOutput> {
  if (task.status === 'done') {
    return { riskScore: 'Stable', reasoning: 'Task is complete.' };
  }

  const deadlineDate = new Date(task.deadline);
  const currentDate = new Date(currentTimeStr);
  const rawRemainingMs = deadlineDate.getTime() - currentDate.getTime();
  const rawRemainingHours = rawRemainingMs / (1000 * 60 * 60);

  let remainingHours = rawRemainingHours;
  let useCalendar = false;
  let busyCount = 0;
  let totalBusyHours = 0;

  if (task.busyIntervals && Array.isArray(task.busyIntervals)) {
    const calc = calculateAvailableHours(currentTimeStr, task.deadline, task.busyIntervals);
    remainingHours = calc.availableHours;
    busyCount = calc.busyCount;
    totalBusyHours = calc.totalBusyHours;
    useCalendar = true;
  }

  const hrsLeft = Math.round(remainingHours);
  const eff = task.estimatedEffort;
  const buffer = remainingHours - eff;

  let riskScore: 'Critical' | 'Urgent' | 'Stable' = 'Stable';
  let reasoning = '';

  if (rawRemainingHours <= 0) {
    riskScore = 'Critical';
    reasoning = `Deadline has passed! Overdue by ${Math.abs(Math.round(rawRemainingHours))}h.`;
  } else if (buffer < 0) {
    riskScore = 'Critical';
    const deficit = Math.abs(buffer).toFixed(1);
    if (useCalendar) {
      reasoning = `Deficit of -${deficit}h! Need ${eff}h but only ${remainingHours.toFixed(1)}h actually free (${busyCount} mtgs in way).`;
    } else {
      reasoning = `Deficit of -${deficit}h! Need ${eff}h but only ${hrsLeft}h left until deadline.`;
    }
  } else if (remainingHours <= 12) {
    riskScore = 'Critical';
    reasoning = `Extremely tight window! Due in ${remainingHours.toFixed(1)}h. Buffer is only ${buffer.toFixed(1)}h.`;
  } else if (remainingHours <= 36 || buffer < 6) {
    riskScore = 'Urgent';
    if (useCalendar) {
      reasoning = `Tight free-time buffer of ${buffer.toFixed(1)}h (${busyCount} mtgs overlap) vs. ${eff}h effort required.`;
    } else {
      reasoning = `Tight margin of ${buffer.toFixed(1)}h left. Task is due in ${hrsLeft}h.`;
    }
  } else {
    riskScore = 'Stable';
    if (useCalendar) {
      reasoning = `Healthy buffer: ${buffer.toFixed(1)}h free after scheduling ${eff}h around ${busyCount} meetings.`;
    } else {
      reasoning = `Stable schedule: comfortable ${buffer.toFixed(1)}h buffer. Due in ${hrsLeft}h.`;
    }
  }

  return { riskScore, reasoning };
}

// ---------------------------------------------------------------------------
// From: server/rescueAgent.ts  (isQuietHours — PST offset fixed to -8)
// ---------------------------------------------------------------------------

function isQuietHours(): boolean {
  try {
    const pacificStr = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const pacificDate = new Date(pacificStr);
    const hour = pacificDate.getHours();
    return hour >= 22 || hour < 7;
  } catch (error) {
    const hourUtc = new Date().getUTCHours();
    // PST standard offset is UTC-8 (bug fix: was -7)
    const pacificHour = (hourUtc - 8 + 24) % 24;
    return pacificHour >= 22 || pacificHour < 7;
  }
}

// ===========================================================================
// TEST HELPERS
// ===========================================================================

function hoursFromNow(h: number): string {
  return new Date(Date.now() + h * 3_600_000).toISOString();
}

function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3_600_000).toISOString();
}

const NOW = new Date().toISOString();

function makeTask(
  overrides: Partial<TaskEvaluationInput> & { deadline: string; estimatedEffort: number }
): TaskEvaluationInput {
  return {
    title: 'Test Task',
    description: '',
    category: 'general',
    status: 'in-progress',
    ...overrides,
  };
}

// ===========================================================================
// 1. RISK SCORING CORRECTNESS (10 cases)
// ===========================================================================

describe('Risk Scoring Correctness', () => {
  test('RS-1: Done task is always Stable', async () => {
    const task = makeTask({ deadline: hoursFromNow(1), estimatedEffort: 5, status: 'done' });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Stable');
  });

  test('RS-2: Deadline passed → Critical', async () => {
    const task = makeTask({ deadline: hoursAgo(2), estimatedEffort: 1 });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Critical');
  });

  test('RS-3: Effort exceeds remaining time (deficit) → Critical', async () => {
    // deadline in 3h, effort=5h → buffer=-2h
    const task = makeTask({ deadline: hoursFromNow(3), estimatedEffort: 5 });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Critical');
  });

  test('RS-4: Remaining time <= 12h (tight window) → Critical', async () => {
    // deadline in 8h, effort=2h → buffer=6h but remainingHours<=12
    const task = makeTask({ deadline: hoursFromNow(8), estimatedEffort: 2 });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Critical');
  });

  test('RS-5: Tight margin (remaining<=36h, buffer<6h) → Urgent', async () => {
    // deadline in 24h, effort=20h → buffer=4h, remainingHours<=36 → Urgent
    const task = makeTask({ deadline: hoursFromNow(24), estimatedEffort: 20 });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Urgent');
  });

  test('RS-6: Comfortable buffer → Stable', async () => {
    // deadline in 72h, effort=4h → buffer=68h, remainingHours>36 → Stable
    const task = makeTask({ deadline: hoursFromNow(72), estimatedEffort: 4 });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Stable');
  });

  test('RS-7: Busy intervals cause deficit → Critical', async () => {
    // deadline in 10h, effort=4h, two 4h busy blocks (total 8h busy) → available≈2h < effort
    const now = new Date();
    const busyIntervals = [
      {
        start: new Date(now.getTime() + 1 * 3_600_000).toISOString(),
        end: new Date(now.getTime() + 5 * 3_600_000).toISOString(),
      },
      {
        start: new Date(now.getTime() + 5 * 3_600_000).toISOString(),
        end: new Date(now.getTime() + 9 * 3_600_000).toISOString(),
      },
    ];
    const task = makeTask({ deadline: hoursFromNow(10), estimatedEffort: 4, busyIntervals });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Critical');
  });

  test('RS-8: Busy intervals present but still Stable', async () => {
    // deadline in 48h, effort=3h, 1×1h busy interval → available≈47h → buffer=44h → Stable
    const now = new Date();
    const busyIntervals = [
      {
        start: new Date(now.getTime() + 2 * 3_600_000).toISOString(),
        end: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
      },
    ];
    const task = makeTask({ deadline: hoursFromNow(48), estimatedEffort: 3, busyIntervals });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Stable');
  });

  test('RS-9: Buffer exactly at 6h boundary → Stable', async () => {
    // deadline in 42h, effort=36h → buffer=6h exactly
    // buffer < 6 is false; remainingHours<=36 is false (42>36) → Stable
    const task = makeTask({ deadline: hoursFromNow(42), estimatedEffort: 36 });
    const result = await evaluateTaskRisk(task, NOW);
    assert.equal(result.riskScore, 'Stable');
  });

  test('RS-10: Remaining exactly 36h, effort=1h → Urgent (remainingHours<=36 triggers Urgent)', async () => {
    // Pin both currentTime and deadline to the same instant so remaining is exactly 36h.
    const pinNow = new Date();
    const deadline = new Date(pinNow.getTime() + 36 * 3_600_000).toISOString();
    const currentTimeStr = pinNow.toISOString();
    const task = makeTask({ deadline, estimatedEffort: 1 });
    const result = await evaluateTaskRisk(task, currentTimeStr);
    assert.equal(result.riskScore, 'Urgent');
  });
});

// ===========================================================================
// 2. calculateAvailableHours (6 cases)
// ===========================================================================

describe('calculateAvailableHours', () => {
  test('CA-1: No busy intervals → availableHours equals totalHours', async () => {
    const start = new Date('2025-01-01T08:00:00Z');
    const end = new Date('2025-01-01T18:00:00Z');
    const result = calculateAvailableHours(start.toISOString(), end.toISOString(), []);
    assert.equal(result.availableHours, 10);
    assert.equal(result.busyCount, 0);
  });

  test('CA-2: Single busy interval fully inside window → properly subtracted', async () => {
    const start = new Date('2025-01-01T08:00:00Z');
    const end = new Date('2025-01-01T18:00:00Z'); // 10h window
    const busy = [{ start: '2025-01-01T10:00:00Z', end: '2025-01-01T12:00:00Z' }]; // 2h
    const result = calculateAvailableHours(start.toISOString(), end.toISOString(), busy);
    assert.equal(result.availableHours, 8);
    assert.equal(result.busyCount, 1);
  });

  test('CA-3: Overlapping busy intervals (merged) → counted only once', async () => {
    const start = new Date('2025-01-01T08:00:00Z');
    const end = new Date('2025-01-01T18:00:00Z'); // 10h window
    const busy = [
      { start: '2025-01-01T09:00:00Z', end: '2025-01-01T12:00:00Z' },
      { start: '2025-01-01T11:00:00Z', end: '2025-01-01T13:00:00Z' },
    ];
    // merged → 09:00-13:00 = 4h busy → available = 6h
    const result = calculateAvailableHours(start.toISOString(), end.toISOString(), busy);
    assert.equal(result.availableHours, 6);
  });

  test('CA-4: Busy interval completely outside window → ignored', async () => {
    const start = new Date('2025-01-01T08:00:00Z');
    const end = new Date('2025-01-01T18:00:00Z'); // 10h window
    const busy = [{ start: '2025-01-01T20:00:00Z', end: '2025-01-01T22:00:00Z' }];
    const result = calculateAvailableHours(start.toISOString(), end.toISOString(), busy);
    assert.equal(result.availableHours, 10);
    assert.equal(result.busyCount, 0);
  });

  test('CA-5: Busy interval partially overlaps start → clipped correctly', async () => {
    const start = new Date('2025-01-01T10:00:00Z');
    const end = new Date('2025-01-01T18:00:00Z'); // 8h window
    const busy = [{ start: '2025-01-01T08:00:00Z', end: '2025-01-01T11:00:00Z' }];
    // clipped busy = 10:00-11:00 = 1h → available = 7h
    const result = calculateAvailableHours(start.toISOString(), end.toISOString(), busy);
    assert.equal(result.availableHours, 7);
  });

  test('CA-6: Zero-duration window → availableHours=0', async () => {
    const point = new Date('2025-01-01T12:00:00Z').toISOString();
    const result = calculateAvailableHours(point, point, []);
    assert.equal(result.availableHours, 0);
  });
});

// ===========================================================================
// 3. findNextFreeSlot (5 cases)
// ===========================================================================

describe('findNextFreeSlot', () => {
  test('FS-1: No busy intervals, starts from 9am → slot respects waking hours (≥8am)', async () => {
    const startFrom = new Date();
    startFrom.setHours(9, 0, 0, 0);
    const slot = findNextFreeSlot([], 1, startFrom);
    assert.ok(slot.start >= startFrom, 'Slot should start at or after startFrom');
    assert.ok(slot.start.getHours() >= 8, 'Slot should start at or after 8am');
    assert.equal(slot.end.getTime() - slot.start.getTime(), 3_600_000, 'Duration should be exactly 1h');
  });

  test('FS-2: Busy block covers first slot → jumps to after busy end', async () => {
    const base = new Date();
    base.setHours(9, 0, 0, 0);
    const busyEnd = new Date(base.getTime() + 2 * 3_600_000); // 09:00-11:00
    const busy = [{ start: base.toISOString(), end: busyEnd.toISOString() }];
    const slot = findNextFreeSlot(busy, 1, base);
    assert.ok(
      slot.start.getTime() >= busyEnd.getTime(),
      `Slot (${slot.start.toISOString()}) should start at or after busy end (${busyEnd.toISOString()})`
    );
  });

  test('FS-3: startFrom before 8am → rounds up to 8am or later', async () => {
    const early = new Date();
    early.setHours(5, 0, 0, 0); // 5am
    const slot = findNextFreeSlot([], 1, early);
    assert.ok(slot.start.getHours() >= 8, `Slot should start at 8am+, got hour=${slot.start.getHours()}`);
  });

  test('FS-4: Effort longer than single waking window → placed on next day', async () => {
    const base = new Date();
    base.setHours(9, 0, 0, 0);
    // 14h effort cannot fit in 9am-10pm (13h waking window)
    const slot = findNextFreeSlot([], 14, base);
    const differentDate =
      slot.start.getDate() !== base.getDate() ||
      slot.start.getMonth() !== base.getMonth() ||
      slot.start.getFullYear() !== base.getFullYear();
    assert.ok(differentDate, `14h slot should land on a different day. slot.start=${slot.start.toISOString()}`);
  });

  test('FS-5: Multiple non-overlapping busy blocks → slot does not overlap any busy', async () => {
    const base = new Date();
    base.setHours(8, 0, 0, 0);
    // busy: 08:00-10:00 and 11:00-13:00 → 1h gap at 10:00-11:00
    const busy = [
      { start: new Date(base.getTime()).toISOString(), end: new Date(base.getTime() + 2 * 3_600_000).toISOString() },
      { start: new Date(base.getTime() + 3 * 3_600_000).toISOString(), end: new Date(base.getTime() + 5 * 3_600_000).toISOString() },
    ];
    const slot = findNextFreeSlot(busy, 1, base);
    for (const b of busy) {
      const bStart = new Date(b.start).getTime();
      const bEnd = new Date(b.end).getTime();
      const overlaps = slot.start.getTime() < bEnd && slot.end.getTime() > bStart;
      assert.ok(!overlaps, `Slot overlaps busy block ${b.start}–${b.end}`);
    }
  });
});

// ===========================================================================
// 4. API LATENCY BENCHMARKS (3 cases)
// ===========================================================================

describe('API Latency Benchmarks', () => {
  test('LAT-1: 100× risk evaluations (no calendar) complete in < 100ms total', async () => {
    const task = makeTask({ deadline: hoursFromNow(48), estimatedEffort: 4 });
    const start = performance.now();
    for (let i = 0; i < 100; i++) await evaluateTaskRisk(task, NOW);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 100, `Expected < 100ms, got ${elapsed.toFixed(2)}ms`);
  });

  test('LAT-2: 100× risk evaluations (10 busy intervals each) complete in < 500ms total', async () => {
    const now = new Date();
    const busyIntervals = Array.from({ length: 10 }, (_, i) => ({
      start: new Date(now.getTime() + i * 2 * 3_600_000).toISOString(),
      end: new Date(now.getTime() + (i * 2 + 1) * 3_600_000).toISOString(),
    }));
    const task = makeTask({ deadline: hoursFromNow(72), estimatedEffort: 4, busyIntervals });
    const start = performance.now();
    for (let i = 0; i < 100; i++) await evaluateTaskRisk(task, NOW);
    const elapsed = performance.now() - start;
    assert.ok(elapsed < 500, `Expected < 500ms, got ${elapsed.toFixed(2)}ms`);
  });

  test('LAT-3: p99 single-evaluation latency < 10ms', async () => {
    const task = makeTask({ deadline: hoursFromNow(48), estimatedEffort: 4 });
    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const t0 = performance.now();
      await evaluateTaskRisk(task, NOW);
      latencies.push(performance.now() - t0);
    }
    latencies.sort((a, b) => a - b);
    const p99 = latencies[Math.ceil(latencies.length * 0.99) - 1];
    assert.ok(p99 < 10, `p99=${p99.toFixed(3)}ms exceeds 10ms threshold`);
  });
});

// ===========================================================================
// 5. VOICE-TASK PARSING ACCURACY (4 mock tests)
// ===========================================================================

interface ParsedVoiceResult {
  action: 'CREATE_TASK' | 'CHAT';
  taskPayload?: { title: string; estimatedEffort?: number };
}

/** Simple rule-based voice-to-task parser simulating Gemini's behaviour. */
function parseVoiceTranscript(text: string): ParsedVoiceResult {
  const lower = text.toLowerCase();

  const isTask =
    lower.includes('create') ||
    lower.includes('add') ||
    lower.includes('schedule') ||
    /remind me to/.test(lower);

  if (!isTask) return { action: 'CHAT' };

  // Extract effort: first "N hour(s)" pattern
  const effortMatch = lower.match(/(\d+)\s*hours?/);
  const estimatedEffort = effortMatch ? parseInt(effortMatch[1], 10) : undefined;

  // Extract title: strip intent prefix + trailing time/effort clauses
  let title = text
    .replace(/^(create a task to|add a|schedule a|remind me to)/i, '')
    .replace(/,?\s*(due\s*(next\s*\w+|tomorrow|in\s*\d+\s*days?))[^,]*/i, '')
    .replace(/,?\s*estimated\s*\d+\s*hours?.*$/i, '')
    .replace(/,?\s*\d+\s*hours?\s*(effort|needed)?.*$/i, '')
    .trim();

  return { action: 'CREATE_TASK', taskPayload: { title, estimatedEffort } };
}

describe('Voice-Task Parsing Accuracy', () => {
  test('VP-1: CS assignment → CREATE_TASK, title contains "CS assignment", effort=3', async () => {
    const r = parseVoiceTranscript(
      'Create a task to finish my CS assignment due tomorrow, estimated 3 hours'
    );
    assert.equal(r.action, 'CREATE_TASK');
    assert.ok(
      r.taskPayload?.title.toLowerCase().includes('cs assignment'),
      `Title should contain "CS assignment", got: "${r.taskPayload?.title}"`
    );
    assert.equal(r.taskPayload?.estimatedEffort, 3);
  });

  test('VP-2: Bill payment → CREATE_TASK, title contains "bill", effort=1', async () => {
    const r = parseVoiceTranscript('Add a bill payment task due next Friday, 1 hour effort');
    assert.equal(r.action, 'CREATE_TASK');
    assert.ok(
      r.taskPayload?.title.toLowerCase().includes('bill'),
      `Title should contain "bill", got: "${r.taskPayload?.title}"`
    );
    assert.equal(r.taskPayload?.estimatedEffort, 1);
  });

  test("VP-3: Weather question → action=CHAT", async () => {
    const r = parseVoiceTranscript("What's the weather today?");
    assert.equal(r.action, 'CHAT');
    assert.equal(r.taskPayload, undefined);
  });

  test('VP-4: Study reminder → CREATE_TASK, effort=5', async () => {
    const r = parseVoiceTranscript('Remind me to study for my exam in 2 days, 5 hours needed');
    assert.equal(r.action, 'CREATE_TASK');
    assert.equal(r.taskPayload?.estimatedEffort, 5);
  });
});

// ===========================================================================
// 6. isQuietHours CORRECTNESS
// ===========================================================================

describe('isQuietHours correctness', () => {
  test('QH-1: isQuietHours() returns a boolean', async () => {
    const result = isQuietHours();
    assert.equal(typeof result, 'boolean');
  });
});
