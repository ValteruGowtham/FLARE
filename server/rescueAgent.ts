import { dbAdmin, authAdmin } from './firebaseAdmin.js';
import { evaluateTaskRisk } from './riskScorer.js';
import { findNextFreeSlot, calculateAvailableHours } from '../src/sharedUtils.js';
import { GoogleGenAI, Type } from '@google/genai';

/**
 * Checks if the current hour in the user's timezone (America/Los_Angeles) is within quiet hours (10pm - 7am)
 */
export function isQuietHours(): boolean {
  try {
    const pacificStr = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
    const pacificDate = new Date(pacificStr);
    const hour = pacificDate.getHours();
    return hour >= 22 || hour < 7;
  } catch (error) {
    console.error('Failed to parse America/Los_Angeles time, falling back to UTC:', error);
    const hourUtc = new Date().getUTCHours();
    // UTC equivalent of Pacific 10pm-7am (offset is roughly UTC-7 or UTC-8)
    const pacificHour = (hourUtc - 7 + 24) % 24;
    return pacificHour >= 22 || pacificHour < 7;
  }
}

/**
 * Expose function to securely store Google tokens server-side
 */
export async function storeUserGoogleTokens(userId: string, tokens: { refresh_token?: string; access_token: string; scope: string }) {
  const tokenDocRef = dbAdmin.collection('user_tokens').doc(userId);
  const dataToSave: any = {
    accessToken: tokens.access_token,
    scopes: tokens.scope.split(' '),
    updatedAt: new Date().toISOString()
  };
  
  if (tokens.refresh_token) {
    dataToSave.refreshToken = tokens.refresh_token;
  }
  
  await tokenDocRef.set(dataToSave, { merge: true });
}

/**
 * Helper to refresh Google access token using stored refresh token
 */
export async function refreshGoogleAccessToken(refreshToken: string): Promise<string> {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID || '',
      client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    })
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to refresh Google access token: ${response.statusText} - ${errorText}`);
  }
  
  const data = await response.json();
  return data.access_token;
}

/**
 * Fetch busy intervals from Google Calendar
 */
async function fetchFreeBusyServer(
  accessToken: string,
  timeMin: string,
  timeMax: string
): Promise<Array<{ start: string; end: string }>> {
  const response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      timeMin,
      timeMax,
      items: [{ id: 'primary' }]
    })
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch calendar freebusy on server: ${response.statusText}`);
  }

  const data = await response.json();
  return data.calendars?.primary?.busy || [];
}

/**
 * Create a calendar event on the primary calendar
 */
async function createCalendarEventServer(
  accessToken: string,
  title: string,
  start: Date,
  end: Date,
  description?: string
): Promise<{ id: string; htmlLink: string }> {
  const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      summary: `[Flare Block] ${title}`,
      description: description || 'Scheduled autonomously by Flare AI Rescue Agent Sweep.',
      start: { dateTime: start.toISOString() },
      end: { dateTime: end.toISOString() }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to create calendar event on server: ${response.statusText} - ${errorText}`);
  }

  const data = await response.json();
  return {
    id: data.id,
    htmlLink: data.htmlLink
  };
}

/**
 * Send an email via Gmail API
 */
export async function sendEmailServer(accessToken: string, to: string, subject: string, bodyText: string, from?: string) {
  const emailLines = [
    ...(from ? [`From: ${from}`] : []),
    `To: ${to}`,
    `Subject: ${subject}`,
    `Content-Type: text/html; charset=utf-8`,
    `MIME-Version: 1.0`,
    '',
    bodyText
  ];
  const emailStr = emailLines.join('\r\n');
  const raw = Buffer.from(emailStr)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  const response = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ raw })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to send email via Gmail API: ${response.statusText} - ${errorText}`);
  }
}

// Track if email generation is in rate limit cooldown
let isEmailRateLimitedUntil = 0;

/**
 * Generate reschedule draft email using Gemini (if available) or fallback
 */
