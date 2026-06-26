import { db } from './firebase.js';
import { 
  collection, 
  doc, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  getDocs, 
  query, 
  where,
  orderBy
} from 'firebase/firestore';
import { Habit } from './types.js';

// Get local habits if user is guest
const getLocalHabits = (): Habit[] => {
  const data = localStorage.getItem('flare_habits');
  return data ? JSON.parse(data) : [];
};

const saveLocalHabits = (habits: Habit[]) => {
  localStorage.setItem('flare_habits', JSON.stringify(habits));
};

export const fetchHabits = async (userId: string | null): Promise<Habit[]> => {
  if (!userId) {
    return getLocalHabits();
  }

  const q = query(
    collection(db, 'habits'),
    where('userId', '==', userId),
    orderBy('createdAt', 'desc')
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  })) as Habit[];
};

export const createHabit = async (habit: Omit<Habit, 'id' | 'createdAt' | 'updatedAt'>): Promise<Habit> => {
  const now = new Date().toISOString();
  
  if (!habit.userId) {
    const newHabit: Habit = {
      ...habit,
      id: crypto.randomUUID(),
      createdAt: now,
      updatedAt: now,
    };
    const habits = getLocalHabits();
    saveLocalHabits([newHabit, ...habits]);
    return newHabit;
  }

  const docRef = await addDoc(collection(db, 'habits'), {
    ...habit,
    createdAt: now,
    updatedAt: now,
  });

  return {
    ...habit,
    id: docRef.id,
    createdAt: now,
    updatedAt: now,
  };
};

export const updateHabit = async (habitId: string, updates: Partial<Habit>, userId: string | null): Promise<void> => {
  const now = new Date().toISOString();
  
  if (!userId) {
    const habits = getLocalHabits();
    const updated = habits.map(h => h.id === habitId ? { ...h, ...updates, updatedAt: now } : h);
    saveLocalHabits(updated);
    return;
  }

  const docRef = doc(db, 'habits', habitId);
  await updateDoc(docRef, {
    ...updates,
    updatedAt: now,
  });
};

export const deleteHabit = async (habitId: string, userId: string | null): Promise<void> => {
  if (!userId) {
    const habits = getLocalHabits();
    saveLocalHabits(habits.filter(h => h.id !== habitId));
    return;
  }

  const docRef = doc(db, 'habits', habitId);
  await deleteDoc(docRef);
};

export const toggleHabitDate = async (habit: Habit, dateStr: string, userId: string | null): Promise<Habit> => {
  const completedDates = [...habit.completedDates];
  const index = completedDates.indexOf(dateStr);
  
  if (index >= 0) {
    completedDates.splice(index, 1);
  } else {
    completedDates.push(dateStr);
  }
  
  await updateHabit(habit.id, { completedDates }, userId);
  return { ...habit, completedDates };
};
