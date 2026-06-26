import express from 'express';
import path from 'path';
import { createServer as createViteServer } from 'vite';
import { evaluateTaskRisk, TaskEvaluationInput } from './server/riskScorer.js';
import { storeUserGoogleTokens, runAutonomousSweep, sendEmailServer, refreshGoogleAccessToken } from './server/rescueAgent.js';
import { dbAdmin, authAdmin } from './server/firebaseAdmin.js';

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

  // Google OAuth URL generation
  app.get('/api/auth/google/url', (req, res) => {
    try {
      const { userId } = req.query;
      if (!userId) {
        return res.status(400).json({ error: 'Missing userId parameter' });
      }

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
      
      // Save tokens in Firestore securely
      await storeUserGoogleTokens(String(userId), tokens);

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
                  window.opener.postMessage({
                    type: 'OAUTH_AUTH_SUCCESS',
                    accessToken: ${JSON.stringify(tokens.access_token)}
                  }, "*");
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

  // Secure Autonomous Sweep endpoint (Cron trigger)
  app.post('/api/agent/sweep', async (req, res) => {
    try {
      const authHeader = req.headers['x-rescue-agent-key'];
      const expectedKey = process.env.RESCUE_AGENT_KEY || 'flare_secret_sweep_token_2026';
      
      if (!authHeader || authHeader !== expectedKey) {
        return res.status(401).json({ error: 'Unauthorized: Invalid x-rescue-agent-key header' });
      }

      const result = await runAutonomousSweep();
      return res.json(result);
    } catch (error: any) {
      console.error('API Error in /api/agent/sweep:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Dev Sweep Trigger (Manual Trigger Endpoint for preview mode)
  app.post('/api/dev/sweep', async (req, res) => {
    try {
      const result = await runAutonomousSweep();
      return res.json(result);
    } catch (error: any) {
      console.error('API Error in /api/dev/sweep:', error);
      return res.status(500).json({ error: error.message || 'Internal Server Error' });
    }
  });

  // Send draft email endpoint
  app.post('/api/tasks/send-draft', async (req, res) => {
    try {
      const { taskId, userId, recipientEmail } = req.body;
      if (!taskId || !userId) {
        return res.status(400).json({ error: 'Missing taskId or userId' });
      }

      // 1. Get task details
      const taskDoc = await dbAdmin.collection('tasks').doc(taskId).get();
      if (!taskDoc.exists) {
        return res.status(404).json({ error: 'Task not found' });
      }
      const taskData = taskDoc.data();
      if (taskData?.userId !== userId) {
        return res.status(403).json({ error: 'Unauthorized' });
      }

      if (!taskData.draftRescheduleEmailSubject || !taskData.draftRescheduleEmailBody) {
        return res.status(400).json({ error: 'No draft extension email exists for this task.' });
      }

      // 2. Fetch Google Tokens
      const tokenDoc = await dbAdmin.collection('user_tokens').doc(userId).get();
      if (!tokenDoc.exists) {
        return res.status(400).json({ error: 'Google account not connected.' });
      }
      const tokenData = tokenDoc.data();
      if (!tokenData?.refreshToken) {
        return res.status(400).json({ error: 'No refresh token available.' });
      }

      // 3. Refresh and send
      const accessToken = await refreshGoogleAccessToken(tokenData.refreshToken);
      
      // Default to input recipient, or fall back to user email
      let targetRecipient = recipientEmail || '';
      if (!targetRecipient) {
        try {
          const userRecord = await authAdmin.getUser(userId);
          targetRecipient = userRecord.email || '';
        } catch (authErr) {
          console.error('Failed to get user email in send-draft:', authErr);
        }
      }

      if (!targetRecipient) {
        return res.status(400).json({ error: 'Recipient email not specified and user email not found.' });
      }

      await sendEmailServer(
        accessToken,
        targetRecipient,
        taskData.draftRescheduleEmailSubject,
        taskData.draftRescheduleEmailBody
      );

      // 4. Update task to remove the draft details so they know it was sent
      await dbAdmin.collection('tasks').doc(taskId).update({
        draftRescheduleEmailSubject: null,
        draftRescheduleEmailBody: null,
        extensionEmailSentAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });

      return res.json({ status: 'success' });
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
        model: 'gemini-3.5-flash',
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
