export default function SignInPage() {
  if (process.env.NODE_ENV === 'production') {
    return (
      <main>
        <h1>Sign in</h1>
        <p>The dev login is disabled in production. Real sign-in arrives in M6.</p>
      </main>
    );
  }
  return (
    <main>
      <h1>Dev sign in</h1>
      <p>Phase 0 localhost-only login: enter any email to sign in as that participant.</p>
      <form method="post" action="/api/dev/login">
        <input type="email" name="email" required placeholder="you@example.com" />{' '}
        <button type="submit">Sign in</button>
      </form>
    </main>
  );
}
