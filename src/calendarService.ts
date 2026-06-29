import { auth, googleProvider } from './firebase.js';
import { mergeIntervals, calculateAvailableHours, findNextFreeSlot, BusyInterval } from './sharedUtils.js';

let cachedAccessToken: string | null = typeof window !== 'undefined' ? localStorage.getItem('google_calendar_access_token') : null;

export type { BusyInterval };
export { mergeIntervals, calculateAvailableHours, findNextFreeSlot };

async function getAuthHeaders(): Promise<HeadersInit> {
  const token = await auth.currentUser?.getIdToken();
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

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
 * Read the user's stored Google OAuth tokens from Firestore.
 * Prefers Firestore (kept fresh by server-side refresh flows) over the local
 * cache. Falls back to `localFallbackToken` only when Firestore has nothing.
 */
async function getStoredGoogleTokens(
  localFallbackToken?: string | null
): Promise<{ accessToken: string; refreshToken: string }> {
  const result = { accessToken: '', refreshToken: '' };
  try {
    const { db } = await import('./firebase');
    const { doc, getDoc, setDoc } = await import('firebase/firestore');
    if (auth.currentUser) {
      const tokenDoc = await getDoc(doc(db, 'user_tokens', auth.currentUser.uid));
      if (tokenDoc.exists()) {
        const data = tokenDoc.data();
        // Prefer Firestore token — the server keeps it refreshed via auto-refresh.
        // Only fall back to local cache when Firestore has no accessToken yet.
        result.accessToken = data.accessToken || localFallbackToken || '';
        result.refreshToken = data.refreshToken || '';
      } else if (localFallbackToken) {
        // No Firestore record yet — bootstrap it from the local cache.
        result.accessToken = localFallbackToken;
        await setDoc(
          doc(db, 'user_tokens', auth.currentUser.uid),
          { accessToken: localFallbackToken, updatedAt: new Date().toISOString() },
          { merge: true }
        ).catch(console.error);
      }
    }
  } catch (e) {
    console.warn('[calendarService] Failed to read Google tokens from Firestore:', e);
    result.accessToken = localFallbackToken || '';
  }
  return result;
}

/**
 * Persist a newly server-refreshed access token to both localStorage and Firestore.
 */
async function persistRefreshedToken(newToken: string): Promise<void> {
  setCachedAccessToken(newToken);
  try {
    const { db } = await import('./firebase');
    const { doc, setDoc } = await import('firebase/firestore');
    if (auth.currentUser) {
      await setDoc(
        doc(db, 'user_tokens', auth.currentUser.uid),
        { accessToken: newToken, updatedAt: new Date().toISOString() },
        { merge: true }
      );
    }
  } catch (e) {
    console.warn('[calendarService] Failed to persist refreshed token to Firestore:', e);
  }
}

/**
 * Clear only the expired access token from cache and Firestore.
 * Deliberately preserves the refreshToken so the server can still recover
 * without requiring the user to re-authorize from scratch.
 */
async function clearExpiredAccessToken(): Promise<void> {
  setCachedAccessToken(null);
  try {
    const { db } = await import('./firebase');
    const { doc, setDoc } = await import('firebase/firestore');
    if (auth.currentUser) {
      await setDoc(
        doc(db, 'user_tokens', auth.currentUser.uid),
        { accessToken: '', updatedAt: new Date().toISOString() },
        { merge: true }
      );
    }
  } catch (e) {
    console.warn('[calendarService] Failed to clear expired access token from Firestore:', e);
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
    const headers = await getAuthHeaders();
    const response = await fetch(`/api/auth/google/url?userId=${encodeURIComponent(userId)}`, {
      headers
    });
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

    // 3. Wait for the popup to complete and poll the status endpoint
    return new Promise<string>((resolve, reject) => {
      let isResolved = false;
      const handleSuccess = (accessToken: string, refreshToken?: string, scopes?: string) => {
        if (isResolved) return;
        isResolved = true;
        setCachedAccessToken(accessToken);
        
        // Store the tokens securely in Firestore using the client SDK
        import('./firebase').then(({ db }) => {
          import('firebase/firestore').then(({ doc, setDoc }) => {
            const tokenDocRef = doc(db, 'user_tokens', userId);
            const dataToSave: any = {
              accessToken: accessToken,
              scopes: (scopes || '').split(' '),
              updatedAt: new Date().toISOString()
            };
            if (refreshToken) {
              dataToSave.refreshToken = refreshToken;
            }
            setDoc(tokenDocRef, dataToSave, { merge: true }).catch(err => {
              console.error("Failed to store Google tokens in Firestore:", err);
            });
          });
        });

        resolve(accessToken);
      };

      // Keep postMessage as a fallback in case COOP isn't an issue
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type === 'OAUTH_AUTH_SUCCESS') {
          window.removeEventListener('message', handleMessage);
          handleSuccess(event.data.accessToken, event.data.refreshToken, event.data.scopes);
        }
      };

      window.addEventListener('message', handleMessage);

      // Add polling interval
      const checkInterval = setInterval(async () => {
        if (isResolved) {
          clearInterval(checkInterval);
          window.removeEventListener('message', handleMessage);
          return;
        }

        try {
          const headers = await getAuthHeaders();
          const response = await fetch('/api/auth/google/status', { headers });
          if (response.ok) {
            const data = await response.json();
            if (data.success && data.tokens) {
              clearInterval(checkInterval);
              window.removeEventListener('message', handleMessage);
              
              // Close the popup ourselves if we got the tokens
              if (!authWindow.closed) {
                 authWindow.close();
              }
              handleSuccess(data.tokens.access_token, data.tokens.refresh_token, data.tokens.scope);
              return;
            }
          }
        } catch (e) {
          // ignore polling errors
        }

        if (authWindow.closed && !isResolved) {
          clearInterval(checkInterval);
          window.removeEventListener('message', handleMessage);
          reject(new Error('Sign-in window closed before authentication was completed.'));
        }
      }, 1000);
    });
  } catch (error) {
    console.error('Failed to connect calendar:', error);
    throw error;
  }
}

