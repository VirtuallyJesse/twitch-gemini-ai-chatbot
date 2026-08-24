export interface ChatScrollMetrics {
  scrollHeight: number;
  scrollTop: number;
}

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
