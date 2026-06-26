import { useState, useEffect, DragEvent } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { auth } from './firebase.js';
import { 
  fetchTasks, 
  createTask, 
  updateTask, 
  deleteTask, 
  reevaluateAllTasks 
} from './taskService.js';
import { fetchHabits } from './habitService.js';
import { Task, TaskCategory, TaskStatus, Habit } from './types.js';
import AuthScreen from './components/AuthScreen.js';
import TaskCard from './components/TaskCard.js';
import TaskFormModal from './components/TaskFormModal.js';
import HabitsTracker from './components/HabitsTracker.js';
import VoiceAssistant from './components/VoiceAssistant.js';
import EffortChart from './components/EffortChart.js';
import { 
  Sparkles, 
  Plus, 
  LogOut, 
  CheckCircle, 
  AlertOctagon, 
  Hourglass, 
  ShieldAlert,
  Search,
  Filter,
  RefreshCw,
  Zap,
  Check,
  User,
  ExternalLink,
  Play,
  Calendar,
  AlertCircle,
  Target,
  Moon,
  Sun
} from 'lucide-react';
import {
  getCachedAccessToken,
  setCachedAccessToken,
  connectCalendar,
  fetchFreeBusy,
  createCalendarEvent,
  findNextFreeSlot
} from './calendarService.js';