async function generateRescheduleDraft(task: any, userEmail: string): Promise<{ subject: string; body: string }> {
  const fallbackSubject = `Request for Extension: ${task.title}`;
  const fallbackBody = `Dear recipient,<br/><br/>I am writing to request a brief extension for the task <strong>"${task.title}"</strong>, which is currently due on ${new Date(task.deadline).toLocaleString()}.<br/><br/>Due to unexpected scheduling conflicts and a highly packed schedule, I require a small adjustment to ensure the highest quality of work is delivered.<br/><br/>Thank you for your time and consideration.<br/><br/>Best regards,<br/>[Your Name]`;

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || Date.now() < isEmailRateLimitedUntil) {
    return { subject: fallbackSubject, body: fallbackBody };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const prompt = `
You are the AI triage engine of Flare, a deadline-rescue companion.
Generate a professional, polite, and persuasive email requesting a brief reschedule or extension for a task that has a deadline collision.
The user's calendar is completely packed and no free slots exist before the deadline.

Task Title: "${task.title}"
Task Description: "${task.description || 'No description provided'}"
Current Deadline: ${task.deadline}
Category: ${task.category}
User Email: ${userEmail}

Write a professional email subject and a complete, polite body. 
The email should be written from the user to their manager, instructor, or stakeholder.
Include placeholders like [Name] where appropriate. Keep it concise, professional, and empathetic. Use HTML line breaks (<br/>) for formatting.

Return a JSON object with 'subject' and 'body' fields.
`;
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: prompt,
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            subject: { type: Type.STRING },
            body: { type: Type.STRING }
          },
          required: ['subject', 'body']
        }
      }
    });

    const result = JSON.parse(response.text?.trim() || '{}');
    return {
      subject: result.subject || fallbackSubject,
      body: result.body || fallbackBody
    };
  } catch (error: any) {
    const errStr = String(error?.message || error);
    if (errStr.includes('429') || errStr.includes('RESOURCE_EXHAUSTED') || errStr.includes('quota') || errStr.includes('Quota')) {
      isEmailRateLimitedUntil = Date.now() + 5 * 60 * 1000; // 5 minute cooldown
      console.warn(`[Quota Fallback] Gemini API Quota exceeded. Skipping AI email generation for 5 minutes. Fallback to standard email active. Details: ${errStr}`);
    } else {
      console.error('Failed to generate reschedule draft with Gemini, using fallback:', error);
    }
    return { subject: fallbackSubject, body: fallbackBody };
  }
}

/**
 * Main Autonomous Sweep Function
 * Processes a single user's active tasks: re-evaluates risk scores,
 * auto-schedules calendar blocks for Critical tasks, and sends Gmail
 * notifications / extension draft emails as needed.
 */
