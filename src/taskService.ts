import { 
  collection, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  getDocs, 
  query, 
  where,
  writeBatch
} from 'firebase/firestore';
import { db } from './firebase.js';
import { Task, TaskCategory, TaskStatus, TaskRiskScore } from './types.js';

// --- Client API Callers to full-stack backend ---

/**
 * Request server-side AI evaluation for a single task
 */
export async function evaluateTask(task: {
  title: string;
  description?: string;
  deadline: string;
  estimatedEffort: number;
  category: TaskCategory;
  status: TaskStatus;
  busyIntervals?: Array<{ start: string; end: string }>;
}): Promise<{ riskScore: TaskRiskScore; reasoning: string }> {
  try {
    const response = await fetch('/api/evaluate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task, currentTime: new Date().toISOString() }),
    });
    
    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }
    
    return await response.json();
  } catch (error) {
    console.error('Error in evaluateTask client API:', error);
    return getHeuristicFallback(task);
  }
}

/**
 * Request server-side AI evaluation for a list of tasks in a single batch
 */
export async function evaluateTaskBatch(
  tasks: Array<{ 
    id: string; 
    title: string; 
    description?: string; 
    deadline: string; 
    estimatedEffort: number; 
    category: TaskCategory; 
    status: TaskStatus;
    busyIntervals?: Array<{ start: string; end: string }>;
  }>
): Promise<Array<{ id: string; riskScore: TaskRiskScore; reasoning: string }>> {
  if (tasks.length === 0) return [];
  try {
    const response = await fetch('/api/evaluate-batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tasks, currentTime: new Date().toISOString() }),
    });

    if (!response.ok) {
      throw new Error(`API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.evaluations;
  } catch (error) {
    console.error('Error in evaluateTaskBatch client API:', error);
    // Map tasks to individual fallbacks
    return tasks.map(t => ({
      id: t.id,
      ...getHeuristicFallback(t)
    }));
  }
}

/**
 * Mathematical local client-side fallback heuristic
 */
function getHeuristicFallback(task: {
  deadline: string;
  estimatedEffort: number;
  status: TaskStatus;
}): { riskScore: TaskRiskScore; reasoning: string } {
  if (task.status === 'done') {
    return { riskScore: 'Stable', reasoning: 'Task is complete.' };
  }

  const deadlineDate = new Date(task.deadline);
  const currentDate = new Date();
  const remainingHours = (deadlineDate.getTime() - currentDate.getTime()) / (1000 * 60 * 60);

  let score: TaskRiskScore = 'Stable';
  if (remainingHours <= 0) {
    score = 'Critical';
  } else if (task.estimatedEffort >= remainingHours) {
    score = 'Critical';
  } else if (remainingHours <= 24) {
    score = 'Critical';
  } else if (remainingHours <= 48) {
    score = 'Urgent';
  } else if (remainingHours - task.estimatedEffort < 6) {
    score = 'Urgent';
  }

  const hrsLeft = Math.round(remainingHours);
  const eff = task.estimatedEffort;
  
  let reason = '';
  if (hrsLeft <= 0) {
    reason = 'Deadline passed!';
  } else {
    const buffer = Math.round(hrsLeft - eff);
    if (buffer < 0) {
      reason = `${eff}h needed, only ${hrsLeft}h left! (fallback)`;
    } else {
      reason = `${eff}h needed, ${hrsLeft}h left — ${buffer}h buffer (fallback).`;
    }
  }

  return { riskScore: score, reasoning: reason };
}

// --- Task Data Store Managers ---

/**
 * Fetch tasks either from Firestore (if signed in) or LocalStorage (for Guest mode)
 */
export async function fetchTasks(userId: string | null): Promise<Task[]> {
  if (!userId) {
    // Guest Mode - read from local storage
    const local = localStorage.getItem('flare_guest_tasks');
    if (!local) return [];
    try {
      return JSON.parse(local);
    } catch {
      return [];
    }
  }

  try {
    const q = query(collection(db, 'tasks'), where('userId', '==', userId));
    const snapshot = await getDocs(q);
    const tasks: Task[] = [];
    snapshot.forEach((docSnap) => {
      tasks.push({
        id: docSnap.id,
        ...docSnap.data()
      } as Task);
    });
    return tasks;
  } catch (error) {
    console.error('Error fetching tasks from Firestore:', error);
    // Safe fallback to local storage
    const local = localStorage.getItem(`flare_cached_tasks_${userId}`);
    if (local) {
      try { return JSON.parse(local); } catch { return []; }
    }
    return [];
  }
}

/**
 * Add a new task
 */
export async function createTask(
  userId: string | null, 
  taskData: Omit<Task, 'id' | 'userId' | 'createdAt' | 'updatedAt' | 'riskScore' | 'riskReasoning'>,
  busyIntervals?: Array<{ start: string; end: string }>
): Promise<Task> {
  // First, fetch its initial risk evaluation from server
  const evaluation = await evaluateTask({
    title: taskData.title,
    description: taskData.description,
    deadline: taskData.deadline,
    estimatedEffort: taskData.estimatedEffort,
    category: taskData.category,
    status: taskData.status,
    busyIntervals,
  });

  const nowStr = new Date().toISOString();
  
  if (!userId) {
    // Guest mode
    const id = `guest_${Math.random().toString(36).substr(2, 9)}`;
    const newTask: Task = {
      id,
      userId: 'guest',
      ...taskData,
      riskScore: evaluation.riskScore,
      riskReasoning: evaluation.reasoning,
      createdAt: nowStr,
      updatedAt: nowStr,
      busyIntervals: busyIntervals || undefined
    };

    const currentTasks = await fetchTasks(null);
    currentTasks.push(newTask);
    localStorage.setItem('flare_guest_tasks', JSON.stringify(currentTasks));
    return newTask;
  }

  // Auth mode
  // Sanitize undefined fields
  const safeData = { ...taskData };
  Object.keys(safeData).forEach(key => {
    if (safeData[key as keyof typeof safeData] === undefined) {
      delete safeData[key as keyof typeof safeData];
    }
  });

  const taskToSave = {
    userId,
    ...safeData,
    riskScore: evaluation.riskScore,
    riskReasoning: evaluation.reasoning,
    createdAt: nowStr,
    updatedAt: nowStr,
    busyIntervals: busyIntervals || null
  };

  const docRef = await addDoc(collection(db, 'tasks'), taskToSave);
  const savedTask: Task = {
    id: docRef.id,
    ...taskToSave,
    busyIntervals: busyIntervals || undefined
  };

  // Keep a local cache copy as well
  const currentTasks = await fetchTasks(userId);
  currentTasks.push(savedTask);
  localStorage.setItem(`flare_cached_tasks_${userId}`, JSON.stringify(currentTasks));

  return savedTask;
}

/**
 * Update an existing task
 */
export async function updateTask(
  userId: string | null, 
  taskId: string, 
  updatedFields: Partial<Omit<Task, 'id' | 'userId' | 'createdAt' | 'updatedAt'>>,
  busyIntervals?: Array<{ start: string; end: string }>
): Promise<Task> {
  const currentTasks = await fetchTasks(userId);
  const existingTask = currentTasks.find(t => t.id === taskId);
  if (!existingTask) {
    throw new Error('Task not found');
  }

  const mergedTask = { ...existingTask, ...updatedFields };
  
  // Re-evaluate risk score if status, deadline, estimatedEffort, title, or busyIntervals changed
  let evaluation = { riskScore: existingTask.riskScore, reasoning: existingTask.riskReasoning };
  
  // If the user manually updated the risk score right now, use it and don't re-evaluate
  if (updatedFields.riskScore && updatedFields.manualRiskOverride) {
    evaluation = { riskScore: updatedFields.riskScore, reasoning: 'Manually re-classified by user' };
  } else if (!mergedTask.manualRiskOverride) {
    const hasCrucialFieldChanged = 
      updatedFields.status !== undefined ||
      updatedFields.deadline !== undefined ||
      updatedFields.estimatedEffort !== undefined ||
      updatedFields.title !== undefined ||
      busyIntervals !== undefined;

    if (hasCrucialFieldChanged) {
      evaluation = await evaluateTask({
        title: mergedTask.title,
        description: mergedTask.description,
        deadline: mergedTask.deadline,
        estimatedEffort: mergedTask.estimatedEffort,
        category: mergedTask.category,
        status: mergedTask.status,
        busyIntervals: busyIntervals !== undefined ? busyIntervals : (mergedTask.busyIntervals || undefined),
      });
    }
  } else if (mergedTask.manualRiskOverride) {
    // Retain manual override if it exists and wasn't explicitly changed to something else
    evaluation = { riskScore: mergedTask.riskScore, reasoning: mergedTask.riskReasoning };
  }

  const nowStr = new Date().toISOString();
  const fullyUpdatedTask: Task = {
    ...mergedTask,
    riskScore: evaluation.riskScore,
    riskReasoning: evaluation.reasoning,
    updatedAt: nowStr
  };
  if (busyIntervals !== undefined) {
    fullyUpdatedTask.busyIntervals = busyIntervals;
  }

  if (!userId) {
    // Guest mode
    const remainingTasks = currentTasks.filter(t => t.id !== taskId);
    remainingTasks.push(fullyUpdatedTask);
    localStorage.setItem('flare_guest_tasks', JSON.stringify(remainingTasks));
    return fullyUpdatedTask;
  }

  // Auth mode
  const { id, ...docData } = fullyUpdatedTask;
  // Firestore doesn't like undefined properties, ensure they are deleted
  const sanitizedDocData = { ...docData };
  Object.keys(sanitizedDocData).forEach(key => {
    if (sanitizedDocData[key as keyof typeof sanitizedDocData] === undefined) {
      delete sanitizedDocData[key as keyof typeof sanitizedDocData];
    }
  });
  await updateDoc(doc(db, 'tasks', taskId), sanitizedDocData);

  // Update local cache
  const remainingTasks = currentTasks.filter(t => t.id !== taskId);
  remainingTasks.push(fullyUpdatedTask);
  localStorage.setItem(`flare_cached_tasks_${userId}`, JSON.stringify(remainingTasks));

  return fullyUpdatedTask;
}

/**
 * Delete a task
 */
export async function deleteTask(userId: string | null, taskId: string): Promise<void> {
  const currentTasks = await fetchTasks(userId);
  const updatedTasks = currentTasks.filter(t => t.id !== taskId);

  if (!userId) {
    // Guest mode
    localStorage.setItem('flare_guest_tasks', JSON.stringify(updatedTasks));
    return;
  }

  // Auth mode
  await deleteDoc(doc(db, 'tasks', taskId));
  localStorage.setItem(`flare_cached_tasks_${userId}`, JSON.stringify(updatedTasks));
}

/**
 * Run a batch re-evaluation for all non-done tasks to update risk scores as time passes
 */
export async function reevaluateAllTasks(
  userId: string | null,
  taskBusyIntervalsMap?: Record<string, Array<{ start: string; end: string }>>
): Promise<Task[]> {
  const allTasks = await fetchTasks(userId);
  const activeTasks = allTasks.filter(t => t.status !== 'done' && !t.manualRiskOverride).map(task => {
    const busyIntervals = taskBusyIntervalsMap ? taskBusyIntervalsMap[task.id] : task.busyIntervals;
    return {
      ...task,
      busyIntervals: busyIntervals || undefined
    };
  });
  
  if (activeTasks.length === 0) return allTasks;

  // Run the batch evaluation on the server
  const evaluations = await evaluateTaskBatch(activeTasks);

  const evalMap = new Map<string, { riskScore: TaskRiskScore; reasoning: string }>();
  evaluations.forEach(e => {
    evalMap.set(e.id, { riskScore: e.riskScore, reasoning: e.reasoning });
  });

  const nowStr = new Date().toISOString();
  const updatedTasks = allTasks.map(task => {
    const updatedEval = evalMap.get(task.id);
    if (updatedEval) {
      // Check if anything actually changed
      if (task.riskScore !== updatedEval.riskScore || task.riskReasoning !== updatedEval.reasoning) {
        return {
          ...task,
          riskScore: updatedEval.riskScore,
          riskReasoning: updatedEval.reasoning,
          updatedAt: nowStr
        };
      }
    }
    return task;
  });

  // Persist the changes
  if (!userId) {
    localStorage.setItem('flare_guest_tasks', JSON.stringify(updatedTasks));
  } else {
    // Update modified tasks in Firestore in a batch if there are changes
    const changedTasks = updatedTasks.filter((t, i) => {
      const orig = allTasks[i];
      return t.riskScore !== orig.riskScore || t.riskReasoning !== orig.riskReasoning;
    });

    if (changedTasks.length > 0) {
      try {
        const firestoreBatch = writeBatch(db);
        changedTasks.forEach(task => {
          const { id, ...docData } = task;
          const ref = doc(db, 'tasks', task.id);
          firestoreBatch.set(ref, docData, { merge: true });
        });
        await firestoreBatch.commit();
      } catch (e) {
        console.error('Failed to commit batch re-evaluation to Firestore:', e);
      }
    }

    localStorage.setItem(`flare_cached_tasks_${userId}`, JSON.stringify(updatedTasks));
  }

  return updatedTasks;
}
