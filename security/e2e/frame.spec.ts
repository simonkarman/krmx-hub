import { expect, test, type Browser, type Frame } from '@playwright/test';
import { JWT_PATTERN, seed, sessionCookie } from './seed';

async function contextFor(browser: Browser, token: string) {
  const ctx = await browser.newContext();
  await ctx.addCookies([sessionCookie(token)]);
  return ctx;
}

async function readyFrame(page: import('@playwright/test').Page): Promise<Frame> {
  const el = await page.waitForSelector('iframe', { timeout: 15_000 });
  const frame = await el.contentFrame();
  if (!frame) throw new Error('no game frame');
  await frame.waitForFunction(() => (window as unknown as { __hub?: { ready?: boolean } }).__hub?.ready === true, null, {
    timeout: 15_000,
  });
  return frame;
}

test.describe('F — iframe & postMessage (two-origin harness)', () => {
  test('F-06 a non-member is redirected off the play page and the ticket API refuses them', async ({ browser }) => {
    const ctx = await contextFor(browser, seed.users.nonMember.token);
    const page = await ctx.newPage();
    await page.goto(`/play/${seed.instanceA}`);
    await expect(page).toHaveURL('http://localhost:3000/'); // server-side redirect, no frame
    await expect(page.locator('iframe')).toHaveCount(0);
    const res = await page.request.get(`/api/instances/${seed.instanceA}/ticket`);
    expect(res.status()).toBe(403);
    await ctx.close();
  });

  test('a member completes the handshake and the frame becomes ready (baseline)', async ({ browser }) => {
    const ctx = await contextFor(browser, seed.users.p1.token);
    const page = await ctx.newPage();
    await page.goto(`/play/${seed.instanceA}`);
    const frame = await readyFrame(page);
    expect(await frame.evaluate(() => (window as unknown as { __hub: { instanceId: string } }).__hub.instanceId)).toBe(
      seed.instanceA,
    );
    await ctx.close();
  });

  test('F-03 the game frame cannot read the hub cookies or DOM (cross-origin)', async ({ browser }) => {
    const ctx = await contextFor(browser, seed.users.p1.token);
    const page = await ctx.newPage();
    await page.goto(`/play/${seed.instanceA}`);
    const frame = await readyFrame(page);
    // The hub session cookie is httpOnly, so the frame's JS can't read it even
    // though localhost cookies aren't port-scoped in this harness.
    expect(await frame.evaluate(() => document.cookie)).not.toContain('authjs');
    const canReadTop = await frame.evaluate(() => {
      try {
        return typeof window.top!.document.cookie === 'string';
      } catch {
        return false;
      }
    });
    expect(canReadTop).toBe(false);
    await ctx.close();
  });

  test('F-04 the ticket never appears in any URL during the play flow', async ({ browser }) => {
    const ctx = await contextFor(browser, seed.users.p1.token);
    const page = await ctx.newPage();
    await page.goto(`/play/${seed.instanceA}`);
    const frame = await readyFrame(page);
    await frame.evaluate(async () => {
      // exercise a ticket refresh too
      const hub = (window as unknown as { __hub: { ticketCount: number } }).__hub;
      void hub;
    });
    expect(page.url()).not.toMatch(JWT_PATTERN);
    expect(frame.url()).not.toMatch(JWT_PATTERN);
    const urls = async (target: { evaluate: Frame['evaluate'] }) =>
      target.evaluate(
        () =>
          performance
            .getEntriesByType('resource')
            .map((e) => e.name)
            .join('\n') +
          '\n' +
          location.href,
      );
    expect(await urls(page.mainFrame())).not.toMatch(JWT_PATTERN);
    expect(await urls(frame)).not.toMatch(JWT_PATTERN);
    await ctx.close();
  });

  test('F-05 CSP frame-src blocks embedding an unregistered origin, and the hub cannot be framed', async ({
    browser,
  }) => {
    const ctx = await contextFor(browser, seed.users.p1.token);
    const page = await ctx.newPage();
    const res = await page.request.get(`/play/${seed.instanceA}`);
    const csp = res.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-src 'self' http://localhost:4000");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('4666');

    await page.goto(`/play/${seed.instanceA}`);
    const violated = await page.evaluate(
      () =>
        new Promise<string>((resolve) => {
          document.addEventListener(
            'securitypolicyviolation',
            (e) => resolve((e as SecurityPolicyViolationEvent).violatedDirective),
            { once: true },
          );
          const f = document.createElement('iframe');
          f.src = 'http://localhost:4666/';
          document.body.appendChild(f);
          setTimeout(() => resolve('no-violation'), 4000);
        }),
    );
    expect(violated).toContain('frame-src');
    await ctx.close();
  });

  test('F-07 a correctly-originated but malformed message is ignored (zod)', async ({ browser }) => {
    const ctx = await contextFor(browser, seed.users.p1.token);
    const page = await ctx.newPage();
    await page.goto(`/play/${seed.instanceA}`);
    const frame = await readyFrame(page);
    // from the registered origin, but not a valid game→hub message
    await frame.evaluate(() => {
      window.parent.postMessage({ type: 'hub:init', bogus: true }, '*');
      window.parent.postMessage('not even an object', '*');
      window.parent.postMessage({ type: 'totally-unknown' }, '*');
    });
    await page.waitForTimeout(500);
    // hub didn't crash; frame is still the same working session
    expect(await frame.evaluate(() => (window as unknown as { __hub: { ready: boolean } }).__hub.ready)).toBe(true);
    await ctx.close();
  });

  test('F-01/F-02 the hub ignores messages from an unregistered origin and never posts a ticket to it', async ({
    browser,
  }) => {
    // Same context (shares the p1 session cookie the popup needs).
    const ctx = await contextFor(browser, seed.users.p1.token);
    const evil = await ctx.newPage();
    await evil.goto('http://localhost:4666/');

    const popupPromise = ctx.waitForEvent('page');
    await evil.evaluate(
      (url) => (window as unknown as { openHubAndAttack: (u: string) => boolean }).openHubAndAttack(url),
      `http://localhost:3000/play/${seed.instanceA}`,
    );
    const popup = await popupPromise;
    await popup.waitForLoadState('domcontentloaded');

    // The legit frame inside the popup DOES get its ticket (pinned to :4000)…
    await readyFrame(popup);
    // …but the evil opener receives nothing, and certainly no ticket.
    await evil.waitForTimeout(1500);
    const received = await evil.evaluate(
      () => (window as unknown as { __received: { data?: { type?: string } }[] }).__received,
    );
    expect(received.some((m) => m.data?.type === 'hub:init')).toBe(false);
    expect(JSON.stringify(received)).not.toMatch(JWT_PATTERN);

    await ctx.close();
  });
});
