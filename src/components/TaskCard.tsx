import React, { useState, useEffect } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Task, TaskCategory, TaskStatus } from '../types.js';
import { 
  AlertTriangle, 
  Clock, 
  Sparkles, 
  ChevronDown, 
  ChevronUp, 
  Edit, 
  Trash2, 
  CheckCircle, 
  Briefcase, 
  BookOpen, 
  CreditCard, 
  UserCheck, 
  Smile, 
  Tag, 
  Play, 
  Check,
  Calendar,
  ExternalLink,
  Copy
} from 'lucide-react';

import { auth } from '../firebase.js';

interface TaskCardProps {
  key?: string;
  task: Task;
  onEdit: (task: Task) => void;
  onDelete: (taskId: string) => void | Promise<void>;
  onStatusChange: (taskId: string, newStatus: TaskStatus) => void | Promise<void>;
  onSchedule?: (task: Task) => void | Promise<void>;
}

export default function TaskCard({ task, onEdit, onDelete, onStatusChange, onSchedule }: TaskCardProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [timeText, setTimeText] = useState('');
  const [isOverdue, setIsOverdue] = useState(false);
  const [isCopied, setIsCopied] = useState(false);
  
  const [recipientEmail, setRecipientEmail] = useState('');
  const [sendingDraft, setSendingDraft] = useState(false);
  const [draftSent, setDraftSent] = useState(!!task.extensionEmailSentAt);

  const handleCopyNotes = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (task.notes) {
      await navigator.clipboard.writeText(task.notes);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  const handleSendDraftEmail = async () => {
    setSendingDraft(true);
    try {
      const token = await auth.currentUser?.getIdToken();
      const headers: HeadersInit = {
        'Content-Type': 'application/json'
      };
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      let googleTokens = { accessToken: '', refreshToken: '' };
      const { db } = await import('../firebase');
      const { doc, getDoc, updateDoc, setDoc } = await import('firebase/firestore');
      
      if (auth.currentUser) {
        const tokenDoc = await getDoc(doc(db, 'user_tokens', auth.currentUser.uid));
        if (tokenDoc.exists()) {
          const data = tokenDoc.data();
          const cachedToken = localStorage.getItem('google_calendar_access_token');
          googleTokens.accessToken = cachedToken || data.accessToken || '';
          googleTokens.refreshToken = data.refreshToken || '';
        }
      }
      
      const fallbackCachedToken = localStorage.getItem('google_calendar_access_token');
      if (!googleTokens.accessToken && fallbackCachedToken) {
        googleTokens.accessToken = fallbackCachedToken;
      }

      const response = await fetch('/api/tasks/send-draft', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          draftSubject: task.draftRescheduleEmailSubject,
          draftBody: task.draftRescheduleEmailBody,
          recipientEmail: recipientEmail,
          googleAccessToken: googleTokens.accessToken,
          googleRefreshToken: googleTokens.refreshToken
        })
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to send draft');
      }

      const data = await response.json();
      
      if (data.newAccessToken && auth.currentUser) {
        await setDoc(doc(db, 'user_tokens', auth.currentUser.uid), {
          accessToken: data.newAccessToken,
          updatedAt: new Date().toISOString()
        }, { merge: true }).catch(console.error);
      }

      // Update task in Firestore to remove draft
      if (auth.currentUser) {
        await updateDoc(doc(db, 'tasks', task.id), {
          draftRescheduleEmailSubject: null,
          draftRescheduleEmailBody: null,
          extensionEmailSentAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }

      setDraftSent(true);
      alert('Extension request email has been sent successfully via Gmail!');
    } catch (err: any) {
      console.error('Failed to send draft email:', err);
      alert(`Failed to send email: ${err.message || err}`);
    } finally {
      setSendingDraft(false);
    }
  };

  // Map category to nice icon and styling
  const getCategoryMeta = (cat: TaskCategory) => {
    switch (cat) {
      case 'assignment':
        return { icon: BookOpen, bg: 'bg-indigo-50 text-indigo-700 border-indigo-100', label: 'Assignment' };
      case 'work':
        return { icon: Briefcase, bg: 'bg-sky-50 text-sky-700 border-sky-100', label: 'Work' };
      case 'bill':
        return { icon: CreditCard, bg: 'bg-emerald-50 text-emerald-700 border-emerald-100', label: 'Bill' };
      case 'interview':
        return { icon: UserCheck, bg: 'bg-purple-50 text-purple-700 border-purple-100', label: 'Interview' };
      case 'personal':
        return { icon: Smile, bg: 'bg-pink-50 text-pink-700 border-pink-100', label: 'Personal' };
      default:
        return { icon: Tag, bg: 'bg-slate-50 text-slate-700 border-slate-100', label: 'Other' };
    }
  };

  const catMeta = getCategoryMeta(task.category);
  const CatIcon = catMeta.icon;

  // Calculate and update relative time countdown
  useEffect(() => {
    const calculateTimeRemaining = () => {
      const deadlineDate = new Date(task.deadline);
      const now = new Date();
      const diffMs = deadlineDate.getTime() - now.getTime();
      const diffHrs = diffMs / (1000 * 60 * 60);

      if (task.status === 'done') {
        setTimeText('Complete');
        setIsOverdue(false);
        return;
      }

      if (diffHrs < 0) {
        setIsOverdue(true);
        const absHours = Math.abs(diffHrs);
        if (absHours < 24) {
          setTimeText(`Overdue by ${Math.round(absHours)}h`);
        } else {
          setTimeText(`Overdue by ${Math.round(absHours / 24)}d`);
        }
      } else {
        setIsOverdue(false);
        if (diffHrs < 1) {
          setTimeText(`Due in ${Math.round(diffHrs * 60)}m`);
        } else if (diffHrs < 24) {
          setTimeText(`Due in ${Math.round(diffHrs)}h`);
        } else {
          setTimeText(`Due in ${Math.round(diffHrs / 24)}d`);
        }
      }
    };

    calculateTimeRemaining();
    const interval = setInterval(calculateTimeRemaining, 60000); // refresh every minute
    return () => clearInterval(interval);
  }, [task.deadline, task.status]);

  // Risk-specific styling
  const getRiskStyles = () => {
    if (task.status === 'done') {
      return {
        border: 'border-black/10 dark:border-white/10 opacity-60',
        badge: 'bg-zinc-100 dark:bg-zinc-800 text-zinc-500 dark:text-zinc-400 text-[9px]',
        accent: 'bg-zinc-200 dark:bg-zinc-700',
        badgeLabel: 'Complete'
      };
    }

    switch (task.riskScore) {
      case 'Critical':
        return {
          border: 'border-red-500/40 border-l-[3px] border-l-red-500',
          badge: 'bg-red-500 text-white text-[9px] font-black uppercase rotate-[-2deg]',
          accent: 'bg-red-500',
          badgeLabel: 'Critical'
        };
      case 'Urgent':
        return {
          border: 'border-amber-500/40 border-l-[3px] border-l-amber-500',
          badge: 'bg-amber-500 text-white text-[9px] font-black uppercase',
          accent: 'bg-amber-500',
          badgeLabel: 'Urgent'
        };
      default:
        return {
          border: 'border-black/10 dark:border-white/10',
          badge: 'bg-zinc-800 dark:bg-zinc-700 text-white text-[9px] font-black uppercase',
          accent: 'bg-zinc-800 dark:bg-zinc-700',
          badgeLabel: 'Stable'
        };
    }
  };

  const riskStyles = getRiskStyles();

  return (
    <div 
      className={`bg-white dark:bg-zinc-900 rounded-none border border-black/10 dark:border-white/10 p-5 transition-all duration-200 hover:shadow-md space-y-4 cursor-grab active:cursor-grabbing ${riskStyles.border}`} 
      id={`task-card-${task.id}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('taskId', task.id);
        e.dataTransfer.effectAllowed = 'move';
      }}
    >
      {/* Card Header: Category & Risk Indicators */}
      <div className="flex justify-between items-start" id={`card-header-${task.id}`}>
        <div>
          <span className="text-[10px] font-bold px-2.5 py-1 bg-zinc-100 dark:bg-zinc-800 uppercase tracking-wider text-zinc-800 dark:text-zinc-300 border border-black/5 dark:border-white/5">
            {catMeta.label}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-[10px] font-mono uppercase tracking-widest px-2 py-0.5 font-bold ${riskStyles.badge}`}>
            {riskStyles.badgeLabel}
          </span>
          {task.status !== 'done' && task.riskScore === 'Critical' && (
            <span className="w-1.5 h-1.5 rounded-full bg-red-600 radar-pulse shrink-0" />
          )}
        </div>
      </div>

      {/* Task Content */}
      <div className="space-y-1.5" id={`card-content-${task.id}`}>
        <h3 className={`text-base font-bold text-zinc-950 dark:text-zinc-50 tracking-tight leading-tight font-sans ${task.status === 'done' ? 'line-through opacity-40 text-zinc-500' : ''}`}>
          {task.title}
        </h3>
        {task.description && (
          <p className="text-xs text-zinc-600 dark:text-zinc-400 font-sans leading-relaxed line-clamp-3">
            {task.description}
          </p>
        )}
        {task.notes && (
          <div className="mt-2 text-xs text-zinc-700 dark:text-zinc-300 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 p-3 markdown-body relative group">
            <button
              onClick={handleCopyNotes}
              className="absolute top-2 right-2 p-1.5 bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 text-zinc-400 dark:text-zinc-500 hover:text-black dark:hover:text-white shadow-sm opacity-0 group-hover:opacity-100 transition-opacity"
              title="Copy Notes"
            >
              {isCopied ? <Check className="w-3.5 h-3.5 text-green-600 dark:text-green-500" /> : <Copy className="w-3.5 h-3.5" />}
            </button>
            <Markdown remarkPlugins={[remarkGfm]}>{task.notes}</Markdown>
          </div>
        )}
      </div>

      {/* Math & Deadline Metrics */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-zinc-500 dark:text-zinc-400 border-t border-black/5 dark:border-white/5 pt-3 font-mono" id={`card-metrics-${task.id}`}>
        <div className="flex items-center gap-1">
          <Clock className="w-3.5 h-3.5 text-zinc-400" />
          <span className={isOverdue && task.status !== 'done' ? 'text-red-600 font-bold' : 'opacity-70'}>
            {timeText}
          </span>
        </div>
        <div className="flex items-center gap-1 opacity-70">
          <span>⏱️ {task.estimatedEffort}h effort</span>
        </div>
      </div>

      {/* AI Reasoning (Expandable Note) */}
      <div className="pt-1" id={`ai-reasoning-${task.id}`}>
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between text-[10px] font-black uppercase tracking-widest text-zinc-400 hover:text-zinc-900 transition-colors"
        >
          <span className="font-sans flex items-center gap-1">
            <Sparkles className="w-3.5 h-3.5 text-red-500 fill-red-500/10" />
            AI Diagnostic
          </span>
          <span className="font-mono text-[9px]">{isExpanded ? '[-]' : '[+]'}</span>
        </button>

        {isExpanded && (
          <p className="mt-2 text-xs italic font-serif text-zinc-800 leading-relaxed bg-[#FDFDFD] border border-black/5 p-3 animate-fade-in shadow-2xs">
            "{task.riskReasoning}"
          </p>
        )}
      </div>

      {task.draftRescheduleEmailSubject && task.draftRescheduleEmailBody && (
        <div className="border border-dashed border-amber-500 bg-amber-50/40 p-4 mt-3 space-y-3 text-xs">
          <div className="flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-amber-800">
            <span className="flex items-center gap-1">📬 Reschedule Draft Ready</span>
            {sendingDraft ? (
              <span className="animate-pulse">Sending...</span>
            ) : draftSent ? (
              <span className="text-emerald-700 font-bold">✓ Sent</span>
            ) : null}
          </div>
          
          <div className="space-y-1 bg-white p-3 border border-black/5 font-sans text-zinc-700 max-h-36 overflow-y-auto leading-relaxed">
            <div><strong>Subject:</strong> {task.draftRescheduleEmailSubject}</div>
            <div className="border-t border-black/5 my-1.5 pt-1.5 font-sans" dangerouslySetInnerHTML={{ __html: task.draftRescheduleEmailBody }} />
          </div>

          {!draftSent ? (
            <div className="flex flex-col sm:flex-row gap-2 pt-1.5">
              <input
                type="email"
                placeholder="Recipient email (e.g., manager@company.com)"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
                className="flex-1 bg-white px-2.5 py-1.5 text-xs border border-zinc-300 rounded-none focus:outline-none focus:border-zinc-800 font-sans"
              />
              <button
                onClick={handleSendDraftEmail}
                disabled={sendingDraft}
                className="bg-amber-600 hover:bg-amber-700 text-white text-[10px] font-bold uppercase tracking-wider px-4 py-1.5 cursor-pointer transition disabled:opacity-50 shrink-0 rounded-none"
              >
                Send via Gmail
              </button>
            </div>
          ) : (
            <div className="text-[10px] text-emerald-700 font-bold uppercase tracking-wider flex items-center gap-1">
              <span>✓ Extension request email sent successfully via Gmail!</span>
            </div>
          )}
        </div>
      )}

      {/* Card Actions Footer */}
      <div className="flex items-center justify-between border-t border-black/5 pt-4" id={`card-footer-${task.id}`}>
        {/* Status toggles */}
        <div className="flex items-center flex-wrap gap-2">
          {task.status !== 'done' ? (
            <>
              {task.status === 'not started' ? (
                <button
                  onClick={() => onStatusChange(task.id, 'in progress')}
                  className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest bg-black text-white hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  Start
                </button>
              ) : (
                <span className="text-[10px] font-bold uppercase tracking-wider text-sky-800 bg-sky-50 border border-sky-200 px-2.5 py-1 shrink-0">
                  ⚡ Active
                </span>
              )}
              <button
                onClick={() => onStatusChange(task.id, 'done')}
                className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest border border-zinc-300 text-zinc-800 hover:bg-black hover:text-white hover:border-black transition-colors cursor-pointer mr-1"
              >
                Done
              </button>
              {onSchedule && (
                task.scheduledEventLink ? (
                  <div className="flex items-center gap-1 bg-emerald-50 text-emerald-800 border border-emerald-200 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wider">
                    <CheckCircle className="w-3.5 h-3.5 text-emerald-600" />
                    <a href={task.scheduledEventLink} target="_blank" rel="noopener noreferrer" className="hover:underline flex items-center gap-0.5" id={`calendar-link-${task.id}`}>
                      Scheduled <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                    <button
                      onClick={() => onSchedule(task)}
                      className="ml-1.5 hover:underline text-zinc-500 hover:text-zinc-950 font-mono text-[9px] cursor-pointer"
                      title="Reschedule event in the next available slot"
                    >
                      [Re]
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => onSchedule(task)}
                    className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest bg-amber-50 border border-amber-200 text-amber-800 hover:bg-amber-100 transition-colors cursor-pointer flex items-center gap-1"
                    title="Find next free calendar slot and schedule"
                    id={`schedule-btn-${task.id}`}
                  >
                    <Calendar className="w-3 h-3" /> Schedule
                  </button>
                )
              )}
            </>
          ) : (
            <button
              onClick={() => onStatusChange(task.id, 'not started')}
              className="px-2.5 py-1 text-[10px] font-bold uppercase tracking-widest bg-[#EFEFEF] text-zinc-700 hover:bg-zinc-200 transition-colors cursor-pointer"
            >
              ✓ Complete
            </button>
          )}
        </div>

        {/* Edit and Delete */}
        <div className="flex items-center gap-1.5">
          <button
            onClick={() => onEdit(task)}
            className="p-1 text-zinc-400 hover:text-zinc-900 transition-colors cursor-pointer"
            title="Edit Task"
          >
            <Edit className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => onDelete(task.id)}
            className="p-1 text-zinc-400 hover:text-red-600 transition-colors cursor-pointer"
            title="Delete Task"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
