'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Hub } from 'aws-amplify/utils';
import { getCurrentUser } from 'aws-amplify/auth';
import { configureAmplify } from '@/lib/amplify';

/** Hosted UI lands here with ?code=…; Amplify exchanges it, then we go home. */
export default function AuthCallbackPage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    configureAmplify();

    const unsubscribe = Hub.listen('auth', ({ payload }) => {
      if (payload.event === 'signInWithRedirect') router.replace('/');
      if (payload.event === 'signInWithRedirect_failure') setError('Sign-in did not complete.');
    });

    // The exchange may already be done by the time this effect runs.
    getCurrentUser()
      .then(() => router.replace('/'))
      .catch(() => {});

    return unsubscribe;
  }, [router]);

  return (
    <main className="centered">
      {error ? <p className="error">{error}</p> : <p className="muted">Finishing sign-in…</p>}
    </main>
  );
}
