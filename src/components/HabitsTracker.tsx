import { useState, useEffect, FormEvent } from 'react';
import { Habit } from '../types.js';
import { createHabit, deleteHabit, toggleHabitDate, updateHabit } from '../habitService.js';
import { Check, Plus, Trash2, TrendingUp, Target } from 'lucide-react';

interface HabitsTrackerProps {
  userId: string | null;
  initialHabits: Habit[];
  onHabitsChange: (habits: Habit[]) => void;
}

export default function HabitsTracker({ userId, initialHabits, onHabitsChange }: HabitsTrackerProps) {
  const [habits, setHabits] = useState<Habit[]>(initialHabits);
  const [isAdding, setIsAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newFrequency, setNewFrequency] = useState<'daily' | 'weekly'>('daily');
  const [newTarget, setNewTarget] = useState(1);

  useEffect(() => {
    setHabits(initialHabits);
  }, [initialHabits]);

  const handleAdd = async (e: FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    
    const habit = await createHabit({
      userId: userId || '',
      title: newTitle.trim(),
      frequency: newFrequency,
      target: newTarget,
      completedDates: []
    });
    
    const updated = [habit, ...habits];
    setHabits(updated);
    onHabitsChange(updated);
    
    setNewTitle('');
    setIsAdding(false);
  };

  const handleDelete = async (id: string) => {
    await deleteHabit(id, userId);
    const updated = habits.filter(h => h.id !== id);
    setHabits(updated);
    onHabitsChange(updated);
  };

  const handleToggle = async (habit: Habit, dateStr: string) => {
    const updatedHabit = await toggleHabitDate(habit, dateStr, userId);
    const updated = habits.map(h => h.id === habit.id ? updatedHabit : h);
    setHabits(updated);
    onHabitsChange(updated);
  };

  // Generate last 7 days
  const today = new Date();
  const last7Days = Array.from({ length: 7 }, (_, i) => {
    const d = new Date(today);
    d.setDate(today.getDate() - (6 - i));
    return d.toISOString().split('T')[0];
  });

  return (
    <div className="w-full max-w-4xl mx-auto flex flex-col gap-6">
      <div className="flex items-center justify-between border-b border-black/10 pb-4">
        <div>
          <h2 className="text-2xl font-black uppercase tracking-tighter flex items-center gap-2">
            <Target className="w-6 h-6" />
            Goals & Habits
          </h2>
          <p className="text-xs font-mono text-zinc-500 mt-1">Track your daily and weekly consistency.</p>
        </div>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="flex items-center gap-1 bg-black text-white px-4 py-2 text-xs font-bold uppercase tracking-widest hover:bg-zinc-800 transition-colors"
        >
          <Plus className="w-4 h-4" /> New Habit
        </button>
      </div>

      {isAdding && (
        <form onSubmit={handleAdd} className="bg-white border border-black/10 p-4 flex flex-col sm:flex-row gap-4 items-end shadow-sm">
          <div className="flex-1 w-full">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Habit Title</label>
            <input 
              type="text"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g., Read 10 pages, Workout, Code"
              className="w-full border border-black/20 p-2 text-sm font-medium outline-none focus:border-black"
              autoFocus
            />
          </div>
          <div className="w-full sm:w-32">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Frequency</label>
            <select
              value={newFrequency}
              onChange={(e) => setNewFrequency(e.target.value as 'daily' | 'weekly')}
              className="w-full border border-black/20 p-2 text-sm font-medium outline-none focus:border-black bg-white"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
          </div>
          <div className="w-full sm:w-24">
            <label className="block text-[10px] font-bold uppercase tracking-widest text-zinc-500 mb-1">Target</label>
            <input 
              type="number"
              min="1"
              value={newTarget}
              onChange={(e) => setNewTarget(parseInt(e.target.value) || 1)}
              className="w-full border border-black/20 p-2 text-sm font-medium outline-none focus:border-black"
            />
          </div>
          <div className="flex gap-2 w-full sm:w-auto">
            <button type="submit" className="flex-1 sm:flex-none bg-black text-white px-4 py-2 text-xs font-bold uppercase tracking-widest hover:bg-zinc-800">
              Save
            </button>
            <button type="button" onClick={() => setIsAdding(false)} className="px-4 py-2 text-xs font-bold uppercase tracking-widest text-zinc-600 hover:text-black border border-transparent">
              Cancel
            </button>
          </div>
        </form>
      )}

      <div className="flex flex-col gap-4">
        {habits.length === 0 ? (
          <div className="text-center py-12 border border-dashed border-black/10 bg-white/40">
            <TrendingUp className="w-8 h-8 mx-auto text-zinc-300 mb-2" />
            <p className="text-sm font-medium text-zinc-500">No habits tracked yet.</p>
            <p className="text-xs text-zinc-400 mt-1">Start by creating a new daily or weekly goal.</p>
          </div>
        ) : (
          <div className="bg-white border border-black/10 overflow-hidden shadow-sm">
            <div className="grid grid-cols-[minmax(150px,1fr)_repeat(7,minmax(40px,1fr))_40px] gap-0 border-b border-black/10 bg-zinc-50">
              <div className="p-3 text-[10px] font-bold uppercase tracking-widest text-zinc-500 flex items-center">Habit</div>
              {last7Days.map((date, i) => {
                const d = new Date(date);
                const dayName = d.toLocaleDateString('en-US', { weekday: 'short' });
                const dayNum = d.getDate();
                const isToday = i === 6;
                return (
                  <div key={date} className={`p-2 border-l border-black/5 flex flex-col items-center justify-center text-center ${isToday ? 'bg-indigo-50/50' : ''}`}>
                    <span className={`text-[9px] uppercase font-bold ${isToday ? 'text-indigo-600' : 'text-zinc-400'}`}>{dayName}</span>
                    <span className={`text-xs font-mono font-medium ${isToday ? 'text-indigo-900' : 'text-zinc-700'}`}>{dayNum}</span>
                  </div>
                );
              })}
              <div className="p-2 border-l border-black/5"></div>
            </div>
            
            <div className="divide-y divide-black/5">
              {habits.map(habit => (
                <div key={habit.id} className="grid grid-cols-[minmax(150px,1fr)_repeat(7,minmax(40px,1fr))_40px] gap-0 hover:bg-zinc-50/50 transition-colors group">
                  <div className="p-3 flex flex-col justify-center">
                    <span className="text-sm font-bold text-zinc-900 truncate">{habit.title}</span>
                    <span className="text-[10px] font-mono text-zinc-500">
                      {habit.frequency === 'daily' ? 'Daily' : `${habit.target}x / Week`}
                    </span>
                  </div>
                  {last7Days.map((date, i) => {
                    const isCompleted = habit.completedDates.includes(date);
                    const isToday = i === 6;
                    return (
                      <div key={date} className={`p-2 border-l border-black/5 flex items-center justify-center ${isToday ? 'bg-indigo-50/20' : ''}`}>
                        <button
                          onClick={() => handleToggle(habit, date)}
                          className={`w-6 h-6 rounded flex items-center justify-center transition-all ${
                            isCompleted 
                              ? 'bg-emerald-500 text-white shadow-sm scale-110' 
                              : 'bg-zinc-100 text-transparent hover:bg-zinc-200 hover:scale-105'
                          }`}
                        >
                          <Check className="w-4 h-4" strokeWidth={3} />
                        </button>
                      </div>
                    );
                  })}
                  <div className="p-2 border-l border-black/5 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={() => handleDelete(habit.id)}
                      className="text-zinc-400 hover:text-red-500 transition-colors"
                      title="Delete habit"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
