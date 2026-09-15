import { redirect } from 'next/navigation';
import { LOOP_HOME } from '../../../auth/landing';

// This workspace's home is Loop Home, at /app. The layout above still guards
// every page under /app/creator.
export default function CREATORHomeRedirect() {
  redirect(LOOP_HOME);
}
