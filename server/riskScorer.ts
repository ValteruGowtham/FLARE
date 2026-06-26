import { GoogleGenAI, Type } from '@google/genai';
import { calculateAvailableHours } from '../src/sharedUtils.js';

// Initialize GoogleGenAI client on the server side
const apiKey = process.env.GEMINI_API_KEY;
const ai = apiKey ? new GoogleGenAI({
  apiKey,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
}) : null;

// Track if the API key is currently rate-limited or out of quota to avoid error spam
let isRateLimitedUntil = 0;

export interface TaskEvaluationInput {
  title: string;
  description?: string;
  deadline: string; // ISO format
  estimatedEffort: number; // hours
  category: string;
  status: string;
  busyIntervals?: Array<{ start: string; end: string }>;
}

export interface TaskEvaluationOutput {
  riskScore: 'Critical' | 'Urgent' | 'Stable';
  reasoning: string;
}

/**
 * Calculates a task's risk score and a short reasoning phrase.
 * If Gemini is available, uses the AI to combine context (title, description, category) with mathematics.
 * Otherwise, uses a math-based heuristic fallback.
 */
/**
 * Calculates a task's risk score and a short reasoning phrase.
 * Uses a robust, deterministic mathematical scheduling algorithm by default.
 * This guarantees instant, reliable, and zero-cost risk classification without reaching API quota limits.
 * If Gemini is explicitly requested and available, it can optionally refine the reasoning.
 */
export async function evaluateTaskRisk(
  task: TaskEvaluationInput,
  currentTimeStr: string
): Promise<TaskEvaluationOutput> {
  // Done tasks are always stable and on track
  if (task.status === 'done') {
    return {
      riskScore: 'Stable',
      reasoning: 'Task is complete.'
    };
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

  // ---- 1. Robust, Sophisticated Mathematical Scheduling Algorithm ----
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
    // We have a direct schedule deficit
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

  // If Gemini is disabled, rate-limited, or we want to guarantee deterministic safety, return immediately.
  // We prefer the deterministic algorithm because it is instant and always accurate.
  const preferDeterministic = true;
  if (preferDeterministic || !ai || Date.now() < isRateLimitedUntil) {
    return { riskScore, reasoning };
  }

  try {
    const prompt = `
You are the AI triage engine of Flare, a deadline-rescue companion.
Analyze this active task and determine its risk level ("Critical", "Urgent", or "Stable") and write a very short, elegant explanation note (max 18 words) explaining the math of actual available hours (time left minus calendar busy blocks) vs. effort required.

Current Time: ${currentTimeStr}
Task Title: "${task.title}"
Task Description: "${task.description || 'None'}"
Category: ${task.category}
Status: ${task.status}
Deadline: ${task.deadline} (${rawRemainingHours.toFixed(1)} hours raw time remaining)
Google Calendar Data: ${useCalendar ? `Yes, ${busyCount} calendar meetings overlap, leaving ${remainingHours.toFixed(1)} hours of actual available free time.` : 'No calendar data connected.'}
Estimated Effort: ${task.estimatedEffort} hours

Risk Category Rules (Use ACTUAL available hours if calendar data is available):
- "Critical": Effort exceeds or is very close to remaining hours, OR remaining hours <= 12, OR deadline has passed.
- "Urgent": Remaining hours <= 48 (due today or tomorrow) but has a feasible buffer, OR the buffer (remaining hours minus effort) is extremely tight (< 6 hours).
- "Stable": Ample time buffer (remaining hours > 48, and remaining hours minus effort is comfortable).

Reasoning guidelines:
- Must be friendly but crisp, conveying alert or calm.
- Mention estimated effort vs actual available hours if calendar is connected (e.g., "4.5h actually free [2 meetings in way] vs 6h needed").
- Maximum 18 words.
- Format like: "4.5h actually free (2 mtgs in way) vs. 6h needed — at risk" or "Stable 12h free buffer with no meetings."
`;

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            riskScore: {
              type: Type.STRING,
              description: "Must be exactly 'Critical', 'Urgent', or 'Stable'"
            },
            reasoning: {
              type: Type.STRING,
              description: "A short note explaining the calculation, maximum 18 words."
            }
          },
          required: ['riskScore', 'reasoning']
        }
      }
    });

    const textOutput = response.text?.trim() || '';
    const result = JSON.parse(textOutput);

    let finalRiskScore = result.riskScore;
    if (finalRiskScore !== 'Critical' && finalRiskScore !== 'Urgent' && finalRiskScore !== 'Stable') {
      finalRiskScore = riskScore;
    }

    return {
      riskScore: finalRiskScore,
      reasoning: result.reasoning || reasoning
    };
  } catch (error: any) {
    const errStr = String(error?.message || error);
    if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota') || errStr.includes('Quota')) {
      isRateLimitedUntil = Date.now() + 5 * 60 * 1000; // 5 minute cooldown
      console.warn(`[Quota Fallback] Gemini API Quota exceeded. Skipping AI risk scoring for 5 minutes. Fallback to heuristic active. Details: ${errStr}`);
    } else {
      console.error('Error in evaluateTaskRisk with Gemini:', error);
    }
    return { riskScore, reasoning };
  }
}