export async function disconnectCalendar(userId: string): Promise<void> {
  if (!userId) return;
  try {
    const headers = await getAuthHeaders();
    
    // Fetch token from client to revoke it
    let tokenToRevoke = '';
    const { db } = await import('./firebase');
    const { doc, getDoc, deleteDoc } = await import('firebase/firestore');
    const tokenDocRef = doc(db, 'user_tokens', userId);
    
    const tokenDoc = await getDoc(tokenDocRef);
    if (tokenDoc.exists()) {
      const data = tokenDoc.data();
      tokenToRevoke = data.refreshToken || data.accessToken;
      
      // Delete token from Firestore locally
      await deleteDoc(tokenDocRef);
    }

    if (tokenToRevoke) {
      const response = await fetch('/api/auth/google/revoke', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...headers
        },
        body: JSON.stringify({ tokenToRevoke })
      });
      if (!response.ok) {
        console.warn('Failed to revoke calendar token on server');
      }
    }
  } catch (error) {
    console.error('Error disconnecting calendar:', error);
  } finally {
    setCachedAccessToken(null);
  }
}

/**
 * Fetch busy slots from Google Calendar Free/Busy API via the server proxy.
 * Token priority: Firestore (server-refreshed) → localStorage fallback.
 */
export async function fetchFreeBusy(
  token: string | null,
  timeMin: string,
  timeMax: string
): Promise<BusyInterval[]> {
  try {
    const headers = await getAuthHeaders();
    const googleTokens = await getStoredGoogleTokens(token);

    if (!googleTokens.accessToken && !googleTokens.refreshToken) {
      return [];
    }

    const response = await fetch('/api/calendar/freebusy', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        timeMin,
        timeMax,
        googleAccessToken: googleTokens.accessToken,
        googleRefreshToken: googleTokens.refreshToken
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Only clear the expired accessToken — preserve the refreshToken so
        // the next server-side refresh attempt can still recover.
        await clearExpiredAccessToken();
        return [];
      }
      const errorText = await response.text();
      throw new Error(`FreeBusy proxy error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // Server auto-refreshed the token — persist the new one
    if (data.newAccessToken) {
      await persistRefreshedToken(data.newAccessToken);
    }

    return data.calendars?.primary?.busy || [];
  } catch (error) {
    console.error('[calendarService] Error in fetchFreeBusy:', error);
    throw error;
  }
}

/**
 * Create a calendar event on Google Calendar primary calendar via the server proxy.
 * Token priority: Firestore (server-refreshed) → localStorage fallback.
 */
export async function createCalendarEvent(
  token: string | null,
  title: string,
  start: Date,
  end: Date,
  description?: string
): Promise<{ id: string; htmlLink: string }> {
  try {
    const headers = await getAuthHeaders();
    const googleTokens = await getStoredGoogleTokens(token);

    if (!googleTokens.accessToken && !googleTokens.refreshToken) {
      throw new Error('Google Calendar not connected. Please connect via Settings.');
    }

    const response = await fetch('/api/calendar/event', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        summary: title,
        description: description || 'Scheduled via Flare AI Triage Engine',
        start: start.toISOString(),
        end: end.toISOString(),
        googleAccessToken: googleTokens.accessToken,
        googleRefreshToken: googleTokens.refreshToken
      })
    });

    if (!response.ok) {
      if (response.status === 401) {
        // Only clear the expired accessToken — preserve the refreshToken so
        // the next server-side refresh attempt can still recover.
        await clearExpiredAccessToken();
        throw new Error('Google Calendar session expired. Please reconnect via Settings.');
      }
      const errorText = await response.text();
      throw new Error(`Calendar event proxy error ${response.status}: ${errorText}`);
    }

    const data = await response.json();

    // Server auto-refreshed the token — persist the new one
    if (data.newAccessToken) {
      await persistRefreshedToken(data.newAccessToken);
    }

    return {
      id: data.id,
      htmlLink: data.htmlLink
    };
  } catch (error) {
    console.error('[calendarService] Error in createCalendarEvent:', error);
    throw error;
  }
}
