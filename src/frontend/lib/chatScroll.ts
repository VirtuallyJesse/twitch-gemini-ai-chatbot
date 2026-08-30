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

export interface ChatScrollAnchor {
  height: number;
  top: number;
}

export function captureChatAnchor(scroller: ChatScrollMetrics): ChatScrollAnchor {
  return { height: scroller.scrollHeight, top: scroller.scrollTop };
}

export function restoreChatAnchor(scroller: ChatScrollMetrics, anchor: ChatScrollAnchor): void {
  scroller.scrollTop = anchor.top + Math.max(0, scroller.scrollHeight - anchor.height);
}

export function chatViewportNeedsFill(viewport: ChatViewportMetrics): boolean {
  return (
    viewport.clientHeight > 0 && viewport.scrollHeight - viewport.clientHeight < CHAT_SCROLL_ROOM
  );
}

export function syncChatViewportAfterResize(
  viewport: ChatScrollViewport,
  pinnedToLatest: boolean,
): boolean {
  if (viewport.clientHeight <= 0) return false;
  if (pinnedToLatest) viewport.scrollTop = viewport.scrollHeight;
  return chatViewportNeedsFill(viewport);
}
