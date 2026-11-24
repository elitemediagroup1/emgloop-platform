'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { loadMeetingNotes } from './actions';

export function MeetingNotesLoader({ id }: { id: string }) {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState('Preparing meeting notes…');
  const [retry, setRetry] = useState(false);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = 0;
    const check = async () => {
      try {
        const state = await loadMeetingNotes(id);
        if (!active) return;
        router.refresh();
        if (state === 'ready') {
          setNotice('');
        } else if (state === 'processing' && ++polls < 12) {
          setNotice('Preparing meeting notes…');
          timer = setTimeout(check, 12_000);
        } else {
          setNotice(state === 'too-long' ? 'This transcript exceeds the automatic summary limit.' :
            state === 'processing' ? 'Meeting notes are still processing.' :
              state === 'unavailable' ? 'Meeting notes are unavailable right now.' : 'Meeting notes could not be prepared.');
          setRetry(state !== 'too-long');
        }
      } catch {
        if (active) {
          setNotice('Meeting notes could not be prepared.');
          setRetry(true);
        }
      }
    };
    void check();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [attempt, id, router]);

  return (
    <>
      <p role="status">{notice}</p>
      {retry && <button className="loop-btn" type="button" onClick={() => {
        setRetry(false);
        setNotice('Preparing meeting notes…');
        setAttempt(value => value + 1);
      }}>Check again</button>}
    </>
  );
}
