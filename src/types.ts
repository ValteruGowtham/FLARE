export type TaskCategory = 'assignment' | 'work' | 'bill' | 'interview' | 'personal' | 'other';

export type TaskStatus = 'not started' | 'in progress' | 'done';

export type TaskRiskScore = 'Critical' | 'Urgent' | 'Stable';

export interface Task {
  id: string;
  userId: string;
  title: string;
  description?: string;
  deadline: string; // ISO string (YYYY-MM-DDTHH:mm)
  estimatedEffort: number; // in hours
  category: TaskCategory;
  status: TaskStatus;
  riskScore: TaskRiskScore;
  riskReasoning: string;
  createdAt: string; // ISO string
  updatedAt: string; // ISO string
  busyIntervals?: Array<{ start: string; end: string }>;
  scheduledEventId?: string;
  scheduledEventLink?: string;
  autoScheduled?: boolean;
  lastNotifiedAt?: string;
  draftRescheduleEmailSubject?: string | null;
  draftRescheduleEmailBody?: string | null;
  extensionEmailSentAt?: string;
  manualRiskOverride?: boolean;
  notes?: string;
}

export interface UserProfile {
  uid: string;
  email: string | null;
  displayName: string | null;
}

export interface Habit {
  id: string;
  userId: string;
  title: string;
  frequency: 'daily' | 'weekly';
  target: number;
  completedDates: string[]; // Array of YYYY-MM-DD
  createdAt: string;
  updatedAt: string;
}
