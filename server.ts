import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { evaluateTaskRisk, TaskEvaluationInput } from './server/riskScorer.js';
import { storeUserGoogleTokens, runAutonomousSweep, sendEmailServer, refreshGoogleAccessToken } from './server/rescueAgent.js';
import { dbAdmin, authAdmin } from './server/firebaseAdmin.js';
import type { QuerySnapshot, DocumentData } from 'firebase-admin/firestore';

// Authentication Middleware
const requireAuth = async (req: express.Request, res: express.Response, next: express.NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing or invalid token' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await authAdmin.verifyIdToken(token);
    (req as any).user = decodedToken;
    next();
  } catch (error) {
    // Intentionally generic error to not leak token states
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

async function startServer() {
  const app = express();
  const PORT = 3000;

  // Middleware for body parsing
  app.use(express.json());

  // API endpoint to evaluate a single task
  app.post('/api/evaluate', async (req, res) => {
    try {
      const { task, currentTime } = req.body;
      if (!task || !task.title || !task.deadline || task.estimatedEffort === undefined) {
        return res.status(400).json({ error: 'Missing required task fields (title, deadline, estimatedEffort)' });
      }

      const evalTime = currentTime || new Date().toISOString();
      const evaluation = await evaluateTaskRisk(task, evalTime);
      return res.json(evaluation);
    } catch (error: any) {
      console.error('API Error in /api/evaluate:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // API endpoint to evaluate a batch of tasks
  app.post('/api/evaluate-batch', async (req, res) => {
    try {
      const { tasks, currentTime } = req.body;
      if (!tasks || !Array.isArray(tasks)) {
        return res.status(400).json({ error: 'Missing tasks array' });
      }

      const evalTime = currentTime || new Date().toISOString();
      const evaluations: Array<{ id: string; riskScore: string; reasoning: string }> = [];

      // Process evaluations in parallel or small batches
      await Promise.all(
        tasks.map(async (taskWithId: any) => {
          const { id, ...taskData } = taskWithId;
          try {
            const result = await evaluateTaskRisk(taskData as TaskEvaluationInput, evalTime);
            evaluations.push({
              id,
              riskScore: result.riskScore,
              reasoning: result.reasoning
            });
          } catch (e) {
            console.error(`Failed to evaluate task ${id}:`, e);
          }
        })
      );

      return res.json({ evaluations });
    } catch (error: any) {
      console.error('API Error in /api/evaluate-batch:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  const pendingTokens = new Map<string, any>();

  // Google OAuth Status Polling Endpoint
  app.get('/api/auth/google/status', requireAuth, (req, res) => {
    try {
      const userId = (req as any).user.uid;
      if (pendingTokens.has(userId)) {
        const tokens = pendingTokens.get(userId);
        pendingTokens.delete(userId);
        return res.json({ success: true, tokens });
      }
      return res.json({ success: false });
    } catch (err: any) {
      return res.status(500).json({ error: err.message });
    }
  });

  // Google OAuth URL generation (Protected by auth middleware)
  app.get('/api/auth/google/url', requireAuth, (req, res) => {
    try {
      const userId = (req as any).user.uid;
      const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/google/callback`;
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || '',
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.send openid email profile',
        access_type: 'offline',
        prompt: 'consent',
        state: String(userId)
      });

      const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
      return res.json({ url: authUrl });
    } catch (err: any) {
      console.error('Failed to generate Auth URL:', err);
      return res.status(500).json({ error: err.message });
    }
  });

  // Google OAuth Callback Handler
  app.get('/api/auth/google/callback', async (req, res) => {
    const { code, state: userId } = req.query;
    if (!code || !userId) {
      return res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #fff5f5; color: #c53030;">
            <h2>Authentication Error</h2>
            <p>Missing auth code or userId state parameter.</p>
            <button onclick="window.close()" style="margin-top: 16px; padding: 8px 16px; background-color: #c53030; color: white; border: none; border-radius: 4px; cursor: pointer;">Close Window</button>
          </body>
        </html>
      `);
    }

    try {
      const redirectUri = `${process.env.APP_URL || 'http://localhost:3000'}/api/auth/google/callback`;
      const response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          code: String(code),
          client_id: process.env.GOOGLE_CLIENT_ID || '',
          client_secret: process.env.GOOGLE_CLIENT_SECRET || '',
          redirect_uri: redirectUri,
          grant_type: 'authorization_code'
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Token exchange failed: ${response.statusText} - ${errorText}`);
      }

      const tokens = await response.json();
      
      // Store in memory map for frontend polling
      pendingTokens.set(String(userId), tokens);

      // Instead of using dbAdmin (which lacks IAM permissions for this database),
      // we send the tokens back to the client via postMessage, and the client
      // will store them securely in its user_tokens/{userId} document.
      // await storeUserGoogleTokens(String(userId), tokens);

      // Send success message and postMessage to parent window
      return res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #f9f8f6; color: #1a1a1a;">
            <div style="text-align: center; border: 1px solid #e5e7eb; padding: 32px; border-radius: 8px; background: white; box-shadow: 0 4px 6px -1px rgb(0 0 0 / 0.1);">
              <h2 style="color: #10b981; margin-top: 0; margin-bottom: 12px;">OAuth Flow Completed!</h2>
              <p style="margin-bottom: 24px; font-size: 14px; color: #4b5563;">Your Google Calendar and Gmail Send scopes have been linked to Flare.</p>
              <p style="font-size: 12px; color: #9ca3af;">This window will close automatically in a moment...</p>
            </div>
            <script>
              try {
                if (window.opener) {
                  // Use JSON.stringify to safely encode token values — prevents JS syntax errors
                  // if any token value contains quotes, backslashes, or newline characters.
                  window.opener.postMessage({
                    type: 'OAUTH_AUTH_SUCCESS',
                    accessToken: ${JSON.stringify(tokens.access_token || '')},
                    refreshToken: ${JSON.stringify(tokens.refresh_token || '')},
                    scopes: ${JSON.stringify(tokens.scope || '')}
                  }, '*');
                }
              } catch (e) {
                console.error("Failed to post message to opener:", e);
              }
              setTimeout(function() {
                window.close();
              }, 2000);
            </script>
          </body>
        </html>
      `);
    } catch (error: any) {
      console.error("OAuth Callback Error:", error);
      return res.send(`
        <html>
          <body style="font-family: Arial, sans-serif; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; background-color: #fff5f5; color: #c53030;">
            <h2>Authentication Failed</h2>
            <p>${error.message || 'Error exchanging authorization code.'}</p>
            <button onclick="window.close()" style="margin-top: 16px; padding: 8px 16px; background-color: #c53030; color: white; border: none; border-radius: 4px; cursor: pointer;">Close Window</button>
          </body>
        </html>
      `);
    }
  });

  // Revoke Google OAuth Token
  app.post('/api/auth/google/revoke', requireAuth, async (req, res) => {
    try {
      const { tokenToRevoke } = req.body;
      if (tokenToRevoke) {
        // Call Google revocation endpoint
        await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
      }
      return res.json({ success: true });
    } catch (error: any) {
      console.error('Error revoking Google token:', error);
      return res.status(500).json({ error: 'Failed to revoke token' });
    }
  });

  // Account Deletion Endpoint
  app.post('/api/account/delete', requireAuth, async (req, res) => {
    try {
      const userId = (req as any).user.uid;
      const { tokenToRevoke } = req.body;
      
      // 1. Revoke Google OAuth Token if provided
      if (tokenToRevoke) {
        await fetch(`https://oauth2.googleapis.com/revoke?token=${tokenToRevoke}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        }).catch(err => console.error('Failed to revoke Google token during account deletion:', err));
      }
      
      // 2. Delete the user from Firebase Auth
      await authAdmin.deleteUser(userId);
      
      return res.json({ success: true });
    } catch (error: any) {
      console.error('Error deleting account:', error);
      return res.status(500).json({ error: 'Failed to delete account' });
    }
  });

  // Secure Autonomous Sweep endpoint (Cron trigger)
  // Loops all users via Firestore Admin, fetches their active tasks & tokens,
  // then calls runAutonomousSweep per user.
  app.post('/api/agent/sweep', async (req, res) => {
    try {
      const authHeader = req.headers['x-rescue-agent-key'];
      const expectedKey = process.env.RESCUE_AGENT_KEY || 'flare_secret_sweep_token_2026';

      if (!authHeader || authHeader !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid x-rescue-agent-key header' });
      }

      const allLogs: string[] = [];
      const allTaskUpdates: Record<string, any> = {};

      // 1. Fetch all user token documents to know which users have Google connected
      let tokenDocs: QuerySnapshot<DocumentData> | undefined;
      try {
        tokenDocs = await dbAdmin.collection('user_tokens').get();
      } catch (err: any) {
        console.error('[Cron Sweep] Failed to fetch user_tokens from Firestore Admin:', err);
        return res.status(500).json({ error: 'Failed to load user tokens: ' + err.message });
      }

      if (!tokenDocs || tokenDocs.empty) {
        allLogs.push('No users with connected Google accounts found. Sweep complete.');
        return res.json({ status: 'success', logs: allLogs, taskUpdatesMap: allTaskUpdates });
      }

      // 2. For each user, resolve their access token, fetch active tasks, and run sweep
      await Promise.all(tokenDocs.docs.map(async (tokenDoc) => {
        const userId = tokenDoc.id;
        const tokenData = tokenDoc.data();

        let accessToken: string = tokenData.accessToken || '';
        const refreshToken: string = tokenData.refreshToken || '';

        // Refresh the access token if we have a refresh token
        if (refreshToken) {
          try {
            accessToken = await refreshGoogleAccessToken(refreshToken);
            // Persist the refreshed token back to Firestore
            await dbAdmin.collection('user_tokens').doc(userId).set(
              { accessToken, updatedAt: new Date().toISOString() },
              { merge: true }
            );
          } catch (refreshErr: any) {
            allLogs.push(`[User ${userId}] Failed to refresh Google token: ${refreshErr.message}. Skipping.`);
            return;
          }
        }

        if (!accessToken) {
          allLogs.push(`[User ${userId}] No valid access token available. Skipping.`);
          return;
        }

        // Resolve the user's email from Firebase Auth
        let userEmail = '';
        try {
          const userRecord = await authAdmin.getUser(userId);
          userEmail = userRecord.email || '';
        } catch (authErr: any) {
          allLogs.push(`[User ${userId}] Failed to resolve user email: ${authErr.message}. Skipping.`);
          return;
        }

        // Fetch active (non-done) tasks for this user
        let activeTasks: any[] = [];
        try {
          const tasksSnap = await dbAdmin.collection('tasks')
            .where('userId', '==', userId)
            .where('status', '!=', 'done')
            .get();
          activeTasks = tasksSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        } catch (taskErr: any) {
          allLogs.push(`[User ${userId}] Failed to fetch tasks: ${taskErr.message}. Skipping.`);
          return;
        }

        // Run the autonomous sweep for this user
        try {
          const result = await runAutonomousSweep(userId, userEmail, accessToken, activeTasks);
          allLogs.push(...(result.logs || []));

          // Apply task updates to Firestore
          for (const [taskId, updates] of Object.entries(result.taskUpdatesMap || {})) {
            try {
              await dbAdmin.collection('tasks').doc(taskId).set(updates, { merge: true });
              allTaskUpdates[taskId] = updates;
            } catch (updateErr: any) {
              allLogs.push(`[User ${userId}] Failed to persist updates for task ${taskId}: ${updateErr.message}`);
            }
          }
        } catch (sweepErr: any) {
          allLogs.push(`[User ${userId}] Sweep error: ${sweepErr.message}`);
        }
      }));

      return res.json({ status: 'success', logs: allLogs, taskUpdatesMap: allTaskUpdates });
    } catch (error: any) {
      console.error('API Error in /api/agent/sweep:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Dev Sweep Trigger (Manual Trigger Endpoint for preview mode)
  app.post('/api/dev/sweep', requireAuth, async (req, res) => {
    try {
      const { userId, userEmail, googleAccessToken, googleRefreshToken, tasks } = req.body;

      if (!googleAccessToken && !googleRefreshToken) {
        return res.status(400).json({ error: 'Google account not connected.' });
      }

      let accessToken = googleAccessToken;
      let newAccessToken = null;
      if (googleRefreshToken) {
        try {
           accessToken = await refreshGoogleAccessToken(googleRefreshToken);
           newAccessToken = accessToken;
        } catch (e) {
           console.error("Failed to refresh token in sweep proxy", e);
        }
      }

      const result = await runAutonomousSweep(userId, userEmail, accessToken, tasks || []);
      
      const payload: any = { ...result };
      if (newAccessToken) {
        payload.newAccessToken = newAccessToken;
      }
      
      return res.json(payload);
    } catch (error: any) {
      console.error('API Error in /api/dev/sweep:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Calendar FreeBusy Proxy Endpoint
  app.post('/api/calendar/freebusy', requireAuth, async (req, res) => {
    try {
      const { timeMin, timeMax, googleAccessToken, googleRefreshToken } = req.body;
      
      if (!timeMin || !timeMax) {
        return res.status(400).json({ error: 'Missing timeMin or timeMax' });
      }

      if (!googleAccessToken && !googleRefreshToken) {
        return res.status(400).json({ error: 'Google account not connected.' });
      }

      let accessToken = googleAccessToken;
      let newAccessToken = null;

      let response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
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

      if (response.status === 401 && googleRefreshToken) {
        try {
           accessToken = await refreshGoogleAccessToken(googleRefreshToken);
           newAccessToken = accessToken;
           // Retry with new token
           response = await fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
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
        } catch (e) {
           console.error("Failed to refresh token in freebusy proxy", e);
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ error: `Google API Error: ${errorText}` });
      }

      const data = await response.json();
      if (newAccessToken) {
        data.newAccessToken = newAccessToken;
      }
      return res.json(data);
    } catch (error: any) {
      console.error('API Error in /api/calendar/freebusy:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Create Calendar Event Proxy Endpoint
  app.post('/api/calendar/event', requireAuth, async (req, res) => {
    try {
      const { summary, description, start, end, googleAccessToken, googleRefreshToken } = req.body;
      
      if (!summary || !start || !end) {
        return res.status(400).json({ error: 'Missing summary, start, or end' });
      }

      if (!googleAccessToken && !googleRefreshToken) {
        return res.status(400).json({ error: 'Google account not connected.' });
      }

      let accessToken = googleAccessToken;
      let newAccessToken = null;

      const eventPayload = {
        summary,
        description: description || 'Scheduled via Flare AI Triage Engine',
        start: { dateTime: start },
        end: { dateTime: end }
      };

      let response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(eventPayload)
      });

      if (response.status === 401 && googleRefreshToken) {
        try {
           accessToken = await refreshGoogleAccessToken(googleRefreshToken);
           newAccessToken = accessToken;
           // Retry with new token
           response = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
             method: 'POST',
             headers: {
               'Authorization': `Bearer ${accessToken}`,
               'Content-Type': 'application/json'
             },
             body: JSON.stringify(eventPayload)
           });
        } catch (e) {
           console.error("Failed to refresh token in event proxy", e);
        }
      }

      if (!response.ok) {
        const errorText = await response.text();
        return res.status(response.status).json({ error: `Google API Error: ${errorText}` });
      }

      const data = await response.json();
      if (newAccessToken) {
        data.newAccessToken = newAccessToken;
      }
      return res.json(data);
    } catch (error: any) {
      console.error('API Error in /api/calendar/event:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Send draft email endpoint
  app.post('/api/tasks/send-draft', requireAuth, async (req, res) => {
    try {
      const { draftSubject, draftBody, recipientEmail, googleAccessToken, googleRefreshToken } = req.body;
      
      if (!draftSubject || !draftBody) {
        return res.status(400).json({ error: 'Missing draft subject or body' });
      }

      if (!googleAccessToken && !googleRefreshToken) {
        return res.status(400).json({ error: 'Google account not connected.' });
      }

      let accessToken = googleAccessToken;
      let newAccessToken = null;

      let targetRecipient = recipientEmail || '';
      if (!targetRecipient) {
        return res.status(400).json({ error: 'Recipient email not specified.' });
      }

      try {
        await sendEmailServer(
          accessToken,
          targetRecipient,
          draftSubject,
          draftBody
        );
      } catch (err: any) {
        if (err.message.includes('401') && googleRefreshToken) {
           try {
              accessToken = await refreshGoogleAccessToken(googleRefreshToken);
              newAccessToken = accessToken;
              await sendEmailServer(
                accessToken,
                targetRecipient,
                draftSubject,
                draftBody
              );
           } catch (refreshErr) {
              throw err; // throw original
           }
        } else {
           throw err;
        }
      }

      return res.json({ status: 'success', newAccessToken });
    } catch (error: any) {
      console.error('Error sending draft email:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Voice Assistance Endpoint
  app.post('/api/voice', async (req, res) => {
    try {
      const { audioBase64, mimeType, currentTime } = req.body;
      if (!audioBase64 || !mimeType) {
        return res.status(400).json({ error: 'Missing audio data' });
      }

      const { GoogleGenAI, Type } = await import('@google/genai');
      const ai = new GoogleGenAI({ 
        apiKey: process.env.GEMINI_API_KEY,
        httpOptions: { headers: { 'User-Agent': 'aistudio-build' } }
      });
      
      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { inlineData: { data: audioBase64, mimeType } },
          { text: `Transcribe and analyze this voice command for a task management app (Flare). The current time is ${currentTime}. If the user wants to create a task, extract the details (title, description, estimatedEffort in hours, and deadline in ISO 8601). If it's a general question or chit-chat, provide a friendly, short response in the 'message' field.` }
        ],
        config: {
          responseMimeType: "application/json",
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
                  deadline: { type: Type.STRING }
                }
              }
            },
            required: ["action", "message"]
          }
        }
      });

      const result = JSON.parse(response.text);
      return res.json(result);
    } catch (error: any) {
      console.error('API Error in /api/voice:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Vite development server middleware setup
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://0.0.0.0:${PORT} in ${process.env.NODE_ENV || 'development'} mode`);
  });
}

startServer().catch((error) => {
  console.error('Failed to start server:', error);
});
