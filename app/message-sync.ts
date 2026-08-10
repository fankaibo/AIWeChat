type SessionStamp = {
  username: string;
  timestamp: number;
  lastMessage: string;
  unread: number;
};

type ConversationMessage = {
  id: string | number;
  timestamp: number;
  sortSeq?: string;
};

type ScrollMetrics = {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
};

export function sessionHasNewMessages(previous: SessionStamp | undefined, next: SessionStamp | undefined) {
  if (!previous || !next || previous.username !== next.username) return false;
  return next.timestamp > previous.timestamp
    || (next.timestamp === previous.timestamp && next.lastMessage !== previous.lastMessage)
    || next.unread > previous.unread;
}

export function mergeConversationMessages<T extends ConversationMessage>(current: T[], incoming: T[]) {
  const merged = new Map<string, T>();
  for (const message of current) {
    if (message.id !== "empty") merged.set(String(message.id), message);
  }
  for (const message of incoming) merged.set(String(message.id), message);
  return [...merged.values()].sort((left, right) => {
    if (left.timestamp !== right.timestamp) return left.timestamp - right.timestamp;
    return String(left.sortSeq || "").localeCompare(String(right.sortSeq || ""), "en", { numeric: true });
  });
}

export function isTimelineNearLatest(metrics: ScrollMetrics | null, threshold = 96) {
  return Boolean(metrics && metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight < threshold);
}
