export interface ChatScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
}

export interface ChatViewportMetrics {
  scrollHeight: number;
  clientHeight: number;
}

export interface ChatScrollViewport extends ChatScrollMetrics, ChatViewportMetrics {}

const CHAT_SCROLL_ROOM = 24;
const CHAT_BOTTOM_ROOM = 60;

export interface ChatScrollAnchor {
  height: number;
  top: number;
}

interface ChatAnchorRestoreScheduler {
  schedule: (callback: () => void, delayMs: number) => number;
  cancel: (handle: number) => void;
}

type ChatAnchorScroller = ChatScrollViewport & Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

const CHAT_ANCHOR_SETTLE_DELAY_MS = 120;
const CHAT_ANCHOR_RESTORE_TOLERANCE = 1;
const CHAT_ANCHOR_CANCEL_EVENTS = ['pointerdown', 'touchstart', 'wheel'] as const;

export function captureChatAnchor(scroller: ChatScrollMetrics): ChatScrollAnchor {
  return { height: scroller.scrollHeight, top: scroller.scrollTop };
}

/**
 * Preserves a prepended chat anchor when mobile WebKit rejects a scrollTop write
 * during momentum scrolling. A rejected write is retried after scrolling ends,
 * while fresh user input cancels the pending correction.
 */
export function createChatAnchorRestorer(
  scheduler?: ChatAnchorRestoreScheduler,
) {
  const clock = scheduler ?? {
    schedule: (callback: () => void, delayMs: number) => window.setTimeout(callback, delayMs),
    cancel: (handle: number) => window.clearTimeout(handle),
  };
  let pending = false;
  let cleanup = () => {};

  const cancel = () => {
    cleanup();
    cleanup = () => {};
    pending = false;
  };

  return {
    restore: (scroller: ChatAnchorScroller, anchor: ChatScrollAnchor) => {
      cancel();
      const requested = anchor.top + Math.max(0, scroller.scrollHeight - anchor.height);
      const target = Math.min(
        Math.max(0, requested),
        Math.max(0, scroller.scrollHeight - scroller.clientHeight),
      );
      scroller.scrollTop = target;
      if (Math.abs(scroller.scrollTop - target) <= CHAT_ANCHOR_RESTORE_TOLERANCE) return;

      pending = true;
      let timer: number | null = null;
      const clearTimer = () => {
        if (timer === null) return;
        clock.cancel(timer);
        timer = null;
      };
      const scheduleAfterQuiet = () => {
        clearTimer();
        timer = clock.schedule(() => {
          timer = null;
          retry();
        }, CHAT_ANCHOR_SETTLE_DELAY_MS);
      };
      const onScroll = () => scheduleAfterQuiet();
      const onUserInput = () => cancel();
      const retry = () => {
        scroller.scrollTop = target;
        if (Math.abs(scroller.scrollTop - target) <= CHAT_ANCHOR_RESTORE_TOLERANCE) {
          cleanup();
          pending = false;
        }
      };
      cleanup = () => {
        clearTimer();
        scroller.removeEventListener('scroll', onScroll);
        scroller.removeEventListener('scrollend', retry);
        for (const event of CHAT_ANCHOR_CANCEL_EVENTS) {
          scroller.removeEventListener(event, onUserInput);
        }
      };
      scroller.addEventListener('scroll', onScroll);
      scroller.addEventListener('scrollend', retry);
      for (const event of CHAT_ANCHOR_CANCEL_EVENTS) {
        scroller.addEventListener(event, onUserInput);
      }
      scheduleAfterQuiet();
    },
    cancel,
    isPending: () => pending,
  };
}

export function chatViewportNeedsFill(viewport: ChatViewportMetrics): boolean {
  return (
    viewport.clientHeight > 0 && viewport.scrollHeight - viewport.clientHeight < CHAT_SCROLL_ROOM
  );
}

export function chatViewportAtBottom(viewport: ChatScrollViewport): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight < CHAT_BOTTOM_ROOM;
}

export function syncChatViewportAfterResize(
  viewport: ChatScrollViewport,
  pinnedToLatest: boolean,
): boolean {
  if (viewport.clientHeight <= 0) return false;
  if (pinnedToLatest) viewport.scrollTop = viewport.scrollHeight;
  return chatViewportNeedsFill(viewport);
}
