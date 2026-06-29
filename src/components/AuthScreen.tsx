import React, { useState, useEffect } from "react";
import {
  signInWithEmailAndPassword,
  createUserWithEmailAndPassword,
  signInWithPopup,
  sendEmailVerification,
  updateProfile,
  fetchSignInMethodsForEmail,
  signOut,
} from "firebase/auth";
import { auth, googleProvider } from "../firebase.js";
import {
  Shield,
  Sparkles,
  Mail,
  Lock,
  LogIn,
  UserPlus,
  CheckCircle2,
  User,
} from "lucide-react";

interface AuthScreenProps {
  onContinueAsGuest: () => void;
}

export default function AuthScreen({ onContinueAsGuest }: AuthScreenProps) {
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [verificationSent, setVerificationSent] = useState(false);
  const [failedAttempts, setFailedAttempts] = useState(0);
  const [lockoutTime, setLockoutTime] = useState<number | null>(null);
  const [remainingLockout, setRemainingLockout] = useState(0);

  // Rate limiting cooldown timer
  useEffect(() => {
    let interval: NodeJS.Timeout;
    if (lockoutTime && lockoutTime > Date.now()) {
      interval = setInterval(() => {
        const remaining = Math.ceil((lockoutTime - Date.now()) / 1000);
        if (remaining <= 0) {
          setLockoutTime(null);
          setRemainingLockout(0);
          setFailedAttempts(0); // Reset after cooldown
        } else {
          setRemainingLockout(remaining);
        }
      }, 1000);
    }
    return () => clearInterval(interval);
  }, [lockoutTime]);

  const calculatePasswordStrength = (pass: string) => {
    let score = 0;
    if (pass.length > 0) score += 1;
    if (pass.length >= 6) score += 1;
    if (pass.length >= 8) score += 1;
    if (/[A-Z]/.test(pass) && /[a-z]/.test(pass)) score += 1;
    if (/[0-9!@#$%^&*]/.test(pass)) score += 1;
    return score;
  };

  const getStrengthColor = (score: number) => {
    if (score === 0) return "bg-zinc-200";
    if (score <= 2) return "bg-red-500";
    if (score === 3) return "bg-amber-500";
    if (score === 4) return "bg-emerald-400";
    return "bg-emerald-600";
  };

  const strengthScore = calculatePasswordStrength(password);

  const handleEmailBlur = async () => {
    if (!email) {
      if (
        error === "Please enter a valid email address." ||
        error === "This email is already registered." ||
        error === "This email is not registered."
      ) {
        setError(null);
      }
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      setError("Please enter a valid email address.");
      return;
    }

    if (error === "Please enter a valid email address.") {
      setError(null);
    }
    
    try {
      const methods = await fetchSignInMethodsForEmail(auth, email);
      if (isRegister && methods.length > 0) {
        setError("This email is already registered.");
      } else if (!isRegister && methods.length === 0) {
        setError("This email is not registered.");
      } else {
        if (
          error === "This email is already registered." ||
          error === "This email is not registered."
        ) {
          setError(null);
        }
      }
    } catch (err) {
      // In case of email enumeration protection being enabled, this might throw an error or just return empty.
      console.error("Error checking email:", err);
    }
  };

  const handleEmailAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    if (lockoutTime && lockoutTime > Date.now()) return;

    if (!email || !password) {
      setError("Please fill in all fields.");
      return;
    }

    if (isRegister && password.length < 8) {
      setError("Password must be at least 8 characters long.");
      return;
    }

    if (isRegister && !name.trim()) {
      setError("Please enter your name.");
      return;
    }

    if (isRegister && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setError(null);
    setLoading(true);

    try {
      if (isRegister) {
        const userCredential = await createUserWithEmailAndPassword(
          auth,
          email,
          password,
        );
        await updateProfile(userCredential.user, { displayName: name });
        await sendEmailVerification(userCredential.user);
        // Sign out immediately so App.tsx doesn't redirect them to the dashboard.
        // This ensures they stay on the AuthScreen to see the "Check your inbox" message.
        await signOut(auth);
        setVerificationSent(true);
      } else {
        await signInWithEmailAndPassword(auth, email, password);
      }
    } catch (err: any) {
      console.error("Authentication error:", err);
      if (err.code === "auth/operation-not-allowed") {
        setError(
          "Email/Password authentication is disabled. Please enable it in your Firebase Console: Authentication -> Sign-in method.",
        );
      } else if (isRegister) {
        if (err.code === "auth/email-already-in-use") {
          setError("This email is already registered. Please sign in instead.");
        } else if (err.code === "auth/weak-password") {
          setError("Password is too weak. Please use a stronger password.");
        } else if (err.code === "auth/invalid-email") {
          setError("Please enter a valid email address.");
        } else {
          setError(err.message || "An error occurred during registration.");
        }
      } else {
        // Generic error message for login to not leak user existence
        setError("Invalid email or password.");
      }

      if (!isRegister) {
        const newAttempts = failedAttempts + 1;
        setFailedAttempts(newAttempts);
        if (newAttempts >= 5) {
          // Exponential backoff cooldown: 5 fails = 30s, 6 = 60s, etc.
          const penaltySeconds = 30 * Math.pow(2, newAttempts - 5);
          setLockoutTime(Date.now() + penaltySeconds * 1000);
          setRemainingLockout(penaltySeconds);
          setError(
            `Too many failed attempts. Please try again in ${penaltySeconds} seconds.`,
          );
        }
      }
    } finally {
      setLoading(false);
    }
  };

  const handleGoogleSignIn = async () => {
    setError(null);
    setLoading(true);
    try {
      await signInWithPopup(auth, googleProvider);
      // NOTE: Do NOT store Firebase's OAuth access token as the Calendar token.
      // Firebase's token is tied to Firebase's OAuth client — not the app's GOOGLE_CLIENT_ID.
      // Calendar connection must be done explicitly via the "Connect Calendar" OAuth flow.
    } catch (err: any) {
      console.error("Google Auth error:", err);
      if (err.code === "auth/operation-not-allowed") {
        setError(
          "Google authentication is disabled. Please enable it in your Firebase Console: Authentication -> Sign-in method.",
        );
      } else if (err.code === "auth/popup-blocked") {
        setError(
          "Popup blocked by browser. Please enable popups or use the Email form below.",
        );
      } else if (err.code === "auth/cancelled-popup-request") {
        setError("Sign in cancelled.");
      } else {
        setError("Google sign-in failed. Please try again or use Guest mode.");
      }
    } finally {
      setLoading(false);
    }
  };

  if (verificationSent) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-[#F9F8F6] dark:bg-zinc-950 dark:text-zinc-100 px-4 py-12">
        <div className="w-full max-w-md bg-white border border-black/10 p-8 text-center shadow-xs">
          <CheckCircle2 className="w-12 h-12 text-emerald-600 mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2 text-zinc-900">
            Check your inbox
          </h2>
          <p className="text-sm text-zinc-600 mb-6 leading-relaxed">
            We've sent a verification email to <strong>{email}</strong>. Please
            click the link to verify your account and unlock autonomous Agent
            features.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2 bg-black text-white text-xs font-bold uppercase tracking-wider hover:bg-zinc-800 transition"
          >
            Go to Dashboard
          </button>
        </div>
      </div>
    );
  }

  const isLockedOut = lockoutTime !== null && lockoutTime > Date.now();

  return (
    <div
      className="min-h-screen flex items-center justify-center bg-[#f8f7f4] text-[#1a1a1a] px-4 py-12 selection:bg-[#1a1a1a] selection:text-[#f8f7f4]"
      style={{ fontFamily: "'Geist', sans-serif" }}
      id="auth-screen-container"
    >
      <div
        className="grid grid-cols-1 lg:grid-cols-2 w-full max-w-[1000px] min-h-[640px] bg-white shadow-[0_40px_100px_rgba(0,0,0,0.04)] border border-black/10 rounded overflow-hidden"
        id="auth-card"
      >
        {/* Editorial Side */}
        <aside className="p-8 lg:p-16 flex flex-col justify-between bg-[#f2efeb] border-b lg:border-b-0 lg:border-r border-black/10">
          <div
            className="font-mono text-[10px] tracking-[0.1em] text-[#666666] uppercase"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            REF: AGENT_C_COMPANION
          </div>
          <div className="my-12 lg:my-0">
            <h1
              className="text-6xl lg:text-[5rem] font-semibold italic tracking-[-0.04em] leading-none mb-8 text-[#1a1a1a]"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
            >
              Flare.
            </h1>
            <p className="text-[15px] leading-[1.7] text-[#666666] max-w-[320px]">
              An AI-powered deadline rescue companion engineered to triage your
              task load and protect your focus.
            </p>
          </div>
          <div
            className="font-mono text-[10px] tracking-[0.1em] text-[#666666] uppercase"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
          >
            © 2026 CORE LOGIC SYSTEMS
          </div>
        </aside>

        {/* Form panel */}
        <main
          className="p-8 lg:p-16 flex flex-col justify-center bg-white"
          id="auth-body"
        >
          {error && (
            <div
              className="mb-6 p-4 bg-red-50 border border-red-200 text-xs font-bold text-red-700"
              id="auth-error-alert"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleEmailAuth} className="" id="auth-email-form">
            {isRegister && (
              <div className="mb-6">
                <label
                  className="block text-[10px] uppercase tracking-[0.12em] text-[#666666] mb-2"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  Full Name
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-3 text-[#666666] opacity-60">
                    <User className="w-3.5 h-3.5" />
                  </span>
                  <input
                    type="text"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-[#fafafa] border border-black/10 rounded text-[14px] focus:outline-none focus:ring-1 focus:ring-black focus:border-black focus:bg-white transition-all duration-200"
                    placeholder="Jane Doe"
                    required={isRegister}
                  />
                </div>
              </div>
            )}

            <div className="mb-6">
              <label
                className="block text-[10px] uppercase tracking-[0.12em] text-[#666666] mb-2"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Email Address
              </label>
              <div className="relative flex items-center">
                <span className="absolute left-3 text-[#666666] opacity-60">
                  <Mail className="w-3.5 h-3.5" />
                </span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={handleEmailBlur}
                  className="w-full pl-10 pr-4 py-3 bg-[#fafafa] border border-black/10 rounded text-[14px] focus:outline-none focus:ring-1 focus:ring-black focus:border-black focus:bg-white transition-all duration-200"
                  placeholder="name@company.com"
                  required
                />
              </div>
            </div>

            <div className="mb-6">
              <label
                className="block text-[10px] uppercase tracking-[0.12em] text-[#666666] mb-2"
                style={{ fontFamily: "'JetBrains Mono', monospace" }}
              >
                Password
              </label>
              <div className="relative flex items-center">
                <span className="absolute left-3 text-[#666666] opacity-60">
                  <Lock className="w-3.5 h-3.5" />
                </span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 bg-[#fafafa] border border-black/10 rounded text-[14px] focus:outline-none focus:ring-1 focus:ring-black focus:border-black focus:bg-white transition-all duration-200"
                  placeholder={
                    isRegister ? "Min. 8 characters" : "Min. 6 characters"
                  }
                  required
                />
              </div>
              {isRegister && password.length > 0 && (
                <div className="mt-3 space-y-2">
                  <div className="flex gap-1 h-1">
                    {[1, 2, 3, 4, 5].map((i) => (
                      <div
                        key={i}
                        className={`flex-1 rounded-full transition-colors duration-300 ${strengthScore >= i ? getStrengthColor(strengthScore) : "bg-zinc-200"}`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between items-center text-[10px] font-medium">
                    <span
                      className={`${password.length >= 8 ? "text-emerald-600" : "text-[#666666]"}`}
                    >
                      {password.length}/8 characters
                    </span>
                    <span className="text-[#666666]">
                      {strengthScore <= 2
                        ? "Weak"
                        : strengthScore === 3
                          ? "Fair"
                          : strengthScore === 4
                            ? "Good"
                            : "Strong"}
                    </span>
                  </div>
                </div>
              )}
            </div>

            {isRegister && (
              <div className="mb-6">
                <label
                  className="block text-[10px] uppercase tracking-[0.12em] text-[#666666] mb-2"
                  style={{ fontFamily: "'JetBrains Mono', monospace" }}
                >
                  Confirm Password
                </label>
                <div className="relative flex items-center">
                  <span className="absolute left-3 text-[#666666] opacity-60">
                    <Lock className="w-3.5 h-3.5" />
                  </span>
                  <input
                    type="password"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    className="w-full pl-10 pr-4 py-3 bg-[#fafafa] border border-black/10 rounded text-[14px] focus:outline-none focus:ring-1 focus:ring-black focus:border-black focus:bg-white transition-all duration-200"
                    placeholder="Confirm password"
                    required={isRegister}
                  />
                </div>
              </div>
            )}

            <button
              type="submit"
              disabled={loading || isLockedOut}
              className="w-full bg-[#1a1a1a] hover:opacity-90 disabled:bg-zinc-400 text-white font-semibold text-[14px] py-4 rounded transition flex items-center justify-center gap-2 cursor-pointer mt-4"
              id="submit-auth-button"
            >
              {isLockedOut ? (
                `Try again in ${remainingLockout}s`
              ) : isRegister ? (
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

          <div
            className="flex items-center my-8 text-[#666666] text-[9px] uppercase tracking-[0.1em]"
            style={{ fontFamily: "'JetBrains Mono', monospace" }}
            id="auth-divider"
          >
            <div className="flex-1 h-[1px] bg-black/10"></div>
            <span className="px-4">or connect via</span>
            <div className="flex-1 h-[1px] bg-black/10"></div>
          </div>

          <button
            onClick={handleGoogleSignIn}
            disabled={loading || isLockedOut}
            className="w-full bg-white hover:bg-[#fafafa] disabled:bg-zinc-100 text-[#1a1a1a] font-medium text-[14px] py-3.5 rounded border border-black/10 transition flex items-center justify-center gap-2 cursor-pointer"
            id="google-signin-button"
          >
            <svg
              className="w-3.5 h-3.5"
              viewBox="0 0 24 24"
              fill="currentColor"
            >
              <path
                d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                fill="#4285F4"
              />
              <path
                d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                fill="#34A853"
              />
              <path
                d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z"
                fill="#FBBC05"
              />
              <path
                d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                fill="#EA4335"
              />
            </svg>
            Sign in with Google
          </button>

          <footer className="mt-10 text-center" id="auth-footer">
            <button
              onClick={() => {
                setIsRegister(!isRegister);
                setError(null);
              }}
              className="text-[12px] text-[#666666] hover:text-[#1a1a1a] transition cursor-pointer underline"
              id="toggle-auth-mode-button"
            >
              {isRegister
                ? "Already have an account? Sign in"
                : "Don't have an account? Register"}
            </button>

            <button
              type="button"
              onClick={onContinueAsGuest}
              className="block w-full mt-4 text-[16px] font-semibold text-[#b08a5a] hover:text-[#906b3f] transition cursor-pointer italic"
              style={{ fontFamily: "'Cormorant Garamond', serif" }}
              id="guest-mode-button"
            >
              Continue as Guest (Offline Mode) &rarr;
            </button>
          </footer>
        </main>
      </div>
    </div>
  );
}
