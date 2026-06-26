import { useState, useRef } from 'react';
import { Mic, Square, Loader2 } from 'lucide-react';

interface VoiceAssistantProps {
  onTaskCreate?: (taskPayload: any) => void;
}

export default function VoiceAssistant({ onTaskCreate }: VoiceAssistantProps) {
  const [isRecording, setIsRecording] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [responseMsg, setResponseMsg] = useState('');
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const startRecording = async () => {
    try {
      setResponseMsg('');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      audioChunksRef.current = [];

      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioChunksRef.current.push(event.data);
        }
      };

      mediaRecorder.onstop = async () => {
        setIsProcessing(true);
        const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType });
        stream.getTracks().forEach(track => track.stop());
        
        // Convert to base64
        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          const base64data = reader.result?.toString().split(',')[1];
          if (base64data) {
            await processVoiceCommand(base64data, audioBlob.type);
          }
        };
      };

      mediaRecorder.start();
      setIsRecording(true);
    } catch (err) {
      console.error('Failed to start recording:', err);
      setResponseMsg('Microphone access denied or unavailable.');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  const processVoiceCommand = async (base64Data: string, mimeType: string) => {
    try {
      const res = await fetch('/api/voice', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          audioBase64: base64Data,
          mimeType,
          currentTime: new Date().toISOString()
        })
      });
      const data = await res.json();
      
      if (data.error) {
        setResponseMsg('Error: ' + data.error);
        return;
      }

      setResponseMsg(data.message || 'Processed successfully.');
      
      if (data.action === 'CREATE_TASK' && data.taskPayload && onTaskCreate) {
        onTaskCreate(data.taskPayload);
      }
    } catch (err) {
      console.error('Error processing voice:', err);
      setResponseMsg('Failed to process voice command.');
    } finally {
      setIsProcessing(false);
      setTimeout(() => setResponseMsg(''), 5000);
    }
  };

  return (
    <div className="fixed bottom-6 right-6 flex flex-col items-end gap-2 z-50">
      {responseMsg && (
        <div className="bg-white border border-black/10 shadow-lg p-3 rounded-lg max-w-xs text-xs text-zinc-800 mb-2 font-medium">
          {responseMsg}
        </div>
      )}
      
      <button
        onClick={isRecording ? stopRecording : startRecording}
        disabled={isProcessing}
        className={`w-14 h-14 rounded-full flex items-center justify-center shadow-lg transition-all ${
          isProcessing 
            ? 'bg-zinc-200 text-zinc-500 cursor-not-allowed' 
            : isRecording 
              ? 'bg-red-500 text-white animate-pulse' 
              : 'bg-indigo-600 text-white hover:bg-indigo-700 hover:scale-105'
        }`}
        title="Voice Assistant"
      >
        {isProcessing ? (
          <Loader2 className="w-6 h-6 animate-spin" />
        ) : isRecording ? (
          <Square className="w-5 h-5 fill-current" />
        ) : (
          <Mic className="w-6 h-6" />
        )}
      </button>
    </div>
  );
}