export default function App() {
  // Authentication & Session state
  const [user, setUser] = useState<any>(null);
  const [isGuest, setIsGuest] = useState(false);
  const [authChecking, setAuthChecking] = useState(true);

  // Data state
  const [tasks, setTasks] = useState<Task[]>([]);
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(false);
  const [recomputing, setRecomputing] = useState(false);

  // UI state
  const [activeView, setActiveView] = useState<'tasks' | 'habits' | 'insights'>('tasks');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [showDone, setShowDone] = useState(true);
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [taskToEdit, setTaskToEdit] = useState<Task | null>(null);
  const [calendarConnected, setCalendarConnected] = useState(!!getCachedAccessToken());
  const [toast, setToast] = useState<{ message: string; link?: string } | null>(null);
  const [runningSweep, setRunningSweep] = useState(false);
  const [sweepLogs, setSweepLogs] = useState<string[] | null>(null);
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('flare_theme') === 'dark';
  });

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark');
      localStorage.setItem('flare_theme', 'dark');
    } else {
      document.documentElement.classList.remove('dark');
      localStorage.setItem('flare_theme', 'light');
    }
  }, [darkMode]);

  // 1. Firebase Auth listener
  useEffect(() => {
    // Check local storage to see if guest session was active
    const savedGuest = localStorage.getItem('flare_is_guest');
    if (savedGuest === 'true') {
      setIsGuest(true);
      setAuthChecking(false);
    }

    const unsubscribe = onAuthStateChanged(auth, (firebaseUser) => {
      if (firebaseUser) {
        setUser(firebaseUser);
        setIsGuest(false);
        localStorage.removeItem('flare_is_guest');
      } else if (savedGuest !== 'true') {
        setUser(null);
      }
      setAuthChecking(false);
    });

    return () => unsubscribe();
  }, []);

  // 2. Fetch data on user login or guest transition
  useEffect(() => {
    if (authChecking) return;

    const loadData = async () => {
      setLoading(true);
      try {
        const userId = user ? user.uid : null;
        if (user || isGuest) {
          const [loadedTasks, loadedHabits] = await Promise.all([
            fetchTasks(userId),
            fetchHabits(userId)
          ]);
          setTasks(loadedTasks);
          setHabits(loadedHabits);
        }
      } catch (err) {
        console.error('Error loading data:', err);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [user, isGuest, authChecking]);

  // 3. Automated risk recompute as time passes (every 3 minutes) with Google Calendar support
  useEffect(() => {
    if (authChecking || (!user && !isGuest)) return;

    const interval = setInterval(async () => {
      console.log('Running periodic risk scoring re-evaluation with calendar support...');
      const userId = user ? user.uid : null;
      try {
        const token = getCachedAccessToken();
        let updated;
        if (token) {
          const currentTasks = await fetchTasks(userId);
          const activeTasks = currentTasks.filter(t => t.status !== 'done');
          if (activeTasks.length > 0) {
            const deadlines = activeTasks.map(t => t.deadline);
            const busyIntervals = await fetchBusyIntervalsForAllTasks(deadlines);
            const taskBusyIntervalsMap: Record<string, Array<{ start: string; end: string }>> = {};
            activeTasks.forEach(task => {
              const taskDeadlineTime = new Date(task.deadline).getTime();
              taskBusyIntervalsMap[task.id] = busyIntervals.filter(interval => {
                const start = new Date(interval.start).getTime();
                return start < taskDeadlineTime;
              });
            });
            updated = await reevaluateAllTasks(userId, taskBusyIntervalsMap);
          } else {
            updated = await reevaluateAllTasks(userId);
          }
        } else {
          updated = await reevaluateAllTasks(userId);
        }
        setTasks(updated);
      } catch (err) {
        console.error('Periodic evaluation failed:', err);
      }
    }, 180000); // 3 minutes

    return () => clearInterval(interval);
  }, [user, isGuest, authChecking]);

  // 4. Toast auto-dismiss effect
  useEffect(() => {
    if (toast) {
      const timer = setTimeout(() => setToast(null), 8000);
      return () => clearTimeout(timer);
    }
  }, [toast]);

  // 5. Sync calendarConnected state periodically
  useEffect(() => {
    const checkCalendar = setInterval(() => {
      setCalendarConnected(!!getCachedAccessToken());
    }, 1000);
    return () => clearInterval(checkCalendar);
  }, []);

  // Helper to fetch busy intervals up to furthest deadline
  const fetchBusyIntervalsForAllTasks = async (deadlines: string[]): Promise<Array<{ start: string; end: string }>> => {
    const token = getCachedAccessToken();
    if (!token || deadlines.length === 0) return [];
    try {
      const timeMin = new Date().toISOString();
      const times = deadlines.map(d => new Date(d).getTime());
      const latestTime = Math.max(...times);
      if (latestTime <= new Date(timeMin).getTime()) {
        return [];
      }
      const timeMax = new Date(latestTime).toISOString();
      return await fetchFreeBusy(token, timeMin, timeMax);
    } catch (err) {
      console.error('Error fetching global freebusy:', err);
      return [];
    }
  };

  // Handlers
  const handleContinueAsGuest = () => {
    setIsGuest(true);
    localStorage.setItem('flare_is_guest', 'true');
  };

  const handleLogout = async () => {
    try {
      await signOut(auth);
      setIsGuest(false);
      setUser(null);
      setTasks([]);
      localStorage.removeItem('flare_is_guest');
      setCachedAccessToken(null);
      setCalendarConnected(false);
    } catch (err) {
      console.error('Logout failed:', err);
    }
  };

  const handleManualRecompute = async () => {
    if (recomputing) return;
    setRecomputing(true);
    try {
      const userId = user ? user.uid : null;
      const token = getCachedAccessToken();
      let updated;
      if (token) {
        const currentTasks = await fetchTasks(userId);
        const activeTasks = currentTasks.filter(t => t.status !== 'done');
        if (activeTasks.length > 0) {
          const deadlines = activeTasks.map(t => t.deadline);
          const busyIntervals = await fetchBusyIntervalsForAllTasks(deadlines);
          const taskBusyIntervalsMap: Record<string, Array<{ start: string; end: string }>> = {};
          activeTasks.forEach(task => {
            const taskDeadlineTime = new Date(task.deadline).getTime();
            taskBusyIntervalsMap[task.id] = busyIntervals.filter(interval => {
              const start = new Date(interval.start).getTime();
              return start < taskDeadlineTime;
            });
          });
          updated = await reevaluateAllTasks(userId, taskBusyIntervalsMap);
        } else {
          updated = await reevaluateAllTasks(userId);
        }
      } else {
        updated = await reevaluateAllTasks(userId);
      }
      setTasks(updated);
    } catch (err) {
      console.error('Manual re-evaluation failed:', err);
    } finally {
      setRecomputing(false);
    }
  };

  const handleConnectCalendar = async () => {
    if (!user) {
      alert('Please Sign In with an account to connect Google Calendar & Gmail.');
      return;
    }
    try {
      const token = await connectCalendar(user.uid);
      if (token) {
        setCalendarConnected(true);
        // Toast feedback
        setToast({ message: 'Google Calendar & Gmail connected successfully! Rescanning deadlines...' });
        // Recalculate
        await handleManualRecompute();
      }
    } catch (err: any) {
      console.error('Failed to connect Google Calendar:', err);
      alert(`Calendar connection failed: ${err.message || err}`);
    }
  };

  const handleRunSweep = async () => {
    setRunningSweep(true);
    setSweepLogs([]);
    try {
      const response = await fetch('/api/dev/sweep', { method: 'POST' });
      const data = await response.json();
      if (data.logs) {
        setSweepLogs(data.logs);
      }
      setToast({ message: 'Rescue Agent Sweep executed successfully!' });
      
      // Refresh tasks immediately
      const userId = user ? user.uid : null;
      const refreshedTasks = await fetchTasks(userId);
      setTasks(refreshedTasks);
    } catch (err: any) {
      console.error('Failed to run sweep:', err);
      alert(`Sweep execution failed: ${err.message || err}`);
    } finally {
      setRunningSweep(false);
    }
  };

  const handleScheduleTask = async (task: Task) => {
    const token = getCachedAccessToken();
    if (!token) {
      // Trigger prompt connection
      await handleConnectCalendar();
      return;
    }

    try {
      setRecomputing(true);
      // 1. Fetch busy intervals from now until 30 days out
      const timeMin = new Date();
      const timeMax = new Date(timeMin.getTime() + 30 * 24 * 60 * 60 * 1000);
      const busyIntervals = await fetchFreeBusy(token, timeMin.toISOString(), timeMax.toISOString());

      // 2. Find the next free slot
      const slot = findNextFreeSlot(busyIntervals, task.estimatedEffort, timeMin);

      // 3. Create the calendar event
      const eventDetails = await createCalendarEvent(
        token,
        `[Flare Rescue] ${task.title}`,
        slot.start,
        slot.end,
        task.description || 'Focused work block scheduled automatically by Flare AI.'
      );

      // 4. Save to Firestore/local state
      const userId = user ? user.uid : null;
      const updated = await updateTask(userId, task.id, {
        scheduledEventId: eventDetails.id,
        scheduledEventLink: eventDetails.htmlLink
      });

      // Update local task state
      setTasks(prev => prev.map(t => t.id === task.id ? updated : t));

      // 5. Show toast
      setToast({
        message: `Scheduled ${task.estimatedEffort}h work block on ${slot.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} at ${slot.start.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}!`,
        link: eventDetails.htmlLink
      });

    } catch (err: any) {
      console.error('Failed to schedule work block:', err);
      alert(`Scheduling failed: ${err.message || err}`);
    } finally {
      setRecomputing(false);
    }
  };

  const handleSaveTask = async (taskData: {
    title: string;
    description?: string;
    deadline: string;
    estimatedEffort: number;
    category: TaskCategory;
    status: TaskStatus;
  }) => {
    const userId = user ? user.uid : null;
    const token = getCachedAccessToken();
    let busyIntervals: any[] = [];
    
    setLoading(true);
    try {
      if (token) {
        // Fetch busy intervals up to the deadline
        try {
          const timeMin = new Date().toISOString();
          const timeMax = new Date(taskData.deadline).toISOString();
          if (new Date(timeMax).getTime() > new Date(timeMin).getTime()) {
            busyIntervals = await fetchFreeBusy(token, timeMin, timeMax);
          }
        } catch (err) {
          console.error('Failed to pre-fetch free/busy for saving task:', err);
        }
      }

      if (taskToEdit) {
        // Edit task
        const updated = await updateTask(userId, taskToEdit.id, taskData, token ? busyIntervals : undefined);
        setTasks(prev => prev.map(t => t.id === taskToEdit.id ? updated : t));
      } else {
        // Create new task
        const created = await createTask(userId, taskData, token ? busyIntervals : undefined);
        setTasks(prev => [...prev, created]);
      }
    } catch (err) {
      console.error('Failed to save task:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    if (confirm('Are you sure you want to remove this task?')) {
      const userId = user ? user.uid : null;
      await deleteTask(userId, taskId);
      setTasks(prev => prev.filter(t => t.id !== taskId));
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };

  const handleDrop = async (e: DragEvent, newRiskScore: 'Critical' | 'Urgent' | 'Stable') => {
    e.preventDefault();
    const taskId = e.dataTransfer.getData('taskId');
    if (!taskId) return;
    
    const task = tasks.find(t => t.id === taskId);
    if (!task || task.riskScore === newRiskScore) return;

    // Optimistic update
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, riskScore: newRiskScore, manualRiskOverride: true } : t));
    
    // Server update
    try {
      const userId = user ? user.uid : null;
      await updateTask(userId, taskId, { riskScore: newRiskScore, manualRiskOverride: true });
    } catch (err) {
      console.error('Failed to update task risk score manually:', err);
      // Revert on failure
      setTasks(prev => prev.map(t => t.id === taskId ? { ...t, riskScore: task.riskScore, manualRiskOverride: task.manualRiskOverride } : t));
    }
  };

  const handleStatusChange = async (taskId: string, newStatus: TaskStatus) => {
    const userId = user ? user.uid : null;
    const token = getCachedAccessToken();
    let busyIntervals: any[] = [];
    
    // Optimistic local state update for instant UI feedback
    setTasks(prev => prev.map(t => t.id === taskId ? { ...t, status: newStatus } : t));
    
    try {
      // If setting to active and calendar is connected, pre-fetch busy blocks to update risk scoring!
      if (newStatus !== 'done' && token) {
        const existingTask = tasks.find(t => t.id === taskId);
        if (existingTask) {
          try {
            const timeMin = new Date().toISOString();
            const timeMax = new Date(existingTask.deadline).toISOString();
            if (new Date(timeMax).getTime() > new Date(timeMin).getTime()) {
              busyIntervals = await fetchFreeBusy(token, timeMin, timeMax);
            }
          } catch (err) {
            console.error('Failed to pre-fetch free/busy for status change:', err);
          }
        }
      }

      const updated = await updateTask(userId, taskId, { status: newStatus }, token && newStatus !== 'done' ? busyIntervals : undefined);
      setTasks(prev => prev.map(t => t.id === taskId ? updated : t));
    } catch (err) {
      console.error('Failed to update status:', err);
      // Revert optimistic update by refetching actual database values on failure
      const loaded = await fetchTasks(userId);
      setTasks(loaded);
    }
  };

  const openAddModal = () => {
    setTaskToEdit(null);
    setIsModalOpen(true);
  };

  const openEditModal = (task: Task) => {
    setTaskToEdit(task);
    setIsModalOpen(true);
  };

  // Filter and search computation
  const filteredTasks = tasks.filter(task => {
    const matchesSearch = task.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
      (task.description && task.description.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesCategory = selectedCategory === 'all' || task.category === selectedCategory;
    
    const matchesDone = showDone || task.status !== 'done';

    return matchesSearch && matchesCategory && matchesDone;
  });

  // Split into columns
  const criticalTasks = filteredTasks.filter(t => t.status !== 'done' && t.riskScore === 'Critical');
  const urgentTasks = filteredTasks.filter(t => t.status !== 'done' && t.riskScore === 'Urgent');
  const stableTasks = filteredTasks.filter(t => t.status !== 'done' && t.riskScore === 'Stable');
  const finishedTasks = filteredTasks.filter(t => t.status === 'done');

  // Compute column metrics
  const criticalHours = criticalTasks.reduce((sum, t) => sum + t.estimatedEffort, 0);
  const urgentHours = urgentTasks.reduce((sum, t) => sum + t.estimatedEffort, 0);
  const stableHours = stableTasks.reduce((sum, t) => sum + t.estimatedEffort, 0);
  const finishedHours = finishedTasks.reduce((sum, t) => sum + t.estimatedEffort, 0);

  // Compute pinned most at-risk task (from all tasks, active only)
  const getPinnedTask = (): Task | null => {
    const activeTasks = tasks.filter(t => t.status !== 'done');
    if (activeTasks.length === 0) return null;

    // Sort: Critical first, then Urgent, then Stable.
    // Within each, sort by closest deadline (ascending)
    const sorted = [...activeTasks].sort((a, b) => {
      const priorityWeight = { Critical: 3, Urgent: 2, Stable: 1 };
      const weightA = priorityWeight[a.riskScore];
      const weightB = priorityWeight[b.riskScore];

      if (weightA !== weightB) {
        return weightB - weightA; // Higher weight first (Critical)
      }

      // Sort by closest deadline
      return new Date(a.deadline).getTime() - new Date(b.deadline).getTime();
    });

    return sorted[0];
  };

  const pinnedTask = getPinnedTask();

  if (authChecking) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-[#F9F8F6] dark:bg-zinc-950 dark:text-zinc-100 px-6" id="splash-screen">
        <div className="flex flex-col items-center text-center max-w-sm space-y-4">
          <h1 className="text-6xl font-black italic tracking-tighter font-serif text-zinc-950 dark:text-white">FLARE.</h1>
          <div className="h-px w-16 bg-black/25 dark:bg-white/25" />
          <p className="text-[10px] uppercase tracking-[0.2em] font-bold text-zinc-500 dark:text-zinc-400">AI Triage engine is warming up...</p>
        </div>
      </div>
    );
  }

  if (!user && !isGuest) {
    return <AuthScreen onContinueAsGuest={handleContinueAsGuest} />;
  }

  return (
    <div className="min-h-screen bg-[#F9F8F6] text-[#1A1A1A] dark:bg-zinc-950 dark:text-zinc-100 flex flex-col px-4 sm:px-8 md:px-12 py-8" id="app-root-container">
      
      {/* 1. TOP MAIN NAV / HEADER */}
      <header className="flex flex-col lg:flex-row justify-between items-start border-b border-black/10 dark:border-white/10 pb-8 mb-8 gap-6" id="main-header">
        
        {/* Logo Brand & Metadata */}
        <div className="flex flex-col">
          <div className="flex items-center gap-4">
            <h1 className="text-5xl font-black tracking-tighter leading-none italic font-serif">FLARE.</h1>
            <button
              onClick={() => setDarkMode(!darkMode)}
              className="p-1.5 border border-black/10 dark:border-white/10 rounded-none bg-black/5 dark:bg-white/5 hover:bg-black/10 dark:hover:bg-white/10 transition-colors"
              title="Toggle Dark Mode"
            >
              {darkMode ? <Sun className="w-4 h-4 text-amber-500" /> : <Moon className="w-4 h-4 text-zinc-700" />}
            </button>
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2">
            <p className="text-[10px] uppercase tracking-[0.2em] font-bold opacity-60">AI Deadline Rescue Companion</p>
            <span className="text-[9px] font-mono bg-black/5 dark:bg-white/5 text-zinc-700 dark:text-zinc-300 px-1.5 py-0.5 border border-black/5 dark:border-white/5">v1.2-AI</span>
            <span className="text-[9px] font-mono text-zinc-500 dark:text-zinc-400">
              {user ? (user.email || 'Cloud User') : 'Guest Session'}
            </span>
            {calendarConnected ? (
              <span className="text-[9px] font-mono font-bold bg-emerald-100 text-emerald-800 px-1.5 py-0.5 border border-emerald-200 flex items-center gap-0.5" id="calendar-header-status-badge">
                📅 Calendar Active
              </span>
            ) : (
              <button
                onClick={handleConnectCalendar}
                className="text-[9px] font-mono font-bold bg-amber-50 hover:bg-amber-100 text-amber-800 px-1.5 py-0.5 border border-amber-200 cursor-pointer"
                title="Connect Calendar for Smarter AI diagnostic scoring"
                id="connect-calendar-header-btn"
              >
                📅 Connect Calendar
              </button>
            )}
            {user && (
              <button 
                onClick={handleLogout}
                className="text-[9px] font-bold uppercase tracking-wider text-red-600 hover:underline cursor-pointer ml-1"
                title="Disconnect Dashboard"
              >
                [ Sign Out ]
              </button>
            )}
            {!user && isGuest && (
              <button
                onClick={() => { window.location.reload(); }}
                className="text-[9px] font-bold uppercase tracking-wider text-zinc-700 hover:underline cursor-pointer ml-1"
              >
                [ Connect Account ]
              </button>
            )}
          </div>
        </div>

        {/* Pinned / Critical Banner in Header */}
        {pinnedTask ? (
          <div className="bg-white dark:bg-zinc-900 border border-red-200 dark:border-red-500/20 p-5 rounded-none flex flex-col md:flex-row md:items-center gap-6 max-w-2xl shadow-xs animate-fade-in" id="pinned-hero-banner">
            <div className="bg-red-500 text-white px-3 py-1.5 text-[10px] font-black uppercase rotate-[-2deg] self-start md:self-auto shrink-0 shadow-xs">
              Critical Priority
            </div>
            <div className="flex-1">
              <h2 className="text-sm font-extrabold leading-tight text-zinc-950 font-sans">{pinnedTask.title}</h2>
              <p className="text-[10px] opacity-70 mt-1 font-mono">
                ⏱️ {pinnedTask.estimatedEffort}h effort • Due {new Date(pinnedTask.deadline).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </p>
              {pinnedTask.description && (
                <p className="text-xs text-zinc-500 mt-1 italic line-clamp-1">{pinnedTask.description}</p>
              )}
            </div>
            <div className="md:pl-6 md:border-l border-black/5 flex flex-col items-start md:items-end text-left md:text-right max-w-sm">
              <p className="text-[9px] font-bold opacity-40 uppercase tracking-widest mb-1">AI Diagnostic</p>
              <p className="text-xs italic font-serif text-zinc-800 line-clamp-2">"{pinnedTask.riskReasoning}"</p>
            </div>
            
            <div className="flex md:flex-col gap-2 shrink-0 pt-2 md:pt-0 border-t md:border-t-0 md:pl-4 border-black/5">
              {pinnedTask.status === 'not started' ? (
                <button
                  onClick={() => handleStatusChange(pinnedTask.id, 'in progress')}
                  className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest bg-black text-white hover:bg-zinc-800 transition-colors cursor-pointer flex items-center justify-center gap-1"
                >
                  <Play className="w-3 h-3 fill-white" /> Start
                </button>
              ) : (
                <span className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest text-sky-800 bg-sky-50 border border-sky-200 flex items-center justify-center gap-1">
                  ⚡ Active
                </span>
              )}
              <button
                onClick={() => handleStatusChange(pinnedTask.id, 'done')}
                className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-widest border border-zinc-300 text-zinc-800 hover:bg-black hover:text-white transition-colors cursor-pointer flex items-center justify-center gap-1"
              >
                <Check className="w-3 h-3" /> Done
              </button>
            </div>
          </div>
        ) : (
          <div className="bg-white dark:bg-zinc-900 border border-black/5 dark:border-white/5 p-4 rounded-none flex items-center gap-4 max-w-xl shadow-xs" id="clear-hero-banner">
            <div className="bg-emerald-600 text-white px-2.5 py-1 text-[9px] font-black uppercase rotate-[-2deg]">
              Status Clear
            </div>
            <div>
              <h2 className="text-xs font-bold leading-tight">No Urgent Threats Outstanding</h2>
              <p className="text-[11px] opacity-60 mt-0.5">All tracked tasks are completed or comfortably padded.</p>
            </div>
          </div>
        )}

        {/* Metrics & Actions Section */}
        <div className="flex flex-col items-end gap-2 shrink-0 self-stretch lg:self-auto">
          <div className="flex gap-6 self-center lg:self-auto">
            <div className="text-center">
              <p className="text-3xl font-black">{criticalTasks.length.toString().padStart(2, '0')}</p>
              <p className="text-[9px] uppercase tracking-wider font-bold text-red-600">Critical</p>
            </div>
            <div className="text-center">
              <p className="text-3xl font-black">{urgentTasks.length.toString().padStart(2, '0')}</p>
              <p className="text-[9px] uppercase tracking-wider font-bold text-orange-500">Urgent</p>
            </div>
            <div className="text-center">
              <p className="text-3xl font-black">{stableTasks.length.toString().padStart(2, '0')}</p>
              <p className="text-[9px] uppercase tracking-wider font-bold opacity-40">Stable</p>
            </div>
            <div className="text-center">
              <p className="text-3xl font-black">{finishedTasks.length.toString().padStart(2, '0')}</p>
              <p className="text-[9px] uppercase tracking-wider font-bold text-emerald-600">Finished</p>
            </div>
          </div>
          
          <div className="flex items-center gap-2 mt-2 w-full sm:w-auto">
            <button
              onClick={handleManualRecompute}
              disabled={recomputing}
              className={`flex-1 sm:flex-none px-4 py-2 text-[10px] font-bold uppercase tracking-widest border transition-all cursor-pointer ${
                recomputing
                  ? 'bg-amber-50 border-amber-300 text-amber-700 animate-pulse'
                  : 'bg-white dark:bg-zinc-900 hover:bg-zinc-100 dark:hover:bg-zinc-800 border-black/10 dark:border-white/10 text-zinc-700 dark:text-zinc-300 hover:text-black dark:hover:text-white'
              }`}
              title="Run server-side AI scanning"
              id="manual-ai-scan-btn"
            >
              {recomputing ? 'Recalculating...' : 'Run AI Risk Scan'}
            </button>

            <button
              onClick={openAddModal}
              className="flex-1 sm:flex-none px-5 py-2 bg-black text-white text-[10px] font-bold uppercase tracking-widest hover:bg-zinc-800 transition-colors cursor-pointer"
              id="deploy-new-task-btn"
            >
              + New Rescue
            </button>
          </div>
        </div>
      </header>

      {/* View Toggle */}
      <div className="flex justify-center mb-6">
        <div className="bg-zinc-200/50 dark:bg-zinc-800 p-1 flex gap-1 rounded-sm">
          <button
            onClick={() => setActiveView('tasks')}
            className={`px-6 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${
              activeView === 'tasks' ? 'bg-white dark:bg-zinc-700 shadow-sm text-black dark:text-white' : 'text-zinc-500 hover:text-black dark:hover:text-white'
            }`}
          >
            Triage Board
          </button>
          <button
            onClick={() => setActiveView('habits')}
            className={`px-6 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${
              activeView === 'habits' ? 'bg-white dark:bg-zinc-700 shadow-sm text-black dark:text-white' : 'text-zinc-500 hover:text-black dark:hover:text-white'
            }`}
          >
            Goals & Habits
          </button>
          <button
            onClick={() => setActiveView('insights')}
            className={`px-6 py-2 text-[10px] font-bold uppercase tracking-widest transition-all ${
              activeView === 'insights' ? 'bg-white dark:bg-zinc-700 shadow-sm text-black dark:text-white' : 'text-zinc-500 hover:text-black dark:hover:text-white'
            }`}
          >
            Effort Insights
          </button>
        </div>
      </div>

      {/* 2. BODY CONTENT PANEL */}
      <main className="flex-1 flex flex-col space-y-6" id="dashboard-content">
        {activeView === 'habits' ? (
          <HabitsTracker 
            userId={user ? user.uid : null} 
            initialHabits={habits}
            onHabitsChange={setHabits}
          />
        ) : activeView === 'insights' ? (
          <EffortChart tasks={tasks} />
        ) : (
          <>
            {/* SEARCH & FILTERS CONTROLS */}
        <div className="bg-white dark:bg-zinc-900 border border-black/10 dark:border-white/10 p-4 flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 shadow-2xs" id="board-filters-bar">
          
          <div className="flex flex-1 flex-col sm:flex-row gap-3">
            {/* Search Input */}
            <div className="relative flex-1">
              <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-400">
                <Search className="w-4 h-4" />
              </span>
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search triage board..."
                className="w-full pl-9 pr-4 py-2 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition"
              />
            </div>

            {/* Category Select */}
            <div className="relative">
              <select
                value={selectedCategory}
                onChange={(e) => setSelectedCategory(e.target.value)}
                className="w-full sm:w-48 px-3 py-2 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-sans"
              >
                <option value="all">📁 All Categories</option>
                <option value="assignment">📚 Assignments</option>
                <option value="work">💼 Work / Corporate</option>
                <option value="bill">💳 Bills & Expenses</option>
                <option value="interview">🤝 Interviews</option>
                <option value="personal">🌸 Personal Development</option>
                <option value="other">🏷️ Other Tasks</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-4 shrink-0 justify-between sm:justify-start">
            <label className="flex items-center gap-2 text-xs font-bold text-zinc-700 cursor-pointer select-none uppercase tracking-wider">
              <input
                type="checkbox"
                checked={showDone}
                onChange={(e) => setShowDone(e.target.checked)}
                className="rounded-none border-black/30 text-black focus:ring-0 w-4 h-4"
              />
              Show Completed
            </label>
          </div>

        </div>

        {/* NON-BLOCKING CALENDAR CONNECT PROMPT */}
        {!calendarConnected && (
          <div 
            className="bg-amber-50/60 border border-amber-200/80 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4 animate-fade-in" 
            id="connect-calendar-prompt"
          >
            <div className="flex items-start gap-3">
              <Calendar className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-zinc-900 uppercase tracking-widest">Connect Calendar for smarter risk scoring</p>
                <p className="text-[11px] text-zinc-600 mt-1 leading-relaxed">
                  Authorize Flare to scan your scheduled meetings. We'll compute your actual available hours (subtracting calendar busy blocks) to precisely assess your deadline risks.
                </p>
              </div>
            </div>
            <button
              onClick={handleConnectCalendar}
              className="px-4 py-2 bg-amber-800 hover:bg-amber-900 text-white transition-colors text-[10px] font-extrabold uppercase tracking-widest cursor-pointer self-start sm:self-auto shrink-0"
            >
              Connect Calendar
            </button>
          </div>
        )}

        {/* LOADING INDICATOR */}
        {loading && tasks.length === 0 && (
          <div className="flex items-center justify-center py-12 text-zinc-500 text-xs gap-2 font-mono">
            <RefreshCw className="w-4 h-4 animate-spin text-zinc-400" />
            Loading triage logs...
          </div>
        )}

        {/* BOARD LAYOUT WITH DYNAMIC COLUMNS */}
        {(!loading || tasks.length > 0) && (
          <div className={`grid grid-cols-1 md:grid-cols-2 ${showDone ? 'xl:grid-cols-4 lg:grid-cols-3' : 'lg:grid-cols-3'} gap-8 items-start ${loading ? 'opacity-70 pointer-events-none' : ''}`} id="triage-board-columns">
            
            {/* COLUMN 1: CRITICAL */}
            <section className="flex flex-col gap-4" id="col-critical">
              
              {/* Column Header */}
              <div className="flex justify-between items-baseline mb-2 border-b-2 border-red-500 pb-2">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-lg font-black uppercase tracking-tighter text-zinc-900 dark:text-zinc-100">01. Critical</h3>
                  <span className="text-xs font-bold font-mono text-red-600 dark:text-red-500">({criticalTasks.length})</span>
                </div>
                <span className="text-[10px] font-mono opacity-50 italic">At Risk ({criticalHours}h)</span>
              </div>

              {/* Tasks List */}
              <div 
                className="flex flex-col gap-4 min-h-[300px]"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, 'Critical')}
              >
                {criticalTasks.length > 0 ? (
                  criticalTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onEdit={openEditModal}
                      onDelete={handleDeleteTask}
                      onStatusChange={handleStatusChange}
                      onSchedule={handleScheduleTask}
                    />
                  ))
                ) : (
                  <div className="flex-1 border border-dashed border-black/10 dark:border-white/10 rounded-none bg-white/40 dark:bg-white/5 flex flex-col items-center justify-center p-8 text-center text-zinc-400 dark:text-zinc-500">
                    <p className="text-xs font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-300">No Critical Threats</p>
                    <p className="text-[10px] mt-1 max-w-[180px] font-sans">All active items have a comfortable timeline buffer.</p>
                  </div>
                )}
              </div>

            </section>
 
            {/* COLUMN 2: URGENT */}
            <section className="flex flex-col gap-4" id="col-urgent">
              
              {/* Column Header */}
              <div className="flex justify-between items-baseline mb-2 border-b border-orange-400 pb-2">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-lg font-black uppercase tracking-tighter text-zinc-900 dark:text-zinc-100">02. Urgent</h3>
                  <span className="text-xs font-bold font-mono text-orange-500">({urgentTasks.length})</span>
                </div>
                <span className="text-[10px] font-mono opacity-50 italic">Due &lt; 48h ({urgentHours}h)</span>
              </div>

              {/* Tasks List */}
              <div 
                className="flex flex-col gap-4 min-h-[300px]"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, 'Urgent')}
              >
                {urgentTasks.length > 0 ? (
                  urgentTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onEdit={openEditModal}
                      onDelete={handleDeleteTask}
                      onStatusChange={handleStatusChange}
                      onSchedule={handleScheduleTask}
                    />
                  ))
                ) : (
                  <div className="flex-1 border border-dashed border-black/10 dark:border-white/10 rounded-none bg-white/40 dark:bg-white/5 flex flex-col items-center justify-center p-8 text-center text-zinc-400 dark:text-zinc-500">
                    <p className="text-xs font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-300">No Urgent Backlogs</p>
                    <p className="text-[10px] mt-1 max-w-[180px] font-sans">Nothing pressing due today or tomorrow.</p>
                  </div>
                )}
              </div>

            </section>
 
            {/* COLUMN 3: STABLE */}
            <section className="flex flex-col gap-4" id="col-stable">
              
              {/* Column Header */}
              <div className="flex justify-between items-baseline mb-2 border-b border-black/20 dark:border-white/20 pb-2">
                <div className="flex items-baseline gap-2">
                  <h3 className="text-lg font-black uppercase tracking-tighter text-zinc-900 dark:text-zinc-100">03. Stable</h3>
                  <span className="text-xs font-bold font-mono text-zinc-500 dark:text-zinc-400">({stableTasks.length})</span>
                </div>
                <span className="text-[10px] font-mono opacity-50 italic">On Track ({stableHours}h)</span>
              </div>

              {/* Tasks List */}
              <div 
                className="flex flex-col gap-4 min-h-[300px]"
                onDragOver={handleDragOver}
                onDrop={(e) => handleDrop(e, 'Stable')}
              >
                {stableTasks.length > 0 ? (
                  stableTasks.map(task => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      onEdit={openEditModal}
                      onDelete={handleDeleteTask}
                      onStatusChange={handleStatusChange}
                      onSchedule={handleScheduleTask}
                    />
                  ))
                ) : (
                  <div className="flex-1 border border-dashed border-black/10 dark:border-white/10 rounded-none bg-white/40 dark:bg-white/5 flex flex-col items-center justify-center p-8 text-center text-zinc-400 dark:text-zinc-500">
                    <p className="text-xs font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-300">No Stable Tasks</p>
                    <p className="text-[10px] mt-1 max-w-[180px] font-sans">Deploy tasks to watch their buffer values change.</p>
                  </div>
                )}
              </div>

            </section>

            {/* COLUMN 4: FINISHED */}
            {showDone && (
              <section className="flex flex-col gap-4" id="col-finished">
                
                {/* Column Header */}
                <div className="flex justify-between items-baseline mb-2 border-b border-emerald-500 pb-2">
                  <div className="flex items-baseline gap-2">
                    <h3 className="text-lg font-black uppercase tracking-tighter text-zinc-900 dark:text-zinc-100">04. Finished</h3>
                    <span className="text-xs font-bold font-mono text-emerald-600 dark:text-emerald-500">({finishedTasks.length})</span>
                  </div>
                  <span className="text-[10px] font-mono opacity-50 italic">Completed ({finishedHours}h)</span>
                </div>

                {/* Tasks List */}
                <div className="flex flex-col gap-4 min-h-[300px]">
                  {finishedTasks.length > 0 ? (
                    finishedTasks.map(task => (
                      <TaskCard
                        key={task.id}
                        task={task}
                        onEdit={openEditModal}
                        onDelete={handleDeleteTask}
                        onStatusChange={handleStatusChange}
                        onSchedule={handleScheduleTask}
                      />
                    ))
                  ) : (
                    <div className="flex-1 border border-dashed border-black/10 dark:border-white/10 rounded-none bg-white/40 dark:bg-white/5 flex flex-col items-center justify-center p-8 text-center text-zinc-400 dark:text-zinc-500">
                      <p className="text-xs font-bold uppercase tracking-wider text-zinc-800 dark:text-zinc-300">No Finished Tasks</p>
                      <p className="text-[10px] mt-1 max-w-[180px] font-sans">Complete tasks to see them archived here.</p>
                    </div>
                  )}
                </div>

              </section>
            )}
 
          </div>
        )}
          </>
        )}

      </main>

      {/* 5. FOOTER */}
      <footer className="mt-auto flex flex-col sm:flex-row justify-between items-center pt-8 mt-12 border-t border-black/10 gap-4 text-[11px]" id="main-footer">
        <div className="flex flex-col sm:flex-row items-center gap-4 w-full sm:w-auto">
          <div className="flex flex-wrap gap-x-8 gap-y-2 text-[10px] font-bold uppercase tracking-widest opacity-50">
            <span>Sync Status: Live</span>
            <span>AI Triage Active</span>
            <span>User: {user ? (user.email || 'Guest') : 'Guest Session'}</span>
          </div>
          
          {user && (
            <button
              onClick={handleRunSweep}
              disabled={runningSweep}
              className="bg-zinc-900 text-white font-sans text-[10px] font-bold uppercase tracking-wider px-3 py-1.5 rounded-none hover:bg-zinc-800 transition disabled:opacity-50"
            >
              {runningSweep ? 'Running Sweep...' : '⚡ Run rescue sweep now'}
            </button>
          )}
        </div>
        <div className="text-[10px] font-serif italic text-zinc-700">
          "Don't panic. Just prioritize."
        </div>
      </footer>

      {sweepLogs && sweepLogs.length > 0 && (
        <div className="mt-4 p-4 bg-zinc-950 text-zinc-300 font-mono text-[10px] rounded-none max-w-4xl mx-auto w-full border border-white/10 relative">
          <button 
            onClick={() => setSweepLogs(null)}
            className="absolute top-2 right-2 text-zinc-500 hover:text-white"
          >
            ✕ Close Logs
          </button>
          <div className="font-bold uppercase tracking-wider text-white mb-2 pb-1 border-b border-white/10 flex items-center gap-2">
            <span>Rescue Agent Sweep Terminal Logs</span>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse"></span>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1">
            {sweepLogs.map((log, index) => (
              <div key={index} className="leading-relaxed whitespace-pre-wrap">{log}</div>
            ))}
          </div>
        </div>
      )}

      {/* 6. FORM DIALOG/MODAL FOR ADDING AND EDITING */}
      <TaskFormModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSave={handleSaveTask}
        taskToEdit={taskToEdit}
      />

      {/* 7. FLOATING TOAST CONFIRMATION */}
      {toast && (
        <div 
          className="fixed bottom-6 left-6 z-50 bg-[#1A1A1A] text-[#F9F8F6] px-5 py-4 border border-zinc-800 shadow-2xl max-w-sm flex flex-col gap-2 animate-slide-up" 
          id="toast-notification"
        >
          <div className="flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold leading-snug">{toast.message}</p>
              {toast.link && (
                <a 
                  href={toast.link} 
                  target="_blank" 
                  rel="noopener noreferrer" 
                  className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-400 hover:underline flex items-center gap-1 mt-1.5 inline-flex"
                  id="toast-calendar-link"
                >
                  View on Google Calendar <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Voice Assistant */}
      <VoiceAssistant onTaskCreate={async (payload) => {
        await handleSaveTask({
          title: payload.title || 'Voice Task',
          description: payload.description || '',
          deadline: payload.deadline || new Date(Date.now() + 86400000).toISOString(),
          estimatedEffort: payload.estimatedEffort || 1,
          category: 'work',
          status: 'not started'
        });
      }} />

    </div>
  );
}