export async function runAutonomousSweep(
  userId: string,
  userEmail: string,
  freshAccessToken: string,
  activeTasks: any[]
) {
  const logs: string[] = [];

  // --- Guard: validate required parameters ---
  if (!userId || typeof userId !== 'string') {
    logs.push('Sweep aborted: missing or invalid userId.');
    return { status: 'error', logs, taskUpdatesMap: {} };
  }
  if (!freshAccessToken || typeof freshAccessToken !== 'string') {
    logs.push(`Sweep aborted for user ${userId}: no valid Google access token provided.`);
    return { status: 'error', logs, taskUpdatesMap: {} };
  }
  if (!Array.isArray(activeTasks)) {
    logs.push(`Sweep aborted for user ${userId}: activeTasks must be an array.`);
    return { status: 'error', logs, taskUpdatesMap: {} };
  }

  logs.push(`Sweep started at: ${new Date().toISOString()}`);

  const quietMode = isQuietHours();
  logs.push(`Quiet hours checking: ${quietMode ? 'Active (emails queued)' : 'Inactive (emails will send immediately)'}`);

  logs.push(`Processing user ${userId}...`);
  const taskUpdatesMap: Record<string, any> = {};

  try {
    if (activeTasks.length === 0) {
      logs.push(`User ${userId}: No active tasks to process.`);
      return { status: 'success', logs, taskUpdatesMap };
    }

    // 4. Determine furthest deadline to bound calendar fetch
    const now = new Date();
    let furthestDeadline = new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000); // default 15 days out
    activeTasks.forEach((t: any) => {
      if (t.deadline) {
        const dl = new Date(t.deadline);
        if (dl.getTime() > furthestDeadline.getTime()) {
          furthestDeadline = dl;
        }
      }
    });

    // Add 2 extra days margin
    furthestDeadline.setDate(furthestDeadline.getDate() + 2);

    // 5. Fetch free/busy intervals from Google Calendar
    let calendarBusyIntervals: Array<{ start: string; end: string }> = [];
    try {
      calendarBusyIntervals = await fetchFreeBusyServer(freshAccessToken, now.toISOString(), furthestDeadline.toISOString());
      logs.push(`User ${userId}: Fetched ${calendarBusyIntervals.length} busy intervals from Google Calendar.`);
    } catch (calErr: any) {
      logs.push(`User ${userId}: Error fetching Google Calendar: ${calErr.message}`);
    }

    // 6. Build the initial busy intervals map
    const busyIntervalsList = [...calendarBusyIntervals];
    activeTasks.forEach((t: any) => {
      if (t.busyIntervals && Array.isArray(t.busyIntervals)) {
        t.busyIntervals.forEach((bi: any) => {
          if (!busyIntervalsList.some(exist => exist.start === bi.start && exist.end === bi.end)) {
            busyIntervalsList.push(bi);
          }
        });
      }
    });

    // 7. Loop through active tasks and re-evaluate risk scores
    for (const task of activeTasks) {
      const taskInput = {
        title: task.title,
        description: task.description,
        deadline: task.deadline,
        estimatedEffort: task.estimatedEffort,
        category: task.category,
        status: task.status,
        busyIntervals: busyIntervalsList
      };

      const reEvaluation = await evaluateTaskRisk(taskInput, now.toISOString());
      
      let updatedRiskScore = reEvaluation.riskScore;
      let updatedRiskReasoning = reEvaluation.reasoning;

      const crossedIntoCritical = updatedRiskScore === 'Critical' && task.riskScore !== 'Critical';
      const needsScheduling = crossedIntoCritical && !task.scheduledEventId && !task.autoScheduled;

      const taskUpdates: any = {};

      if (task.riskScore !== updatedRiskScore || task.riskReasoning !== updatedRiskReasoning) {
        taskUpdates.riskScore = updatedRiskScore;
        taskUpdates.riskReasoning = updatedRiskReasoning;
        taskUpdates.updatedAt = now.toISOString();
      }

      if (needsScheduling) {
        logs.push(`User ${userId}: Task "${task.title}" crossed into CRITICAL. Attempting scheduling.`);
        const slot = findNextFreeSlot(busyIntervalsList, task.estimatedEffort, now);
        const deadlineDate = new Date(task.deadline);

        if (slot.end.getTime() <= deadlineDate.getTime()) {
          try {
            const eventDescription = `Auto-blocked by Flare AI. This task was evaluated at high risk of deadline failure.\nReasoning: ${updatedRiskReasoning}`;
            const event = await createCalendarEventServer(
              freshAccessToken,
              task.title,
              slot.start,
              slot.end,
              eventDescription
            );

            const formattedStart = slot.start.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const formattedEnd = slot.end.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
            const formattedDate = slot.start.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

            taskUpdates.scheduledEventId = event.id;
            taskUpdates.scheduledEventLink = event.htmlLink;
            taskUpdates.autoScheduled = true;
            taskUpdates.busyIntervals = [
              ...(task.busyIntervals || []),
              { start: slot.start.toISOString(), end: slot.end.toISOString() }
            ];
            taskUpdates.updatedAt = now.toISOString();

            busyIntervalsList.push({
              start: slot.start.toISOString(),
              end: slot.end.toISOString()
            });

            logs.push(`User ${userId}: Successfully auto-scheduled "${task.title}" for ${formattedDate} @ ${formattedStart} - ${formattedEnd}.`);

            if (quietMode) {
              logs.push(`User ${userId}: Quiet hours active. Notification queued for morning.`);
            } else {
              const emailSubject = `[Flare Alert] Critical task scheduled: "${task.title}"`;
              const emailBody = `
                <div style="font-family: Arial, sans-serif; max-width: 600px; border: 1px solid #e5e7eb; padding: 24px; border-radius: 8px;">
                  <h2 style="color: #dc2626; margin-top: 0;">Flare Alert: Deadline Rescue Action Taken</h2>
                  <p>Hello,</p>
                  <p>Your task <strong>"${task.title}"</strong> was evaluated at critical risk of missing its deadline.</p>
                  <p>To rescue your deadline, Flare has auto-blocked a dedicated work session on your Google Calendar:</p>
                  <div style="background-color: #f3f4f6; padding: 16px; border-radius: 6px; margin: 16px 0;">
                    <strong>Date:</strong> ${formattedDate}<br/>
                    <strong>Time:</strong> ${formattedStart} - ${formattedEnd}<br/>
                    <strong>Reasoning:</strong> ${updatedRiskReasoning}
                  </div>
                  <p><a href="${event.htmlLink}" style="background-color: #2563eb; color: #ffffff; padding: 10px 18px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;" target="_blank">View in Google Calendar</a></p>
                  <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">This is an automated promise-guarantor message from Flare.</p>
                </div>
              `;
              await sendEmailServer(freshAccessToken, userEmail, emailSubject, emailBody, userEmail);
              taskUpdates.lastNotifiedAt = now.toISOString();
              logs.push(`User ${userId}: Notification email sent successfully.`);
            }
          } catch (schedErr: any) {
            logs.push(`User ${userId}: Failed to schedule "${task.title}": ${schedErr.message}`);
          }
        } else {
          logs.push(`User ${userId}: No free slot found for "${task.title}" before the deadline. Creating draft extension request.`);
          try {
            const draft = await generateRescheduleDraft(task, userEmail);
            taskUpdates.draftRescheduleEmailSubject = draft.subject;
            taskUpdates.draftRescheduleEmailBody = draft.body;
            taskUpdates.updatedAt = now.toISOString();
            taskUpdates.lastNotifiedAt = now.toISOString();
            logs.push(`User ${userId}: Generated extension draft and updated task model.`);
          } catch (draftErr: any) {
            logs.push(`User ${userId}: Failed to generate draft reschedule: ${draftErr.message}`);
          }
        }
      } else if (task.autoScheduled && !task.lastNotifiedAt && !quietMode) {
        try {
          logs.push(`User ${userId}: Sending queued morning notification for "${task.title}".`);
          const lastInterval = task.busyIntervals?.[task.busyIntervals.length - 1];
          const startDt = lastInterval ? new Date(lastInterval.start) : now;
          const endDt = lastInterval ? new Date(lastInterval.end) : now;
          const formattedStart = startDt.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          const formattedEnd = endDt.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
          const formattedDate = startDt.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

          const emailSubject = `[Flare Alert] Critical task scheduled: "${task.title}"`;
          const emailBody = `
            <div style="font-family: Arial, sans-serif; max-width: 600px; border: 1px solid #e5e7eb; padding: 24px; border-radius: 8px;">
              <h2 style="color: #dc2626; margin-top: 0;">Flare Alert: Deadline Rescue Action Taken</h2>
              <p>Hello,</p>
              <p>Your task <strong>"${task.title}"</strong> was evaluated at critical risk of missing its deadline.</p>
              <p>To rescue your deadline, Flare has auto-blocked a dedicated work session on your Google Calendar:</p>
              <div style="background-color: #f3f4f6; padding: 16px; border-radius: 6px; margin: 16px 0;">
                <strong>Date:</strong> ${formattedDate}<br/>
                <strong>Time:</strong> ${formattedStart} - ${formattedEnd}<br/>
                <strong>Reasoning:</strong> ${task.riskReasoning}
              </div>
              ${task.scheduledEventLink ? `<p><a href="${task.scheduledEventLink}" style="background-color: #2563eb; color: #ffffff; padding: 10px 18px; text-decoration: none; border-radius: 4px; display: inline-block; font-weight: bold;" target="_blank">View in Google Calendar</a></p>` : ''}
              <p style="color: #6b7280; font-size: 12px; margin-top: 24px;">This is an automated promise-guarantor message from Flare.</p>
            </div>
          `;
          await sendEmailServer(freshAccessToken, userEmail, emailSubject, emailBody, userEmail);
          taskUpdates.lastNotifiedAt = now.toISOString();
          taskUpdates.updatedAt = now.toISOString();
          logs.push(`User ${userId}: Queued morning notification email sent successfully.`);
        } catch (qErr: any) {
          logs.push(`User ${userId}: Failed to send morning queued email: ${qErr.message}`);
        }
      }

      if (Object.keys(taskUpdates).length > 0) {
        taskUpdatesMap[task.id] = taskUpdates;
      }
    }
  } catch (userErr: any) {
    logs.push(`Error processing user ${userId}: ${userErr.message}`);
  }

  logs.push(`Sweep completed successfully.`);
  return { status: 'success', logs, taskUpdatesMap };
}
