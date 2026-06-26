import { auth, googleProvider } from './firebase.js';
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { mergeIntervals, calculateAvailableHours, findNextFreeSlot, BusyInterval } from './sharedUtils.js';

let cachedAccessToken: string | null = typeof window !== 'undefined' ? localStorage.getItem('google_calendar_access_token') : null;

export type { BusyInterval };
export { mergeIntervals, calculateAvailableHours, findNextFreeSlot };

export function getCachedAccessToken(): string | null {
  return cachedAccessToken;
}

export function setCachedAccessToken(token: string | null) {
  cachedAccessToken = token;
  if (typeof window !== 'undefined') {
    if (token) {
      localStorage.setItem('google_calendar_access_token', token);
    } else {
      localStorage.removeItem('google_calendar_access_token');
    }
  }
}

/**
 * Trigger Google Sign-In with Calendar scopes to connect/re-authenticate Google Calendar
 */
export async function connectCalendar(userId: string): Promise<string> {
  if (!userId) {
    throw new Error('Please sign in first to connect Google Calendar.');
  }

  try {
    // 1. Fetch the Google Auth URL from our server
    const response = await fetch(`/api/auth/google/url?userId=${encodeURIComponent(userId)}`);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to get OAuth URL from server: ${errorText}`);
    }
    const { url } = await response.json();

    // 2. Open the OAuth popup
    const authWindow = window.open(url, 'oauth_popup', 'width=600,height=700');
    if (!authWindow) {
      throw new Error('Popup blocked! Please allow popups for this site to connect Google Calendar.');
    }

    // 3. Wait for the popup to complete and send OAUTH_AUTH_SUCCESS message
    return new Promise<string>((resolve, reject) => {
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
          const token = event.data.accessToken;
          setCachedAccessToken(token);
          window.removeEventListener('message', handleMessage);
          resolve(token);
        }
      };

      window.addEventListener('message', handleMessage);

      // Add a simple interval to reject if popup is closed before success
      const checkClosedInterval = setInterval(() => {
        if (authWindow.closed) {
          clearInterval(checkClosedInterval);
          window.removeEventListener('message', handleMessage);
          reject(new Error('Sign-in window closed before authentication was completed.'));
        }
      }, 500);
    });
  } catch (error) {
    console.error('Failed to connect calendar:', error);
    throw error;
  }
}

/**
 * Fetch busy slots from Google Calendar Free/Busy API
 */
export async function fetchFreeBusy(
  accessToken: string,
  timeMin: string,
  timeMax: string
): Promise<BusyInterval[]> {
  try {
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
      throw new Error(`Failed to fetch freebusy: ${response.statusText}`);
    }

    const data = await response.json();
    const busy = data.calendars?.primary?.busy || [];
    return busy;
  } catch (error) {
    console.error('Error in fetchFreeBusy:', error);
    throw error;
  }
}

/**
 * Create a calendar event on Google Calendar primary calendar
 */
export async function createCalendarEvent(
  accessToken: string,
  title: string,
  start: Date,
  end: Date,
  description?: string
): Promise<{ id: string; htmlLink: string }> {
  try {
    const response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        summary: title,
        description: description || 'Scheduled via Flare AI Triage Engine',
        start: {
          dateTime: start.toISOString(),
        },
        end: {
          dateTime: end.toISOString(),
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to create calendar event: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return {
      id: data.id,
      htmlLink: data.htmlLink
    };
  } catch (error) {
    console.error('Error in createCalendarEvent:', error);
    throw error;
  }
}
