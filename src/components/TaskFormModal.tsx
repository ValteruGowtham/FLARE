import React, { useState, useEffect } from 'react';
import { Task, TaskCategory, TaskStatus } from '../types.js';
import { X, Save, Calendar, Clock, AlertCircle } from 'lucide-react';

interface TaskFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (taskData: {
    title: string;
    description?: string;
    deadline: string;
    estimatedEffort: number;
    category: TaskCategory;
    status: TaskStatus;
  }) => Promise<void>;
  taskToEdit?: Task | null;
}

export default function TaskFormModal({ isOpen, onClose, onSave, taskToEdit }: TaskFormModalProps) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [deadline, setDeadline] = useState('');
  const [estimatedEffort, setEstimatedEffort] = useState<number>(1);
  const [category, setCategory] = useState<TaskCategory>('assignment');
  const [status, setStatus] = useState<TaskStatus>('not started');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (taskToEdit) {
      setTitle(taskToEdit.title);
      setDescription(taskToEdit.description || '');
      // Format deadline date for datetime-local input (YYYY-MM-DDTHH:mm)
      const d = new Date(taskToEdit.deadline);
      const tzOffset = d.getTimezoneOffset() * 60000;
      const localISOTime = (new Date(d.getTime() - tzOffset)).toISOString().slice(0, 16);
      setDeadline(localISOTime);
      setEstimatedEffort(taskToEdit.estimatedEffort);
      setCategory(taskToEdit.category);
      setStatus(taskToEdit.status);
    } else {
      // Set default deadline to tomorrow at 17:00 local time
      const tomorrow = new Date();
      tomorrow.setDate(tomorrow.getDate() + 1);
      tomorrow.setHours(17, 0, 0, 0);
      const tzOffset = tomorrow.getTimezoneOffset() * 60000;
      const defaultDeadline = (new Date(tomorrow.getTime() - tzOffset)).toISOString().slice(0, 16);
      
      setTitle('');
      setDescription('');
      setDeadline(defaultDeadline);
      setEstimatedEffort(2);
      setCategory('assignment');
      setStatus('not started');
    }
    setError(null);
  }, [taskToEdit, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) {
      setError('Task Title is required.');
      return;
    }
    if (!deadline) {
      setError('Task Deadline is required.');
      return;
    }
    if (estimatedEffort <= 0) {
      setError('Estimated effort must be greater than 0.');
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      // Ensure date string is stored as standard ISO
      const isoDeadline = new Date(deadline).toISOString();
      await onSave({
        title: title.trim(),
        description: description.trim() || undefined,
        deadline: isoDeadline,
        estimatedEffort,
        category,
        status,
      });
      onClose();
    } catch (err: any) {
      console.error('Failed to save task:', err);
      setError(err.message || 'An error occurred while saving the task.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center p-4 z-50 animate-fade-in" id="task-modal-overlay">
      <div className="bg-white border border-black/15 rounded-none w-full max-w-lg shadow-md overflow-hidden flex flex-col max-h-[90vh]" id="task-modal-card">
        
        {/* Modal Header */}
        <div className="border-b border-black/10 px-6 py-4 flex items-center justify-between" id="task-modal-header">
          <h2 className="text-sm font-black uppercase tracking-wider text-zinc-900">
            {taskToEdit ? 'Modify Companion Task' : 'Deploy New Rescue Task'}
          </h2>
          <button 
            onClick={onClose}
            className="text-zinc-400 hover:text-black hover:bg-black/5 p-1.5 rounded-none transition cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Form */}
        <form onSubmit={handleSubmit} className="flex-1 overflow-y-auto p-6 space-y-5" id="task-modal-form">
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 text-xs font-bold text-red-700 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div>
            <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
              Task Title
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-sans"
              placeholder="e.g., Finalize Q2 Financial Report"
              required
            />
          </div>

          <div>
            <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
              Description <span className="text-zinc-400 text-[9px] font-normal lowercase italic">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="w-full px-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-sans"
              rows={3}
              placeholder="Provide key notes or breakdown list..."
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
                Deadline Date & Time
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-400">
                  <Calendar className="w-4 h-4" />
                </span>
                <input
                  type="datetime-local"
                  value={deadline}
                  onChange={(e) => setDeadline(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-mono"
                  required
                />
              </div>
            </div>

            <div>
              <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
                Estimated Effort <span className="text-zinc-400 font-normal lowercase italic">(hours)</span>
              </label>
              <div className="relative">
                <span className="absolute inset-y-0 left-0 flex items-center pl-3 text-zinc-400">
                  <Clock className="w-4 h-4" />
                </span>
                <input
                  type="number"
                  value={estimatedEffort}
                  onChange={(e) => setEstimatedEffort(parseFloat(e.target.value) || 0)}
                  min="0.1"
                  step="0.5"
                  className="w-full pl-10 pr-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-mono"
                  required
                />
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
                Category
              </label>
              <select
                value={category}
                onChange={(e) => setCategory(e.target.value as TaskCategory)}
                className="w-full px-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-sans"
              >
                <option value="assignment">📚 Assignment</option>
                <option value="work">💼 Work / Corporate</option>
                <option value="bill">💳 Bill / Expense</option>
                <option value="interview">🤝 Interview</option>
                <option value="personal">🌸 Personal Development</option>
                <option value="other">🏷️ Other Task</option>
              </select>
            </div>

            <div>
              <label className="block text-[9px] font-extrabold text-zinc-800 uppercase tracking-widest mb-1.5">
                Status
              </label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value as TaskStatus)}
                className="w-full px-4 py-2.5 bg-zinc-50/50 border border-black/10 rounded-none text-xs focus:outline-none focus:ring-1 focus:ring-black focus:border-black transition font-sans"
              >
                <option value="not started">💤 Not Started</option>
                <option value="in progress">⚡ In Progress</option>
                <option value="done">✅ Done</option>
              </select>
            </div>
          </div>
        </form>

        {/* Modal Footer */}
        <div className="border-t border-black/10 px-6 py-4 flex items-center justify-end gap-3" id="task-modal-footer">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2.5 text-zinc-600 hover:bg-black/5 rounded-none text-xs font-bold uppercase tracking-wider transition cursor-pointer"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={isSubmitting}
            className="bg-black hover:bg-zinc-800 disabled:bg-zinc-400 text-white font-bold text-xs uppercase tracking-widest px-5 py-2.5 rounded-none transition flex items-center gap-1.5 cursor-pointer"
            id="save-task-button"
          >
            {isSubmitting ? (
              <>
                <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Analyzing...
              </>
            ) : (
              <>
                <Save className="w-4 h-4" />
                {taskToEdit ? 'Apply Changes' : 'Deploy Task'}
              </>
            )}
          </button>
        </div>

      </div>
    </div>
  );
}
