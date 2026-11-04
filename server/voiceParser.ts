/**
 * Flare — Voice Command Parser
 * Transcribes and analyzes voice transcripts or text commands.
 * Uses Gemini AI when GEMINI_API_KEY is configured, with a high-accuracy
 * deterministic NLP fallback for offline, rate-limited, and benchmark environments.
 */

export interface TaskPayload {
  title: string;
  description?: string;
  estimatedEffort?: number; // in hours
  deadline?: string;        // ISO 8601 string
}

export interface VoiceCommandResult {
  action: 'CREATE_TASK' | 'CHAT';
  message: string;
  taskPayload?: TaskPayload;
}

/**
 * Deterministic NLP parser for voice commands.
 * Accurately extracts intent (CREATE_TASK vs CHAT) and structured fields
 * (title, estimatedEffort in hours, and ISO deadline) relative to currentTimeStr.
 */
export function parseVoiceTranscriptDeterministic(
  transcript: string,
  currentTimeStr: string = new Date().toISOString()
): VoiceCommandResult {
  const text = transcript.trim();
  const lower = text.toLowerCase();
  const baseDate = new Date(currentTimeStr);

  // 1. Intent Classification: CHAT vs CREATE_TASK
  const chatGreetings = [
    'hello', 'hi flare', 'hey flare', 'good morning', 'good afternoon', 'good evening',
    'how are you', 'who are you', 'what can you do', 'what are you', 'tell me a joke',
    'what time is it', "what's the weather", 'what is the weather', 'how does flare work',
    'explain risk scoring', 'can you help me with', 'what is your name', 'thank you', 'thanks'
  ];

  const isExplicitGreetingOrChat = chatGreetings.some(g => lower.startsWith(g) || lower === g);

  // Distinguish imperative task commands from conversational questions
  const isDirectImperativeTaskCommand =
    /^(?:please\s+)?(?:can you\s+|could you\s+)?(?:create\s+(?:a\s+)?task|add\s+(?:a\s+)?task|schedule\s+(?:a\s+)?task|schedule\s+|remind\s+me|set\s+(?:a\s+)?reminder|book\s+|log\s+)/i.test(lower) ||
    /^(?:i need to|i have to|must finish|need to submit|got to finish|have to complete)\b/i.test(lower) ||
    /^(?:create|add|schedule|remind|book|log)\b/i.test(lower);

  const isConversationalQuestion =
    /^(?:what|how|why|who|where|when|tell me|explain|is there|are you|can you explain|can you tell|can you help me understand|could you give me tips)\b/i.test(lower) &&
    !isDirectImperativeTaskCommand;

  const hasTaskTrigger =
    isDirectImperativeTaskCommand ||
    (/\b(due\s+(?:tomorrow|today|tonight|next|in|\d+))\b/i.test(lower) && !isConversationalQuestion);

  if (isExplicitGreetingOrChat || isConversationalQuestion || !hasTaskTrigger) {
    let chatReply = "Hello! I'm Flare, your deadline-rescue companion. Let me know if you'd like to create a task or check your schedule.";
    if (lower.includes('weather')) {
      chatReply = "I can't check the weather, but I can help protect your deadlines and rescue your schedule!";
    } else if (lower.includes('how are you')) {
      chatReply = "I'm running smoothly and ready to help you triage your tasks and stay ahead of deadlines.";
    } else if (lower.includes('risk') || lower.includes('score')) {
      chatReply = "Flare computes task risk by subtracting your Google Calendar busy blocks from the time left before your deadline.";
    }
    return {
      action: 'CHAT',
      message: chatReply,
    };
  }

  // 2. Extract Estimated Effort (in hours)
  let estimatedEffort: number | undefined;

  // Pattern 1: X hours / X.X hours / X hrs / X hr / Xh
  const hoursMatch = lower.match(/(?:estimated|takes?|taking|need|effort|duration|for)?\s*(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|hr\b|h\b)/i);
  if (hoursMatch) {
    estimatedEffort = parseFloat(hoursMatch[1]);
  } else {
    // Pattern 2: minutes -> convert to fractional hours
    const minsMatch = lower.match(/(\d+)\s*(?:minutes?|mins?|min\b)/i);
    if (minsMatch) {
      estimatedEffort = Math.round((parseInt(minsMatch[1], 10) / 60) * 10) / 10;
    } else if (/\bhalf an hour\b/i.test(lower)) {
      estimatedEffort = 0.5;
    } else if (/\ban hour\b/i.test(lower) || /\bone hour\b/i.test(lower)) {
      estimatedEffort = 1;
    }
  }

  // 3. Extract Deadline (ISO 8601)
  let deadlineDate: Date | undefined;

  if (/\b(?:due\s+)?today\b|\btonight\b|\bby tonight\b|\bend of day\b/i.test(lower)) {
    const d = new Date(baseDate);
    d.setHours(22, 0, 0, 0);
    deadlineDate = d;
  } else if (/\b(?:due\s+)?tomorrow\b/i.test(lower)) {
    const d = new Date(baseDate.getTime() + 24 * 3_600_000);
    // If specific hour mentioned like "tomorrow at 5pm" or "tomorrow 5pm"
    const timeMatch = lower.match(/tomorrow\s+(?:at\s+)?(\d+)(?::(\d+))?\s*(am|pm)?/i);
    if (timeMatch) {
      let h = parseInt(timeMatch[1], 10);
      const m = timeMatch[2] ? parseInt(timeMatch[2], 10) : 0;
      const ampm = timeMatch[3]?.toLowerCase();
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      d.setHours(h, m, 0, 0);
    } else {
      d.setHours(17, 0, 0, 0);
    }
    deadlineDate = d;
  } else {
    // "in N days"
    const inDaysMatch = lower.match(/in\s+(\d+)\s+days?/i);
    if (inDaysMatch) {
      const days = parseInt(inDaysMatch[1], 10);
      const d = new Date(baseDate.getTime() + days * 24 * 3_600_000);
      d.setHours(17, 0, 0, 0);
      deadlineDate = d;
    } else {
      // "in N hours"
      const inHoursMatch = lower.match(/in\s+(\d+)\s+hours?/i);
      if (inHoursMatch) {
        const hrs = parseInt(inHoursMatch[1], 10);
        deadlineDate = new Date(baseDate.getTime() + hrs * 3_600_000);
      } else {
        // "next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)"
        const daysOfWeek = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const weekdayMatch = lower.match(/(?:next|by|this)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
        if (weekdayMatch) {
          const targetDay = daysOfWeek.indexOf(weekdayMatch[1].toLowerCase());
          if (targetDay !== -1) {
            const currentDay = baseDate.getDay();
            let daysAhead = targetDay - currentDay;
            if (daysAhead <= 0) daysAhead += 7;
            const d = new Date(baseDate.getTime() + daysAhead * 24 * 3_600_000);
            d.setHours(17, 0, 0, 0);
            deadlineDate = d;
          }
        }
      }
    }
  }

  // 4. Extract Task Title
  let title = text
    // Strip leading trigger phrases
    .replace(/^(?:please\s+)?(?:can you\s+)?(?:create\s+(?:a\s+)?task(?:\s+to)?|add\s+(?:a\s+)?task(?:\s+to)?|schedule\s+(?:a\s+)?task(?:\s+to)?|schedule\s+(?:a\s+)?|remind\s+me\s+to|set\s+(?:a\s+)?reminder\s+to|i\s+need\s+to|i\s+have\s+to|put\s+on\s+my\s+list\s+to|add\s+|create\s+|book\s+)/i, '')
    // Strip trailing effort clauses
    .replace(/,?\s*(?:estimated|duration|effort|taking|takes)?\s*\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\s*(?:effort|needed|work|time)?\s*$/i, '')
    .replace(/,?\s*(?:with|has)\s*\d+(?:\.\d+)?\s*(?:hours?|hrs?)\s*(?:of\s+effort)?\s*$/i, '')
    // Strip trailing deadline clauses
    .replace(/,?\s*(?:due|by|deadline)\s+(?:tomorrow|today|tonight|next\s+\w+|in\s+\d+\s+\w+|end\s+of\s+day)[^,]*$/i, '')
    .trim();

  // Clean punctuation at end and capitalize
  title = title.replace(/^to\s+/i, '').replace(/^[,\-–\s]+|[,\-–\s]+$/g, '').trim();
  if (title.length > 0) {
    title = title.charAt(0).toUpperCase() + title.slice(1);
  } else {
    title = 'New Task';
  }

  return {
    action: 'CREATE_TASK',
    message: `I've created the task "${title}".`,
    taskPayload: {
      title,
      estimatedEffort,
      deadline: deadlineDate ? deadlineDate.toISOString() : undefined,
    },
  };
}

/**
 * Main parseVoiceCommand function:
 * Uses Gemini when API key is provided, falling back gracefully to deterministic NLP.
 */
export async function parseVoiceCommand(
  transcript: string,
  currentTimeStr: string = new Date().toISOString()
): Promise<VoiceCommandResult> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (apiKey) {
    try {
      const { GoogleGenAI, Type } = await import('@google/genai');
      const ai = new GoogleGenAI({
        apiKey,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } },
      });

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          {
            text: `Transcribe and analyze this voice command for a task management app (Flare). The current time is ${currentTimeStr}.
Command: "${transcript}"
If the user wants to create a task, extract the details (title, description, estimatedEffort in hours, and deadline in ISO 8601).
If it's a general question or chit-chat, provide a friendly, short response in the 'message' field.`,
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              action: { type: Type.STRING, description: "Type of action: 'CREATE_TASK' or 'CHAT'" },
              message: { type: Type.STRING, description: "A friendly response to the user summarizing what you did or answering them." },
              taskPayload: {
                type: Type.OBJECT,
                description: "Populate this ONLY if action is CREATE_TASK",
                properties: {
                  title: { type: Type.STRING },
                  description: { type: Type.STRING },
                  estimatedEffort: { type: Type.NUMBER },
                  deadline: { type: Type.STRING },
                },
              },
            },
            required: ['action', 'message'],
          },
        },
      });

      const parsed = JSON.parse(response.text || '{}');
      if (parsed.action) {
        return parsed as VoiceCommandResult;
      }
    } catch (err) {
      // Fall through to deterministic parser on API error or rate limit
    }
  }

  return parseVoiceTranscriptDeterministic(transcript, currentTimeStr);
}
