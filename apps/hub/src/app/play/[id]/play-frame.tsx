'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { gameToHubMessageSchema, PROTOCOL_VERSION } from '@hub/protocol';

/**
 * The hub side of the embedding contract (ARCHITECTURE §6.3, §7). Origin
 * pinning both directions:
 *  - inbound: messages whose origin isn't the registered frontend origin are
 *    ignored (F-01/F-02), and every message is zod-parsed (F-07);
 *  - outbound: hub:init is posted to the iframe with targetOrigin pinned to the
 *    registered origin, so a navigated/evil frame cannot receive it (F-02).
 *
 * On hub:ready / hub:request-ticket the hub fetches a fresh ticket from its own
 * API (session cookie sent automatically). That endpoint re-checks membership,
 * so a non-member's frame gets nothing (F-06). The ticket travels only in the
 * postMessage payload — never a URL (§9.3, F-04).
 */
export function PlayFrame({
  frontendUrl,
  registeredOrigin,
  instanceId,
}: {
  frontendUrl: string;
  registeredOrigin: string;
  instanceId: string;
}) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const router = useRouter();

  useEffect(() => {
    async function deliverTicket() {
      const res = await fetch(`/api/instances/${instanceId}/ticket`, { cache: 'no-store' });
      if (!res.ok) return; // non-member/expired/inactive → nothing posted (F-06)
      const { ticket, serverUrl, username } = await res.json();
      iframeRef.current?.contentWindow?.postMessage(
        { type: 'hub:init', protocolVersion: PROTOCOL_VERSION, instanceId, username, ticket, serverUrl },
        registeredOrigin, // pinned target (F-02)
      );
    }

    function onMessage(event: MessageEvent) {
      if (event.origin !== registeredOrigin) return; // F-01, F-02
      const parsed = gameToHubMessageSchema.safeParse(event.data); // F-07
      if (!parsed.success) return;
      switch (parsed.data.type) {
        case 'hub:ready':
        case 'hub:request-ticket':
          void deliverTicket();
          break;
        case 'hub:exit':
          router.push('/');
          break;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [instanceId, registeredOrigin, router]);

  const src = `${frontendUrl}${frontendUrl.includes('?') ? '&' : '?'}instance=${encodeURIComponent(instanceId)}`;
  return (
    <iframe
      ref={iframeRef}
      src={src}
      // Cross-origin frame: allow-same-origin grants the frame ITS OWN origin,
      // never the hub's (§7). It cannot read hub cookies/DOM (F-03).
      sandbox="allow-scripts allow-same-origin"
      style={{ width: '100%', height: '80vh', border: '1px solid #ccc' }}
      title="game"
    />
  );
}
