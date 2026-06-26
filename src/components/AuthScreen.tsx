import React, { useState } from 'react';
import { 
  signInWithEmailAndPassword, 
  createUserWithEmailAndPassword, 
  signInWithPopup,
  GoogleAuthProvider
} from 'firebase/auth';
import { 
  auth, 
  googleProvider 
} from '../firebase.js';
import { Shield, Sparkles, Mail, Lock, LogIn, UserPlus } from 'lucide-react';

interface AuthScreenProps {
  onContinueAsGuest: () => void;
}

export default function AuthScreen({ onContinueAsGuest }: AuthScreenProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email || !password) {
      setError('Please fill in all fields.');
      return;
    }
    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    setError(null);
    setLoading(true);

    try {
      if (isRegister) {
        await createUserWithEmailAndPassword(auth, email, password);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      console.error('Authentication error:', err);
      if (err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password') {
        setError('Invalid email or password.');
      } else if (err.code === 'auth/email-already-in-use') {
        setError('This email is already registered.');
      } else {
        setError(err.message || 'Authentication failed. Please try again.');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const credential = GoogleAuthProvider.credentialFromResult(result);
      const token = credential?.accessToken;
      if (token) {
        localStorage.setItem('google_calendar_access_token', token);
      }
    } catch (err: any) {
      console.error('Google Auth error:', err);
      if (err.code === 'auth/popup-blocked') {
        setError('Popup blocked by browser. Please enable popups or use the Email form below.');
      } else if (err.code === 'auth/cancelled-popup-request') {
        setError('Sign in cancelled.');
      } else {
        setError(err.message || 'Google sign-in failed. Please try again or use Guest mode.');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F9F8F6] px-4 py-12" id="auth-screen-container">
      <div className="w-full max-w-md bg-white border border-black/10 rounded-none shadow-xs overflow-hidden" id="auth-card">
        
        {/* Flare branding header */}
        <div className="border-b border-black/10 px-8 py-10 text-center relative" id="auth-header">
          <div className="absolute top-4 right-4 text-[9px] font-mono tracking-wider font-extrabold text-zinc-900 bg-black/5 px-2.5 py-0.5 border border-black/5">
            [ AI AGENT COMPANION ]
          </div>
          
          <h1 className="text-5xl font-black italic tracking-tighter font-serif text-zinc-950">FLARE.</h1>
          <p className="text-zinc-500 text-xs mt-3 max-w-xs mx-auto leading-relaxed">
            An AI-powered deadline rescue companion engineered to triage your task load and protect your focus.
          </p>
        </div>

        {/* Form panel */}
        <div className="p-8" id="auth-body">
          {error && (
            <div className="mb-6 p-4 bg-red-50 border border-red-200 text-xs font-bold text-red-700" id="auth-error-alert">
              {error}
            </div>
          )}

          <form onSubmit={handleEmailAuth} className="space-y-5" id="auth-email-form">
            <div>
              <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-400">
                  <Mail className="w-4 h-4" />
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition"
                  placeholder="name@company.com"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
                Password
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-400">
                  <Lock className="w-4 h-4" />
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition"
                  placeholder="Min. 6 characters"
                  required
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full bg-black hover:bg-zinc-800 disabled:bg-zinc-400 text-white font-extrabold text-xs uppercase tracking-widest py-3 rounded-none transition flex items-center justify-center gap-2 cursor-pointer mt-2"
              id="submit-auth-button"
            >
              {isRegister ? (
                <>
                  <UserPlus className="w-3.5 h-3.5" />
                  Create Your Account
                </>
              ) : (
                <>
                  <LogIn className="w-3.5 h-3.5" />
                  Sign In to Dashboard
                </>
              )}
            </button>
          </form>

          <div className="relative my-6" id="auth-divider">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-black/10"></div>
            </div>
            <div className="relative flex justify-center text-[10px] uppercase tracking-wider">
              <span className="bg-white px-3 text-zinc-400 font-bold">or connect via</span>
            </div>
          </div>

          <button
            onClick={handleGoogleSignIn}
            disabled={loading}
            className="w-full bg-white hover:bg-zinc-50 disabled:bg-zinc-50 text-zinc-800 font-bold text-xs uppercase tracking-widest py-2.5 rounded-none border border-black/10 transition flex items-center justify-center gap-2 cursor-pointer"
            id="google-signin-button"
          >
            <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4"/>
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/>
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" fill="#FBBC05"/>
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/>
            </svg>
            Sign in with Google
          </button>

          <div className="text-center mt-6 space-y-3" id="auth-footer">
            <button
              onClick={() => setIsRegister(!isRegister)}
              className="text-[11px] font-bold text-zinc-500 hover:text-zinc-800 transition cursor-pointer underline"
              id="toggle-auth-mode-button"
            >
              {isRegister ? 'Already have an account? Sign in' : "Don't have an account? Register"}
            </button>
            
            <div className="block">
              <button
                type="button"
                onClick={onContinueAsGuest}
                className="text-xs font-black text-amber-700 hover:text-amber-900 transition cursor-pointer font-serif italic"
                id="guest-mode-button"
              >
                Continue as Guest (Offline Mode) &rarr;
              </button>
            </div>
          </div>

        </div>

      </div>
    </div>
  );
}
