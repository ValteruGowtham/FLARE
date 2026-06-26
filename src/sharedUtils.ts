export interface BusyInterval {
  start: string;
  end: string;
}

/**
 * Helper to merge overlapping intervals to avoid double-counting busy time
 */
export function mergeIntervals(intervals: { start: Date; end: Date }[]): { start: Date; end: Date }[] {
  if (intervals.length === 0) return [];
  // Sort by start time
  const sorted = [...intervals].sort((a, b) => a.start.getTime() - b.start.getTime());
  const merged = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = merged[merged.length - 1];
    if (current.start.getTime() <= last.end.getTime()) {
      // Overlap
      if (current.end.getTime() > last.end.getTime()) {
        last.end = current.end;
      }
    } else {
      merged.push(current);
    }
  }
  return merged;
}

/**
 * Calculate available hours between timeMin and timeMax by subtracting busy intervals
 */
export function calculateAvailableHours(
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

  // Map busy intervals and clip them to [timeMin, timeMax]
  const intervals: { start: Date; end: Date }[] = [];
  let busyCount = 0;

  for (const interval of busyIntervals) {
    const start = new Date(interval.start);
    const end = new Date(interval.end);

    // Skip if completely outside
    if (end.getTime() <= timeMin.getTime() || start.getTime() >= timeMax.getTime()) {
      continue;
    }

    // Clip to the requested window
    const clippedStart = start.getTime() < timeMin.getTime() ? timeMin : start;
    const clippedEnd = end.getTime() > timeMax.getTime() ? timeMax : end;

    intervals.push({ start: clippedStart, end: clippedEnd });
    busyCount++;
  }

  // Merge the clipped intervals
  const merged = mergeIntervals(intervals);

  // Sum up busy hours
  let totalBusyHours = 0;
  for (const interval of merged) {
    totalBusyHours += (interval.end.getTime() - interval.start.getTime()) / (1000 * 60 * 60);
  }

  const availableHours = Math.max(0, totalHours - totalBusyHours);
  return { availableHours, busyCount, totalBusyHours };
}

/**
 * Find the next available free slot of size effortHours that fits waking hours (8am - 10pm)
 * and does not overlap with any busy intervals.
 */
export function findNextFreeSlot(
  busyIntervals: BusyInterval[],
  effortHours: number,
  startFrom: Date = new Date()
): { start: Date; end: Date } {
  const busy = busyIntervals.map(b => ({
    start: new Date(b.start),
    end: new Date(b.end)
  })).sort((a, b) => a.start.getTime() - b.start.getTime());

  // Round startFrom to the next 30-minute mark
  let candidate = new Date(startFrom);
  const minutes = candidate.getMinutes();
  if (minutes > 0 && minutes <= 30) {
    candidate.setMinutes(30, 0, 0);
  } else if (minutes > 30) {
    candidate.setHours(candidate.getHours() + 1, 0, 0, 0);
  } else {
    candidate.setMinutes(0, 0, 0);
  }

  // Search up to 30 days in the future
  const maxSearchDate = new Date(candidate.getTime() + 30 * 24 * 60 * 60 * 1000);
  const durationMs = effortHours * 60 * 60 * 1000;

  while (candidate.getTime() < maxSearchDate.getTime()) {
    const end = new Date(candidate.getTime() + durationMs);

    // Skip late night/early morning hours (10 PM to 8 AM)
    const candHour = candidate.getHours();
    const endHour = end.getHours();
    
    if (candHour < 8) {
      candidate.setHours(8, 0, 0, 0);
      continue;
    }
    
    const startDay = candidate.getDate();
    const endDay = end.getDate();
    if (startDay !== endDay || endHour > 22 || (endHour === 22 && end.getMinutes() > 0)) {
      // Jump to 8 AM of the next day
      candidate.setDate(candidate.getDate() + 1);
      candidate.setHours(8, 0, 0, 0);
      continue;
    }

    // Check overlap with busy blocks
    let hasOverlap = false;
    for (const b of busy) {
      if (candidate.getTime() < b.end.getTime() && end.getTime() > b.start.getTime()) {
        hasOverlap = true;
        // Optimization: jump candidate to the end of this busy block
        candidate = new Date(b.end.getTime());
        // Round to next 30 mins
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

  // Fallback: schedule starting from now
  return {
    start: startFrom,
    end: new Date(startFrom.getTime() + durationMs)
  };
}
