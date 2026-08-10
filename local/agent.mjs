const stopWords = new Set(["我们", "这个", "一个", "已经", "可以", "需要", "今天", "明天", "目前", "进行", "问题", "消息", "一下", "然后", "还是", "没有", "就是", "以及", "the", "and", "for", "that", "with"]);

function textOf(message) {
  return `${message.sender || ""} ${message.content || ""} ${message.meta?.description || ""}`.trim();
}

function pick(messages, pattern, limit = 6) {
  return messages.filter((message) => pattern.test(textOf(message))).slice(-limit).map((message) => ({ id: message.id, sender: message.sender, content: message.content, timestamp: message.timestamp }));
}

function keywords(messages) {
  const counts = new Map();
  for (const message of messages) {
    const tokens = textOf(message).toLowerCase().match(/[a-z][a-z0-9_-]{2,}|[\u4e00-\u9fff]{2,6}/g) || [];
    for (const token of tokens) {
      if (stopWords.has(token) || /^\d+$/.test(token)) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name, count]) => ({ name, count }));
}

export function summarize(messages, session) {
  const speakers = new Map();
  for (const message of messages) {
    if (!message.sender || message.sender === "系统" || message.type === "system" || String(message.senderId || "").endsWith("@chatroom")) continue;
    const key = message.senderId || message.sender;
    const current = speakers.get(key);
    speakers.set(key, current
      ? { ...current, count: current.count + 1, avatar: current.avatar || message.avatar }
      : { senderId: message.senderId || "", name: message.sender, count: 1, avatar: message.avatar });
  }
  const decisions = pick(messages, /结论|决定|确认|同意|定为|采用|先把/);
  const todos = pick(messages, /负责|待办|todo|截止|需要|请|跟进|回归/i);
  const risks = pick(messages, /风险|阻塞|超时|失败|延期|问题|异常|丢失/);
  const links = messages.filter((message) => message.type === "link" || /https?:\/\//.test(textOf(message))).length;
  const files = messages.filter((message) => ["file", "image", "video"].includes(message.type)).length;
  const topSpeakers = [...speakers.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh-CN"));

  return {
    title: `${session?.name || "当前会话"}阶段总结`,
    overview: `共分析 ${messages.length} 条消息，${speakers.size} 位成员参与。识别到 ${decisions.length} 条结论、${todos.length} 条待办和 ${risks.length} 条风险线索。`,
    decisions,
    todos,
    risks,
    keywords: keywords(messages),
    metrics: { messages: messages.length, participants: speakers.size, links, files },
    topSpeakers,
    generatedBy: "local-rules",
  };
}

export function answerQuestion(question, messages, session) {
  const normalized = question.trim().toLowerCase();
  const terms = (normalized.match(/[a-z][a-z0-9_-]{1,}|[\u4e00-\u9fff]{2,}/g) || []).filter((term) => !stopWords.has(term));
  const ranked = messages.map((message) => {
    const haystack = textOf(message).toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { message, score };
  }).filter((entry) => entry.score > 0).sort((a, b) => b.score - a.score || b.message.timestamp - a.message.timestamp).slice(0, 6);

  if (!ranked.length) {
    return {
      answer: `在“${session?.name || "当前会话"}”现有记录中，没有找到与“${question.trim()}”直接相关的内容。你可以换一个更具体的关键词，或扩大时间范围。`,
      citations: [],
      generatedBy: "local-search",
    };
  }

  const citations = ranked.map(({ message }) => ({ id: message.id, sender: message.sender, content: message.content, timestamp: message.timestamp }));
  const digest = citations.slice(0, 3).map((item) => `${item.sender}提到“${item.content}”`).join("；");
  return {
    answer: `根据当前会话的相关记录：${digest}。这是基于本地关键词检索生成的摘要，建议点击引用回到原文确认。`,
    citations,
    generatedBy: "local-search",
  };
}
