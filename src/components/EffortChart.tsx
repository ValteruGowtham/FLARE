import { useMemo } from 'react';
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { Task } from '../types.js';
import { PieChart as PieChartIcon } from 'lucide-react';

interface EffortChartProps {
  tasks: Task[];
}

const COLORS = ['#000000', '#4f46e5', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899'];

export default function EffortChart({ tasks }: EffortChartProps) {
  const data = useMemo(() => {
    // Only consider tasks that are not done to show where CURRENT effort goes
    // (Or maybe all tasks? Let's say all tasks, but grouped. Let's do all tasks that are active)
    const activeTasks = tasks.filter(t => t.status !== 'done');
    
    const effortByCategory = activeTasks.reduce((acc, task) => {
      const cat = task.category || 'other';
      acc[cat] = (acc[cat] || 0) + task.estimatedEffort;
      return acc;
    }, {} as Record<string, number>);

    return Object.entries(effortByCategory)
      .map(([name, value]) => ({ name, value }))
      .sort((a, b) => b.value - a.value);
  }, [tasks]);

  const totalEffort = data.reduce((sum, item) => sum + item.value, 0);

  if (data.length === 0) {
    return (
      <div className="w-full max-w-4xl mx-auto flex flex-col items-center justify-center py-20 border border-dashed border-black/10 bg-white/40">
        <PieChartIcon className="w-8 h-8 text-zinc-300 mb-2" />
        <p className="text-sm font-medium text-zinc-500">No active tasks.</p>
        <p className="text-xs text-zinc-400 mt-1">Add tasks to see effort breakdown.</p>
      </div>
    );
  }

  return (
    <div className="w-full max-w-4xl mx-auto bg-white border border-black/10 p-6 shadow-sm">
      <div className="mb-6">
        <h2 className="text-2xl font-black uppercase tracking-tighter flex items-center gap-2">
          <PieChartIcon className="w-6 h-6" />
          Effort Breakdown
        </h2>
        <p className="text-xs font-mono text-zinc-500 mt-1">
          Total active effort: <strong className="text-black">{totalEffort} hours</strong>
        </p>
      </div>
      
      <div className="h-[400px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              cx="50%"
              cy="50%"
              innerRadius={80}
              outerRadius={140}
              paddingAngle={2}
              dataKey="value"
              label={({ name, percent }) => `${name} ${(percent * 100).toFixed(0)}%`}
            >
              {data.map((entry, index) => (
                <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip 
              formatter={(value: number) => [`${value} hours`, 'Effort']}
              contentStyle={{ borderRadius: '0px', border: '1px solid #e4e4e7', fontSize: '12px', fontWeight: 'bold' }}
            />
            <Legend wrapperStyle={{ fontSize: '12px', fontWeight: 'bold', textTransform: 'uppercase' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
