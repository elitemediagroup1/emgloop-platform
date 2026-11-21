'use client';
import { useState } from 'react';
export function CopyIntakeSummary({ text }: { text: string }) {
  const [message, setMessage] = useState('');
  return (
    <div className="loop-btnrow">
      <button
        className="loop-btn"
        type="button"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(text);
            setMessage('Summary copied.');
          } catch {
            setMessage(
              'Copy is unavailable in this browser. You can select text from the saved revision below.',
            );
          }
        }}
      >
        Copy intake summary
      </button>
      <span role="status">{message}</span>
    </div>
  );
}
