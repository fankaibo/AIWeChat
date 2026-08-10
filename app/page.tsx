"use client";

/* eslint-disable @next/next/no-img-element -- WeChat avatar and media URLs are dynamic local/CDN sources. */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isTimelineNearLatest, mergeConversationMessages, sessionHasNewMessages } from "./message-sync";

type Tone = "apricot" | "blue" | "green" | "purple" | "orange" | "rose" | "teal" | "gray" | "indigo" | "red" | "dark";
type Avatar = { label: string; tone: Tone; url?: string };
type SessionCategory = "chat" | "official";
type OfficialType = "subscription" | "service" | "account";
type Session = { username: string; name: string; avatar: Avatar; lastMessage: string; timestamp: number; unread: number; pinned?: boolean; isGroup?: boolean; memberCount?: number; category?: SessionCategory; officialType?: OfficialType; folded?: boolean };
type Contact = { username: string; name: string; nickName?: string; remark?: string; avatar: Avatar; kind: "contact" | "group"; memberCount?: number };
type ContactDetail = Contact & { alias?: string; description?: string; avatarUrl?: string; verifyFlag?: number; localType?: number };
type GroupMember = { username: string; name: string; remark?: string; avatar?: Avatar; role?: string };
type Message = { id: string | number; serverId?: string; sortSeq?: string; sender: string; senderId: string; avatar?: Avatar; timestamp: number; type: string; content: string; isMine?: boolean; meta?: Record<string, string | number | boolean> };
type ImagePreview = { fullUrl: string; thumbnailUrl: string; alt: string };
type Citation = { id: string | number; sender: string; content: string; timestamp: number };
type LlmModel = { id: string; name: string; provider: string; model: string; api: string; reasoning: string; contextWindow: number | null; credentialReady: boolean; verified: boolean; availability?: "ready" | "unavailable" | "unverified"; lastError?: string; lastCheckedAt?: number };
type LlmHistoryStatus = { enabled: boolean; localOnly: boolean; conversationCount: number; maxConversations: number; maxTurns: number; location: string; error?: string };
type LlmStatus = { configured: boolean; provider: string; model: string; modelId: string; reasoning: string; contextLimit: number; localProvider: boolean; api: string; store: boolean; uploadPolicy: string; models: LlmModel[]; defaultModelId: string; credentialSource: string; credentialFileSecure: boolean | null; credentialCounts: Record<string, number>; warnings: string[]; history: LlmHistoryStatus };
type LlmTurn = { id: string; role: "user" | "assistant"; content: string; citations?: (Citation & { label?: string })[]; model?: string; contextMessages?: number; usage?: { inputTokens: number; outputTokens: number; totalTokens: number }; error?: boolean; createdAt?: number };
type LlmHistorySummary = { id: string; username: string; sessionName: string; title: string; preview: string; createdAt: number; updatedAt: number; turnCount: number; modelId: string; model: string; provider: string };
type LlmHistoryRecord = LlmHistorySummary & { turns: LlmTurn[] };
type SyncStatus = { mode: string; state: string; revision: string; contactRevision?: string; readonly: boolean; lastSyncAt: number; lagMs: number | null; watchedDatabases?: number; pollMs?: number; retryMs?: number; syncStrategy?: "full" | "incremental"; reusedDatabases?: number; decryptedDatabases?: number; checkedDatabases?: number; snapshotMs?: number; lastError?: string };
type ServiceStatus = { source: string; ok: boolean; readonly: boolean; sync?: SyncStatus };
type HeatmapDay = { date: string; count: number };
type HeatmapData = { month: string; scope: "all" | "current"; scopeName: string; days: HeatmapDay[]; total: number; max: number; activeDays: number; peakDay: HeatmapDay | null };
type Speaker = { senderId?: string; name: string; count: number; avatar?: Avatar };
type AnalysisPeriod = "天" | "周" | "月" | "季" | "年";
type SignalFilter = "all" | "decision" | "todo" | "risk";
type SignalItem = Citation & { kind: "结论" | "待办" | "风险"; tone: Exclude<SignalFilter, "all"> };
type Summary = {
  title: string;
  overview: string;
  decisions: Citation[];
  todos: Citation[];
  risks: Citation[];
  keywords: { name: string; count: number }[];
  metrics: { messages: number; participants: number; links: number; files: number };
  topSpeakers: Speaker[];
  generatedBy?: string;
};

const API = "http://127.0.0.1:8787/api";
const defaultLlmStatus: LlmStatus = { configured: false, provider: "本地模型工作区", model: "", modelId: "", reasoning: "medium", contextLimit: 120, localProvider: false, api: "", store: false, uploadPolicy: "只有主动提问时才会发送当前会话的相关消息。", models: [], defaultModelId: "", credentialSource: "未配置", credentialFileSecure: null, credentialCounts: {}, warnings: [], history: { enabled: true, localOnly: true, conversationCount: 0, maxConversations: 200, maxTurns: 80, location: ".local/llm-history.json" } };
const defaultSyncStatus: SyncStatus = { mode: "demo", state: "disabled", revision: "", readonly: true, lastSyncAt: 0, lagMs: null };
const baseTime = new Date("2026-08-05T14:18:00+08:00").getTime();
const avatar = (label: string, tone: Tone): Avatar => ({ label, tone });

const fallbackSessions: Session[] = [
  { username: "ai-lab@chatroom", name: "AI 技术交流群", avatar: avatar("AI", "blue"), lastMessage: "本周 Agent 评测结论已经整理好了", timestamp: baseTime - 180000, unread: 8, pinned: true, isGroup: true, memberCount: 111 },
  { username: "product-room@chatroom", name: "产品与设计协作", avatar: avatar("产", "purple"), lastMessage: "交互稿今晚可以合并", timestamp: baseTime - 1080000, unread: 3, pinned: true, isGroup: true, memberCount: 38 },
  { username: "wxid_lin", name: "林然", avatar: avatar("林", "green"), lastMessage: "明天下午三点可以", timestamp: baseTime - 3120000, unread: 1, isGroup: false },
  { username: "gh_agentos_daily", name: "AgentOS 日报", avatar: avatar("报", "orange"), lastMessage: "今天的 Agent 行业动态已更新", timestamp: baseTime - 4200000, unread: 2, isGroup: false, category: "official", officialType: "account" },
  { username: "infra@chatroom", name: "基础设施讨论组", avatar: avatar("基", "orange"), lastMessage: "延迟已经恢复到正常范围", timestamp: baseTime - 7200000, unread: 0, isGroup: true, memberCount: 24 },
  { username: "reading@chatroom", name: "论文与研究", avatar: avatar("研", "rose"), lastMessage: "分享了一篇关于长上下文的新论文", timestamp: baseTime - 18000000, unread: 12, isGroup: true, memberCount: 76 },
  { username: "wxid_mori", name: "Mori", avatar: avatar("M", "teal"), lastMessage: "文件已发送", timestamp: baseTime - 86400000, unread: 0, isGroup: false },
  { username: "family@chatroom", name: "家人", avatar: avatar("家", "red"), lastMessage: "周末见", timestamp: baseTime - 172800000, unread: 0, isGroup: true, memberCount: 6 },
  { username: "filehelper", name: "文件传输助手", avatar: avatar("文", "gray"), lastMessage: "research-notes.pdf", timestamp: baseTime - 259200000, unread: 0, isGroup: false },
  { username: "makers@chatroom", name: "独立开发者", avatar: avatar("造", "indigo"), lastMessage: "第一版已经上线", timestamp: baseTime - 345600000, unread: 22, isGroup: true, memberCount: 208 },
];

const fallbackContacts: Contact[] = [
  { username: "wxid_lin", name: "林然", remark: "产品 林然", avatar: avatar("林", "green"), kind: "contact" },
  { username: "wxid_mori", name: "Mori", avatar: avatar("M", "teal"), kind: "contact" },
  { username: "wxid_chen", name: "陈川", remark: "基础设施 陈川", avatar: avatar("陈", "blue"), kind: "contact" },
  { username: "wxid_ye", name: "叶子", remark: "设计 叶子", avatar: avatar("叶", "purple"), kind: "contact" },
  ...fallbackSessions.filter((item) => item.isGroup).map((item) => ({ username: item.username, name: item.name, avatar: item.avatar, kind: "group" as const, memberCount: item.memberCount })),
];

const fallbackMessages: Message[] = [
  { id: 1, sender: "周屿", senderId: "wxid_zhou", avatar: avatar("周", "orange"), timestamp: baseTime - 25200000, type: "text", content: "今天把 Agent 的评测结果过一遍，重点看工具调用稳定性和长任务恢复。" },
  { id: 2, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: baseTime - 24480000, type: "link", content: "Agent Harness 设计笔记", meta: { url: "https://example.com/agent-harness", description: "从任务规划、工具调用到可恢复执行的一套工程化思路" } },
  { id: 3, sender: "陈川", senderId: "wxid_chen", avatar: avatar("陈", "blue"), timestamp: baseTime - 22680000, type: "text", content: "线上观察到两个问题：并行工具超过 6 个后偶发超时；长任务在网络切换时会丢失最后一个检查点。" },
  { id: 4, sender: "我", senderId: "me", avatar: avatar("我", "dark"), timestamp: baseTime - 21960000, type: "text", content: "先把并发上限收紧到 4，检查点改为每个工具返回后落盘。今天出一个小版本验证。", isMine: true },
  { id: 5, sender: "叶子", senderId: "wxid_ye", avatar: avatar("叶", "purple"), timestamp: baseTime - 19800000, type: "image", content: "评测看板截图", meta: { width: 920, height: 520, status: "demo" } },
  { id: 6, sender: "周屿", senderId: "wxid_zhou", avatar: avatar("周", "orange"), timestamp: baseTime - 17640000, type: "file", content: "agent-eval-2026-08.xlsx", meta: { size: "1.8 MB", ext: "XLSX" } },
  { id: 7, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: baseTime - 12960000, type: "quote", content: "同意。先解决恢复一致性，复杂的自动重试放到下一轮。", meta: { quoteSender: "我", quote: "今天出一个小版本验证。" } },
  { id: 8, sender: "陈川", senderId: "wxid_chen", avatar: avatar("陈", "blue"), timestamp: baseTime - 7920000, type: "text", content: "补充风险：旧任务记录里没有 schema_version，迁移时需要做兼容读取。负责人我，截止周四。" },
  { id: 9, sender: "周屿", senderId: "wxid_zhou", avatar: avatar("周", "orange"), timestamp: baseTime - 4380000, type: "voice", content: "语音消息", meta: { duration: "0:18" } },
  { id: 10, sender: "我", senderId: "me", avatar: avatar("我", "dark"), timestamp: baseTime - 2220000, type: "text", content: "结论：并发上限先设为 4；陈川负责兼容迁移；我负责恢复检查点，周四一起回归。", isMine: true },
  { id: 11, sender: "系统", senderId: "system", timestamp: baseTime - 1320000, type: "system", content: "“周屿”修改了群公告" },
  { id: 12, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: baseTime - 180000, type: "text", content: "本周 Agent 评测结论已经整理好了，晚点补充到文档。" },
];

const fallbackSummary: Summary = {
  title: "AI 技术交流群阶段总结",
  overview: "围绕 Agent 稳定性完成一次阶段收敛：并发上限暂定为 4，恢复检查点改为工具调用后落盘，并安排旧任务兼容迁移。",
  decisions: [{ id: 10, sender: "我", content: "并发上限先设为 4；周四一起回归。", timestamp: baseTime - 2220000 }],
  todos: [{ id: 8, sender: "陈川", content: "负责旧任务 schema_version 兼容迁移，截止周四。", timestamp: baseTime - 7920000 }],
  risks: [{ id: 3, sender: "陈川", content: "并行工具偶发超时，网络切换会丢失检查点。", timestamp: baseTime - 22680000 }],
  keywords: [{ name: "Agent", count: 8 }, { name: "检查点", count: 5 }, { name: "并发", count: 4 }, { name: "迁移", count: 3 }],
  metrics: { messages: 12, participants: 4, links: 1, files: 2 },
  topSpeakers: [{ name: "林然", count: 3 }, { name: "陈川", count: 2 }, { name: "周屿", count: 3 }, { name: "我", count: 2 }],
  generatedBy: "local-rules",
};

const navItems = [
  { id: "chats", icon: "◌", label: "聊天" },
  { id: "official", icon: "▤", label: "公众号" },
  { id: "contacts", icon: "♙", label: "联系人" },
  { id: "search", icon: "⌕", label: "搜索" },
  { id: "insights", icon: "⌁", label: "洞察" },
];

function normalizeLlmStatus(value?: Partial<LlmStatus>): LlmStatus {
  return { ...defaultLlmStatus, ...value, history: { ...defaultLlmStatus.history, ...(value?.history || {}) } };
}

function stableContactPayload(value: { source?: string; revision?: string; contacts?: Contact[] }) {
  return !(value?.source === "local-live" && Object.prototype.hasOwnProperty.call(value, "revision") && !value.revision);
}

function categoryOf(session: Session): SessionCategory {
  if (session.category) return session.category;
  if (["brandsessionholder", "brandservicesessionholder"].includes(session.username) || session.username.startsWith("gh_")) return "official";
  return "chat";
}

function visibleSession(session: Session) {
  return session.username !== "@placeholder_foldgroup" && !session.folded;
}

function officialTypeLabel(session: Session) {
  if (session.officialType === "subscription") return "订阅号";
  if (session.officialType === "service") return "服务号";
  return "公众号";
}

function shanghaiParts(timestamp: number) {
  const value = new Date(timestamp + 8 * 60 * 60 * 1000);
  const pad = (part: number) => String(part).padStart(2, "0");
  return { year: value.getUTCFullYear(), month: pad(value.getUTCMonth() + 1), day: pad(value.getUTCDate()), hour: pad(value.getUTCHours()), minute: pad(value.getUTCMinutes()) };
}

function formatClock(timestamp: number) {
  const value = shanghaiParts(timestamp);
  return `${value.month}/${value.day} ${value.hour}:${value.minute}`;
}

function formatFullTime(timestamp: number) {
  const value = shanghaiParts(timestamp);
  return `${value.month}/${value.day} ${value.hour}:${value.minute}`;
}

function formatDateLabel(timestamp: number) {
  const value = shanghaiParts(timestamp);
  return `${value.year}/${value.month}/${value.day}`;
}

function currentShanghaiMonth(timestamp = Date.now()) {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 7);
}

function shiftMonth(value: string, offset: number) {
  const [year, month] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7);
}

function monthLabel(value: string) {
  const [year, month] = value.split("-").map(Number);
  return `${year} 年 ${month} 月`;
}

function heatDateLabel(value: string) {
  const [, month, day] = value.split("-").map(Number);
  const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][new Date(`${value}T00:00:00+08:00`).getDay()];
  return `${month} 月 ${day} 日 · ${weekday}`;
}

function analysisPeriodKey(period: AnalysisPeriod) {
  return ({ 天: "day", 周: "week", 月: "month", 季: "quarter", 年: "year" } as const)[period];
}

function analysisPeriodLabel(period: AnalysisPeriod) {
  return ({ 天: "今日", 周: "本周", 月: "本月", 季: "本季度", 年: "本年" } as const)[period];
}

function statsPath(username: string, period: AnalysisPeriod) {
  return `/stats?chat=${encodeURIComponent(username)}&period=${analysisPeriodKey(period)}`;
}

function formatSyncAge(timestamp: number) {
  if (!timestamp) return "等待首次同步";
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 5) return "刚刚同步";
  if (seconds < 60) return `${seconds} 秒前同步`;
  return `${Math.floor(seconds / 60)} 分钟前同步`;
}

function AvatarView({ value, size = "medium" }: { value?: Avatar; size?: "small" | "medium" | "large" }) {
  const current = value || avatar("?", "gray");
  return <span className={`avatar avatar-${size} tone-${current.tone}`} aria-hidden="true"><span>{current.label}</span>{current.url ? <img src={current.url} alt="" loading="lazy" referrerPolicy="no-referrer" onError={(event) => { event.currentTarget.hidden = true; }} /> : null}</span>;
}

function SpeakerRow({ speaker, index, maximum }: { speaker: Speaker; index: number; maximum: number }) {
  const fallbackTone = (["orange", "green", "blue", "purple", "teal", "rose"] as Tone[])[index % 6];
  return (
    <div className="speaker-row">
      <span className="speaker-rank">{index + 1}</span>
      <AvatarView value={speaker.avatar || avatar(speaker.name.slice(0, 1), fallbackTone)} size="small" />
      <strong title={speaker.name}>{speaker.name}</strong>
      <em>{speaker.count.toLocaleString("zh-CN")}</em>
      <div className="speaker-bar" aria-label={`${speaker.count} 条消息`}><i style={{ width: `${(speaker.count / maximum) * 100}%` }} /></div>
    </div>
  );
}

function renderLlmInline(text: string, citations: (Citation & { label?: string })[] = [], onCitation?: (id: string | number) => void): ReactNode[] {
  const tokens = /(\[M\d+\]|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*\n]+\*\*|`[^`\n]+`|https?:\/\/[^\s<>()\[\]{}，。；：！？]+)/g;
  const result: ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  for (const match of text.matchAll(tokens)) {
    const start = match.index || 0;
    if (start > cursor) result.push(text.slice(cursor, start));
    const token = match[0];
    const citation = /^\[(M\d+)\]$/.exec(token)?.[1];
    const markdownLink = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(token);
    if (citation) {
      const source = citations.find((item) => item.label === citation);
      result.push(source && onCitation
        ? <button type="button" className="llm-inline-citation" onClick={() => onCitation(source.id)} title={`查看 ${source.sender} 的原文`} key={`inline-${key}`}>{citation}</button>
        : <span className="llm-inline-citation unavailable" key={`inline-${key}`}>{citation}</span>);
    } else if (markdownLink) {
      result.push(<a href={markdownLink[2]} target="_blank" rel="noreferrer" key={`inline-${key}`}>{markdownLink[1]}</a>);
    } else if (token.startsWith("**")) {
      result.push(<strong key={`inline-${key}`}>{renderLlmInline(token.slice(2, -2), citations, onCitation)}</strong>);
    } else if (token.startsWith("`")) {
      result.push(<code key={`inline-${key}`}>{token.slice(1, -1)}</code>);
    } else {
      result.push(<a href={token} target="_blank" rel="noreferrer" key={`inline-${key}`}>{token}</a>);
    }
    cursor = start + token.length;
    key += 1;
  }
  if (cursor < text.length) result.push(text.slice(cursor));
  return result;
}

function markdownTableRow(line: string) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isMarkdownTableDivider(line: string) {
  const cells = markdownTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function LlmReadableContent({ content, citations, onCitation }: { content: string; citations?: (Citation & { label?: string })[]; onCitation?: (id: string | number) => void }) {
  const lines = String(content || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let index = 0;
  const inline = (value: string) => renderLlmInline(value, citations || [], onCitation);
  const paragraph = (items: string[], key: string) => <p key={key}>{items.map((line, lineIndex) => <span key={`${key}-${lineIndex}`}>{inline(line)}{lineIndex < items.length - 1 ? <br /> : null}</span>)}</p>;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }

    const fence = /^```([\w.+-]*)\s*$/.exec(line.trim());
    if (fence) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index].trim())) { code.push(lines[index]); index += 1; }
      if (index < lines.length) index += 1;
      blocks.push(<div className="llm-code-block" key={`code-${index}`}>{fence[1] ? <span>{fence[1]}</span> : null}<pre><code>{code.join("\n")}</code></pre></div>);
      continue;
    }

    if (line.includes("|") && index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1])) {
      const headers = markdownTableRow(line);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) { rows.push(markdownTableRow(lines[index])); index += 1; }
      blocks.push(<div className="llm-table-wrap" key={`table-${index}`}><table><thead><tr>{headers.map((cell, cellIndex) => <th key={cellIndex}>{inline(cell)}</th>)}</tr></thead><tbody>{rows.map((row, rowIndex) => <tr key={rowIndex}>{headers.map((_, cellIndex) => <td key={cellIndex}>{inline(row[cellIndex] || "")}</td>)}</tr>)}</tbody></table></div>);
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line.trim());
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      blocks.push(level === 1 ? <h2 key={`heading-${index}`}>{inline(heading[2])}</h2> : level === 2 ? <h3 key={`heading-${index}`}>{inline(heading[2])}</h3> : <h4 key={`heading-${index}`}>{inline(heading[2])}</h4>);
      index += 1;
      continue;
    }

    if (/^\s*>\s?/.test(line)) {
      const quote: string[] = [];
      while (index < lines.length && /^\s*>\s?/.test(lines[index])) { quote.push(lines[index].replace(/^\s*>\s?/, "")); index += 1; }
      blocks.push(<blockquote key={`quote-${index}`}>{paragraph(quote, `quote-copy-${index}`)}</blockquote>);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: { text: string; checked?: boolean }[] = [];
      while (index < lines.length && /^\s*[-*+]\s+/.test(lines[index])) {
        const value = lines[index].replace(/^\s*[-*+]\s+/, "");
        const task = /^\[([ xX])\]\s*(.*)$/.exec(value);
        items.push(task ? { text: task[2], checked: task[1].toLowerCase() === "x" } : { text: value });
        index += 1;
      }
      blocks.push(<ul className={items.some((item) => item.checked !== undefined) ? "task-list" : ""} key={`list-${index}`}>{items.map((item, itemIndex) => <li className={item.checked ? "checked" : ""} key={itemIndex}>{item.checked !== undefined ? <span className="task-check">{item.checked ? "✓" : ""}</span> : null}<span>{inline(item.text)}</span></li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^\s*\d+[.)]\s+/.test(lines[index])) { items.push(lines[index].replace(/^\s*\d+[.)]\s+/, "")); index += 1; }
      blocks.push(<ol key={`ordered-${index}`}>{items.map((item, itemIndex) => <li key={itemIndex}>{inline(item)}</li>)}</ol>);
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      blocks.push(<hr key={`rule-${index}`} />);
      index += 1;
      continue;
    }

    const copy: string[] = [];
    while (index < lines.length && lines[index].trim()) {
      if (copy.length && (/^```/.test(lines[index].trim()) || /^(?:#{1,4})\s+/.test(lines[index].trim()) || /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s?)/.test(lines[index]) || (lines[index].includes("|") && index + 1 < lines.length && isMarkdownTableDivider(lines[index + 1])))) break;
      copy.push(lines[index]);
      index += 1;
    }
    blocks.push(paragraph(copy, `paragraph-${index}`));
  }

  return <div className="llm-readable">{blocks}</div>;
}

function MessageText({ content }: { content: string }) {
  const normalized = String(content || "").replace(/\r\n?/g, "\n");
  const sections = normalized.split(/\n{2,}/).filter((section) => section.trim().length > 0);
  const multiline = normalized.includes("\n");
  return (
    <div className={`message-text${multiline ? " multiline" : ""}${normalized.length > 260 ? " long" : ""}`}>
      {(sections.length ? sections : [normalized]).map((section, index) => <p key={`${index}-${section.slice(0, 16)}`}>{section}</p>)}
    </div>
  );
}

function MessageCard({ message, quotedMessage, onCopy, onQuote, onPreview, onTranscribe, transcribing, onJumpOriginal }: { message: Message; quotedMessage?: Message; onCopy: (text: string) => void; onQuote: (message: Message) => void; onPreview: (preview: ImagePreview) => void; onTranscribe: (message: Message) => void; transcribing?: boolean; onJumpOriginal?: () => void }) {
  const [failedMediaKey, setFailedMediaKey] = useState("");
  if (message.type === "system") {
    return <div className="system-message"><span>{message.content}</span></div>;
  }
  const body = (() => {
    if (message.type === "link") {
      const rawTitle = String(message.content || "").replace(/^\[(?:链接|链接\/文件|小程序|文件)\]\s*/u, "").trim();
      const title = /^(?:null|undefined|\(null\))$/i.test(rawTitle) || !rawTitle ? String(message.meta?.cardTypeLabel || "链接消息") : rawTitle;
      const rawDescription = String(message.meta?.description || "").trim();
      const description = /^(?:null|undefined|\(null\))$/i.test(rawDescription) ? "" : rawDescription;
      const rawUrl = String(message.meta?.url || "").trim();
      const url = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
      const rawThumbnailUrl = String(message.meta?.thumbnailUrl || "").trim();
      const thumbnailUrl = /^https?:\/\//i.test(rawThumbnailUrl) ? rawThumbnailUrl : "";
      const cardType = String(message.meta?.cardType || "link");
      const cardTypeLabel = String(message.meta?.cardTypeLabel || (cardType === "record" ? "聊天记录" : "链接"));
      const itemCount = Math.max(0, Number(message.meta?.itemCount || 0));
      const icon = ({ record: "记", file: "文", "mini-program": "小", link: "↗" } as Record<string, string>)[cardType] || "↗";
      let host = "";
      try { host = url ? new URL(url).hostname.replace(/^www\./, "") : ""; } catch {}
      const card = (
        <div className={`link-card card-${cardType}`}>
          <div className="link-icon">{icon}</div>
          <div className="link-content">
            <span className="link-kind">{cardTypeLabel}{itemCount ? ` · ${itemCount} 条内容` : ""}</span>
            <strong>{title}</strong>
            {description ? <p>{description}</p> : null}
            {host ? <small>{host}</small> : null}
          </div>
          {thumbnailUrl ? <img className="link-thumbnail" src={thumbnailUrl} alt="" loading="lazy" referrerPolicy="no-referrer" /> : null}
          {url ? <span className="link-open" aria-hidden="true">›</span> : null}
        </div>
      );
      return url ? <a className="link-card-anchor" href={url} target="_blank" rel="noreferrer" onDoubleClick={(event) => event.stopPropagation()}>{card}</a> : card;
    }
    if (message.type === "image") {
      const mediaUrl = typeof message.meta?.mediaUrl === "string" ? `${API}${message.meta.mediaUrl}` : "";
      const mediaKey = `${message.id}:${String(message.meta?.mediaRevision || "")}`;
      const revision = encodeURIComponent(String(message.meta?.mediaRevision || "local"));
      const thumbnailUrl = `${mediaUrl}?revision=${revision}`;
      const fullUrl = `${mediaUrl}?variant=full&revision=${revision}`;
      if (mediaUrl && failedMediaKey !== mediaKey) return <button type="button" className="image-preview" onClick={() => onPreview({ fullUrl, thumbnailUrl, alt: message.content || "聊天图片" })} title="预览原图" aria-label="预览聊天原图"><img src={thumbnailUrl} alt={message.content || "聊天图片"} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedMediaKey(mediaKey)} /><small>预览原图</small></button>;
      return <div className="image-placeholder"><div className="image-grid"><span /><span /><span /><span /></div><p>{message.content}</p><small>{message.meta?.mediaAvailable === false ? "本机尚未缓存这张图片" : "本地图片暂时无法解码"}</small></div>;
    }
    if (message.type === "video") {
      const revision = encodeURIComponent(String(message.meta?.mediaRevision || "local"));
      const posterUrl = typeof message.meta?.posterUrl === "string" ? `${API}${message.meta.posterUrl}?revision=${revision}` : "";
      const videoUrl = typeof message.meta?.videoUrl === "string" ? `${API}${message.meta.videoUrl}?revision=${revision}` : "";
      const posterAvailable = message.meta?.posterAvailable === true;
      const videoAvailable = message.meta?.videoAvailable === true;
      const durationSeconds = Number(message.meta?.duration || 0);
      const duration = durationSeconds > 0 ? `${Math.floor(durationSeconds / 60)}:${String(Math.round(durationSeconds % 60)).padStart(2, "0")}` : "";
      const videoMediaKey = `video:${message.id}:${revision}`;
      const posterMediaKey = `video-poster:${message.id}:${revision}`;
      if (videoAvailable && videoUrl && failedMediaKey !== videoMediaKey) return <div className="video-preview"><video controls playsInline preload="metadata" poster={posterAvailable ? posterUrl : undefined} src={videoUrl} aria-label={`${message.sender} 发送的视频`} onError={() => setFailedMediaKey(videoMediaKey)} /><span className="video-duration">{duration || "视频"}</span></div>;
      if (posterAvailable && posterUrl && failedMediaKey !== posterMediaKey) return <div className="video-preview video-poster-only"><img src={posterUrl} alt={`${message.sender} 发送的视频封面`} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedMediaKey(posterMediaKey)} /><span className="video-play" aria-hidden="true">▶</span><small>本机仅缓存封面{duration ? ` · ${duration}` : ""}</small></div>;
      return <div className="video-placeholder"><span>▶</span><div><strong>视频</strong><small>本机尚未缓存封面或视频文件</small></div></div>;
    }
    if (message.type === "file") return (
      <div className="file-card"><div className="file-badge">{String(message.meta?.ext || "FILE")}</div><div><strong>{message.content}</strong><small>{String(message.meta?.size || "本地文件")}</small></div><button aria-label="显示文件位置">⌁</button></div>
    );
    if (message.type === "voice") {
      const transcript = String(message.meta?.transcript || "").trim();
      const transcriptionAvailable = message.meta?.transcriptionAvailable === true;
      const transcriptionError = String(message.meta?.transcriptionError || "").trim();
      const model = String(message.meta?.transcriptionModel || "").trim();
      return (
        <div className="voice-message-card">
          <div className="voice-card"><span className="voice-play">▶</span><span className="voice-wave">▁▃▆▂▅▇▃▆▂▅</span><small>{String(message.meta?.duration || "语音")}</small></div>
          {transcript ? <><p className="voice-transcript available">{transcript}</p><small className="voice-transcript-source">本机 Whisper{model ? ` · ${model}` : ""}</small></> : <div className={`voice-transcript-action ${transcriptionError ? "error" : ""}`}><span>{transcribing ? "正在本机转写…" : transcriptionError || (transcriptionAvailable ? "尚未生成文字" : "本地语音数据暂不可用")}</span>{transcriptionAvailable && !transcriptionError ? <button type="button" disabled={transcribing} onClick={(event) => { event.stopPropagation(); onTranscribe(message); }}>{transcribing ? "处理中" : "转为文字"}</button> : null}{transcriptionError ? <button type="button" disabled={transcribing} onClick={(event) => { event.stopPropagation(); onTranscribe(message); }}>重试</button> : null}</div>}
        </div>
      );
    }
    if (message.type === "quote") {
      const quoteType = String(message.meta?.quoteType || quotedMessage?.type || "unknown");
      const quoteTypeLabel = String(message.meta?.quoteTypeLabel || ({ text: "文字", image: "图片", voice: "语音", video: "视频", file: "文件", link: "链接" } as Record<string, string>)[quoteType] || "消息");
      const quoteTimestamp = Number(message.meta?.quoteTimestamp || quotedMessage?.timestamp || 0);
      const quoteText = quoteType === "text" && quotedMessage?.content ? quotedMessage.content : String(message.meta?.quote || quotedMessage?.content || "原消息内容不可用");
      const quoteMediaUrl = quoteType === "image" && typeof quotedMessage?.meta?.mediaUrl === "string" ? `${API}${quotedMessage.meta.mediaUrl}` : "";
      const quoteRevision = encodeURIComponent(String(quotedMessage?.meta?.mediaRevision || "local"));
      const quoteThumbnailUrl = quoteMediaUrl ? `${quoteMediaUrl}?revision=${quoteRevision}` : "";
      const quoteFullUrl = quoteMediaUrl ? `${quoteMediaUrl}?variant=full&revision=${quoteRevision}` : "";
      const quoteMediaKey = `quote:${quotedMessage?.id || message.id}:${quoteRevision}`;
      const quoteIcon = ({ text: "文", image: "图", voice: "声", video: "视", file: "件", link: "链" } as Record<string, string>)[quoteType] || "引";
      return (
        <>
          <div className="quote-block">
            <div className="quote-heading"><i>{quoteIcon}</i><strong>{String(message.meta?.quoteSender || quotedMessage?.sender || "原消息")}</strong><span>{quoteTypeLabel}{quoteTimestamp ? ` · ${formatFullTime(quoteTimestamp)}` : ""}</span></div>
            {quoteThumbnailUrl && failedMediaKey !== quoteMediaKey ? <button type="button" className="quote-image-preview" onClick={(event) => { event.stopPropagation(); onPreview({ fullUrl: quoteFullUrl, thumbnailUrl: quoteThumbnailUrl, alt: `${String(message.meta?.quoteSender || "原消息")}引用的图片` }); }} title="预览被引用的原图"><img src={quoteThumbnailUrl} alt="被引用的图片" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailedMediaKey(quoteMediaKey)} /><span>预览原图</span></button> : null}
            <p>{quoteText}</p>
            {onJumpOriginal ? <button type="button" className="quote-jump" onClick={(event) => { event.stopPropagation(); onJumpOriginal(); }}>定位原消息</button> : <small>原消息内容已从引用记录还原</small>}
          </div>
          <MessageText content={message.content} />
        </>
      );
    }
    return <MessageText content={message.content} />;
  })();

  return (
    <div className={`message-row ${message.isMine ? "mine" : ""}`} id={`message-${message.id}`}>
      {!message.isMine && <AvatarView value={message.avatar} size="small" />}
      {message.isMine && <div className="message-actions" aria-label="消息操作">
        <button type="button" onClick={(event) => { event.stopPropagation(); onCopy(message.content); }} aria-label="复制消息" title="复制消息">复制</button>
        <button type="button" className="quote" onClick={(event) => { event.stopPropagation(); onQuote(message); }} aria-label={`引用 ${message.sender} 的消息到 LLM`} title="引用到 LLM">引用</button>
      </div>}
      <div className="message-stack">
        <div className="message-meta"><span>{message.sender}</span><time>{formatFullTime(message.timestamp)}</time></div>
        <div className={`message-bubble type-${message.type}${message.type === "text" && message.content.includes("\n") ? " multiline-text" : ""}${message.type === "text" && message.content.length > 260 ? " long-text" : ""}`} onDoubleClick={() => onCopy(message.content)} title="双击复制消息">
          {body}
        </div>
      </div>
      {!message.isMine && <div className="message-actions" aria-label="消息操作">
        <button type="button" onClick={(event) => { event.stopPropagation(); onCopy(message.content); }} aria-label="复制消息" title="复制消息">复制</button>
        <button type="button" className="quote" onClick={(event) => { event.stopPropagation(); onQuote(message); }} aria-label={`引用 ${message.sender} 的消息到 LLM`} title="引用到 LLM">引用</button>
      </div>}
      {message.isMine && <AvatarView value={message.avatar} size="small" />}
    </div>
  );
}

function LoadingDots() {
  return <span className="loading-dots" aria-label="正在分析"><i /><i /><i /></span>;
}

function ImageLightbox({ preview, onClose }: { preview: ImagePreview; onClose: () => void }) {
  const [source, setSource] = useState(preview.fullUrl);
  const [loaded, setLoaded] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [usingThumbnail, setUsingThumbnail] = useState(false);
  const [actualSize, setActualSize] = useState({ width: 0, height: 0 });
  const [actualPixels, setActualPixels] = useState(false);

  function handleError() {
    if (source !== preview.thumbnailUrl) {
      setSource(preview.thumbnailUrl);
      setLoaded(false);
      setUsingThumbnail(true);
      setActualPixels(false);
      return;
    }
    setUnavailable(true);
  }

  return (
    <div className="image-lightbox-backdrop" onClick={onClose} role="presentation">
      <section className={`image-lightbox ${actualPixels ? "actual-pixels" : ""}`} role="dialog" aria-modal="true" aria-label="图片预览" onClick={(event) => event.stopPropagation()}>
        <button className="image-lightbox-zoom" type="button" onClick={() => setActualPixels((current) => !current)} disabled={!loaded || unavailable} aria-label={actualPixels ? "适应窗口" : "按原始像素查看"}>{actualPixels ? "适应" : "1:1"}</button>
        <button className="image-lightbox-close" type="button" onClick={onClose} aria-label="关闭图片预览">×</button>
        <div className="image-lightbox-stage">
          {!unavailable && <img className={loaded ? "loaded" : ""} src={source} alt={preview.alt} referrerPolicy="no-referrer" draggable={false} onClick={() => loaded && setActualPixels((current) => !current)} onLoad={(event) => { setActualSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true); }} onError={handleError} />}
          {!loaded && !unavailable && <div className="image-lightbox-loading"><LoadingDots /><span>正在解码本地原图</span></div>}
          {unavailable && <div className="image-lightbox-error"><span>▧</span><strong>这张图片暂时无法预览</strong><small>本机原图与缩略图都不可用</small></div>}
        </div>
        <footer><span>{usingThumbnail ? "本机仅有缩略图" : "本地原图"}{actualSize.width ? ` · ${actualSize.width}×${actualSize.height}` : ""}</span><span>{actualPixels ? "正在按原始像素查看 · 可滚动" : "点击图片或 1:1 放大 · Esc 关闭"}</span></footer>
      </section>
    </div>
  );
}

export default function Home() {
  const [view, setView] = useState("chats");
  const [sessions, setSessions] = useState<Session[]>(fallbackSessions);
  const [contacts, setContacts] = useState<Contact[]>(fallbackContacts);
  const [selectedId, setSelectedId] = useState(fallbackSessions[0].username);
  const [messages, setMessages] = useState<Message[]>(fallbackMessages);
  const [messageTotal, setMessageTotal] = useState(fallbackMessages.length);
  const [messageHasMore, setMessageHasMore] = useState(false);
  const [pendingLatestUsername, setPendingLatestUsername] = useState("");
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [conversationLoading, setConversationLoading] = useState(false);
  const [summary, setSummary] = useState<Summary>(fallbackSummary);
  const [query, setQuery] = useState("");
  const [globalResults, setGlobalResults] = useState<(Message & { chat?: string; username?: string })[]>([]);
  const [rightTab, setRightTab] = useState<"llm" | "local" | "heat">("llm");
  const [period, setPeriod] = useState<AnalysisPeriod>("周");
  const [signalFilter, setSignalFilter] = useState<SignalFilter>("all");
  const [heatMonth, setHeatMonth] = useState(currentShanghaiMonth());
  const [heatScope, setHeatScope] = useState<"all" | "current">("all");
  const [heatmap, setHeatmap] = useState<HeatmapData | null>(null);
  const [heatLoading, setHeatLoading] = useState(false);
  const [heatError, setHeatError] = useState("");
  const [heatRefresh, setHeatRefresh] = useState(0);
  const [selectedHeatDate, setSelectedHeatDate] = useState("");
  const [agentInput, setAgentInput] = useState("");
  const [agentAnswer, setAgentAnswer] = useState<{ answer: string; citations: Citation[] } | null>(null);
  const [llmStatus, setLlmStatus] = useState<LlmStatus>(defaultLlmStatus);
  const [selectedLlmModelId, setSelectedLlmModelId] = useState("");
  const [llmInput, setLlmInput] = useState("");
  const [llmTurns, setLlmTurns] = useState<LlmTurn[]>([]);
  const [llmConversationId, setLlmConversationId] = useState("");
  const [showLlmHistory, setShowLlmHistory] = useState(false);
  const [llmHistoryQuery, setLlmHistoryQuery] = useState("");
  const [llmHistoryScope, setLlmHistoryScope] = useState<"current" | "all">("current");
  const [llmHistories, setLlmHistories] = useState<LlmHistorySummary[]>([]);
  const [llmHistoryLoading, setLlmHistoryLoading] = useState(false);
  const [llmHistoryError, setLlmHistoryError] = useState("");
  const [quotedMessages, setQuotedMessages] = useState<Message[]>([]);
  const [agentPanelOpen, setAgentPanelOpen] = useState(false);
  const [llmLoading, setLlmLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const [service, setService] = useState<ServiceStatus>({ source: "demo", ok: false, readonly: true });
  const [sync, setSync] = useState<SyncStatus>(defaultSyncStatus);
  const [showDetails, setShowDetails] = useState(false);
  const [showContactDetails, setShowContactDetails] = useState(false);
  const [contactDetail, setContactDetail] = useState<ContactDetail | null>(null);
  const [contactDetailLoading, setContactDetailLoading] = useState(false);
  const [contactMembers, setContactMembers] = useState<GroupMember[]>([]);
  const [contactKindFilter, setContactKindFilter] = useState<"contact" | "group">("contact");
  const [showSettings, setShowSettings] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [contactVisibleLimit, setContactVisibleLimit] = useState(240);
  const [messageFilter, setMessageFilter] = useState<"all" | "media">("all");
  const [groupMembers, setGroupMembers] = useState<GroupMember[]>([]);
  const [imagePreview, setImagePreview] = useState<ImagePreview | null>(null);
  const [toast, setToast] = useState("");
  const [transcribingVoiceId, setTranscribingVoiceId] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const llmThreadRef = useRef<HTMLDivElement>(null);
  const selectedIdRef = useRef(selectedId);
  const sessionsRef = useRef(sessions);
  const messagesRef = useRef(messages);
  const messagesSessionRef = useRef(selectedId);
  const revisionRef = useRef("");
  const contactRevisionRef = useRef("");
  const periodRef = useRef<AnalysisPeriod>(period);
  const loadingOlderRef = useRef(false);
  const preserveScrollRef = useRef<{ height: number; top: number } | null>(null);
  const conversationRequestRef = useRef(0);
  const pendingLatestSessionRef = useRef(selectedId);
  const suppressTimelineScrollRef = useRef(true);

  const selected = sessions.find((item) => item.username === selectedId) || sessions[0] || fallbackSessions[0];
  const contactSession = contactDetail ? sessions.find((item) => item.username === contactDetail.username) : undefined;
  const chatSessions = useMemo(() => sessions.filter((item) => categoryOf(item) === "chat"), [sessions]);
  const officialSessions = useMemo(() => sessions.filter((item) => categoryOf(item) === "official"), [sessions]);
  const activeSessionPool = view === "official" ? officialSessions : chatSessions;
  const filteredSessions = useMemo(() => activeSessionPool.filter((item) => (!unreadOnly || item.unread > 0) && `${item.name} ${item.lastMessage}`.toLowerCase().includes(query.toLowerCase())), [activeSessionPool, query, unreadOnly]);
  const contactCounts = useMemo(() => ({
    contact: contacts.filter((item) => item.kind === "contact").length,
    group: contacts.filter((item) => item.kind === "group").length,
  }), [contacts]);
  const filteredContacts = useMemo(() => contacts.filter((item) => item.kind === contactKindFilter && `${item.name} ${item.nickName || ""} ${item.remark || ""} ${item.username}`.toLowerCase().includes(query.toLowerCase())), [contactKindFilter, contacts, query]);
  const visibleContacts = useMemo(() => filteredContacts.slice(0, contactVisibleLimit), [contactVisibleLimit, filteredContacts]);
  const visibleMessages = useMemo(() => messageFilter === "all" ? messages : messages.filter((item) => ["image", "video", "file", "link", "voice"].includes(item.type)), [messages, messageFilter]);
  const messagesByServerId = useMemo(() => new Map(messages.filter((item) => item.serverId).map((item) => [String(item.serverId), item])), [messages]);
  const signalItems = useMemo<SignalItem[]>(() => [
    ...summary.decisions.map((item) => ({ ...item, kind: "结论" as const, tone: "decision" as const })),
    ...summary.todos.map((item) => ({ ...item, kind: "待办" as const, tone: "todo" as const })),
    ...summary.risks.map((item) => ({ ...item, kind: "风险" as const, tone: "risk" as const })),
  ].sort((left, right) => Number(right.timestamp || 0) - Number(left.timestamp || 0)), [summary.decisions, summary.risks, summary.todos]);
  const filteredSignalItems = useMemo(() => signalFilter === "all" ? signalItems : signalItems.filter((item) => item.tone === signalFilter), [signalFilter, signalItems]);
  const selectedLlmModel = useMemo(() => llmStatus.models.find((model) => model.id === selectedLlmModelId) || llmStatus.models.find((model) => model.id === llmStatus.defaultModelId) || llmStatus.models[0] || null, [llmStatus, selectedLlmModelId]);
  const llmReady = Boolean(llmStatus.configured && selectedLlmModel?.credentialReady);

  // The local API has endpoint-specific payloads covered by integration tests;
  // keep this transport dynamic until a generated schema client is introduced.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getJson = useCallback(async (path: string, options?: RequestInit): Promise<any> => {
    const response = await fetch(`${API}${path}`, { cache: "no-store", ...options });
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    if (!response.ok) throw new Error(typeof body.error === "string" ? body.error : String(response.status));
    return body;
  }, []);

  const refreshContacts = useCallback(async () => {
    const data = await getJson("/contacts");
    if (!stableContactPayload(data)) throw new Error("联系人快照正在切换");
    setContacts(Array.isArray(data.contacts) ? data.contacts : []);
    contactRevisionRef.current = String(data.revision || "");
    return data;
  }, [getJson]);

  useEffect(() => {
    setContactVisibleLimit(240);
  }, [contactKindFilter, contacts, query]);

  useEffect(() => {
    let cancelled = false;
    async function initializeWorkspace() {
      try {
        const [health, sessionData, contactData, llmData] = await Promise.all([getJson("/health"), getJson("/sessions?limit=2000"), getJson("/contacts"), getJson("/llm/status")]);
        if (cancelled) return;
        setService(health);
        if (health.sync) {
          setSync(health.sync);
          revisionRef.current = health.sync.revision || "";
        }
        if (stableContactPayload(contactData)) {
          setContacts(Array.isArray(contactData.contacts) ? contactData.contacts : []);
          contactRevisionRef.current = String(contactData.revision || health.sync?.contactRevision || "");
        }
        if (llmData.llm) {
          setLlmStatus(normalizeLlmStatus(llmData.llm));
          setSelectedLlmModelId((current) => llmData.llm.models?.some((model: LlmModel) => model.id === current) ? current : llmData.llm.defaultModelId || llmData.llm.models?.[0]?.id || "");
        }

        const initialSessions = ((sessionData.sessions || []) as Session[]).filter(visibleSession);
        const initialSession = initialSessions.find((session) => categoryOf(session) === "chat") || initialSessions[0];
        if (!initialSession) {
          setConversationLoading(false);
          return;
        }
        setConversationLoading(true);
        setSessions(initialSessions);
        sessionsRef.current = initialSessions;
        selectedIdRef.current = initialSession.username;
        pendingLatestSessionRef.current = initialSession.username;
        suppressTimelineScrollRef.current = true;
        setSelectedId(initialSession.username);

        const [chatData, statsData] = await Promise.all([
          getJson(`/chats/${encodeURIComponent(initialSession.username)}/messages?limit=160`),
          getJson(statsPath(initialSession.username, "周")),
        ]);
        if (cancelled) return;
        const initialMessages = chatData.messages?.length ? chatData.messages : [{ id: "empty", sender: "系统", senderId: "system", timestamp: baseTime, type: "system", content: "这段会话还没有可读取的本地消息" }];
        messagesSessionRef.current = initialSession.username;
        messagesRef.current = initialMessages;
        setMessages(initialMessages);
        setMessageTotal(Number(chatData.total ?? chatData.messages?.length ?? 0));
        setMessageHasMore(Boolean(chatData.hasMore));
        if (statsData.summary) setSummary(statsData.summary);
        setConversationLoading(false);
      } catch {
        if (!cancelled) {
          setService({ source: "demo", ok: false, readonly: true });
          setConversationLoading(false);
        }
      }
    }
    void initializeWorkspace();
    return () => { cancelled = true; };
  }, [getJson]);

  useEffect(() => {
    selectedIdRef.current = selectedId;
  }, [selectedId]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    periodRef.current = period;
  }, [period]);

  useEffect(() => {
    if (rightTab !== "heat") return;
    let cancelled = false;
    setHeatLoading(true);
    setHeatError("");
    setHeatmap(null);
    const timer = window.setTimeout(async () => {
      try {
        const params = new URLSearchParams({ month: heatMonth });
        if (heatScope === "current") params.set("chat", selected.username);
        const data = await getJson(`/heatmap?${params.toString()}`);
        if (cancelled) return;
        const next = data.heatmap as HeatmapData;
        setHeatmap(next);
        setSelectedHeatDate((current) => {
          if (next.days.some((day) => day.date === current)) return current;
          const today = currentShanghaiMonth() === next.month ? new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10) : "";
          return next.days.some((day) => day.date === today) ? today : next.peakDay?.date || next.days[0]?.date || "";
        });
      } catch (error) {
        if (!cancelled) setHeatError(error instanceof Error ? error.message : "月度统计暂时无法读取");
      } finally {
        if (!cancelled) setHeatLoading(false);
      }
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [getJson, heatMonth, heatRefresh, heatScope, rightTab, selected.name, selected.username]);

  useEffect(() => {
    let cancelled = false;
    let polling = false;
    async function pollLiveSync() {
      if (polling) return;
      polling = true;
      try {
        const statusData = await getJson("/sync/status");
        if (cancelled || !statusData.sync) return;
        const nextSync = statusData.sync as SyncStatus;
        setSync(nextSync);
        setService((current) => ({ ...current, source: statusData.source || current.source, ok: true, sync: nextSync }));
        if (!nextSync.revision) return;
        const workspaceChanged = nextSync.revision !== revisionRef.current;
        const contactsStale = Boolean(nextSync.contactRevision && nextSync.contactRevision !== contactRevisionRef.current);
        if (!workspaceChanged && !contactsStale) return;

        const [sessionResult, contactResult] = await Promise.allSettled([
          workspaceChanged ? getJson("/sessions?limit=2000") : Promise.resolve(null),
          contactsStale ? getJson("/contacts") : Promise.resolve(null),
        ]);
        if (cancelled) return;
        if (contactResult.status === "fulfilled" && contactResult.value && stableContactPayload(contactResult.value)) {
          setContacts(Array.isArray(contactResult.value.contacts) ? contactResult.value.contacts : []);
          contactRevisionRef.current = String(contactResult.value.revision || nextSync.contactRevision || "");
        }
        if (!workspaceChanged) return;
        if (sessionResult.status === "rejected" || !sessionResult.value) throw sessionResult.status === "rejected" ? sessionResult.reason : new Error("session refresh failed");
        const nextSessions = ((sessionResult.value.sessions || []) as Session[]).filter(visibleSession);
        const currentUsername = selectedIdRef.current;
        const previousSelection = sessionsRef.current.find((session) => session.username === currentUsername);
        const nextSelection = nextSessions.find((session) => session.username === currentUsername);
        setSessions(nextSessions);
        sessionsRef.current = nextSessions;
        if (selectedIdRef.current === currentUsername && nextSelection && sessionHasNewMessages(previousSelection, nextSelection) && messagesSessionRef.current === currentUsername) {
          const requestId = conversationRequestRef.current;
          const timeline = timelineRef.current;
          const followLatest = isTimelineNearLatest(timeline);
          const [chatResult, statsResult] = await Promise.allSettled([
            getJson(`/chats/${encodeURIComponent(currentUsername)}/messages?limit=160`),
            getJson(statsPath(currentUsername, periodRef.current)),
          ]);
          if (!cancelled && requestId === conversationRequestRef.current && selectedIdRef.current === currentUsername && messagesSessionRef.current === currentUsername) {
            if (chatResult.status === "fulfilled") {
              const incoming = (chatResult.value.messages || []) as Message[];
              const merged = mergeConversationMessages(messagesRef.current, incoming);
              messagesRef.current = merged;
              setMessages(merged.length ? merged : [{ id: "empty", sender: "系统", senderId: "system", timestamp: baseTime, type: "system", content: "这段会话还没有可读取的本地消息" }]);
              const total = Number(chatResult.value.total ?? merged.length);
              setMessageTotal(total);
              setMessageHasMore(merged.length < total);
              if (followLatest) {
                pendingLatestSessionRef.current = currentUsername;
                suppressTimelineScrollRef.current = true;
                setPendingLatestUsername((current) => current === currentUsername ? "" : current);
              } else {
                pendingLatestSessionRef.current = "";
                setPendingLatestUsername(currentUsername);
              }
            }
            if (statsResult.status === "fulfilled" && statsResult.value.summary) setSummary(statsResult.value.summary);
          }
        }
        revisionRef.current = nextSync.revision;
      } catch {
        if (!cancelled) setSync((current) => ({ ...current, state: "offline" }));
      } finally {
        polling = false;
      }
    }
    void pollLiveSync();
    const timer = window.setInterval(() => { void pollLiveSync(); }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [getJson]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setShowDetails(false);
        setShowContactDetails(false);
        setShowSettings(false);
        setImagePreview(null);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  useLayoutEffect(() => {
    const timeline = timelineRef.current;
    if (!timeline || conversationLoading) return;
    const preserved = preserveScrollRef.current;
    if (preserved) {
      timeline.scrollTop = timeline.scrollHeight - preserved.height + preserved.top;
      preserveScrollRef.current = null;
      return;
    }
    if (pendingLatestSessionRef.current !== selectedId) return;

    let finalFrame = 0;
    const showLatest = () => {
      timeline.scrollTop = timeline.scrollHeight;
    };
    showLatest();
    const layoutFrame = window.requestAnimationFrame(() => {
      showLatest();
      finalFrame = window.requestAnimationFrame(() => {
        showLatest();
        pendingLatestSessionRef.current = "";
        suppressTimelineScrollRef.current = false;
      });
    });
    return () => {
      window.cancelAnimationFrame(layoutFrame);
      if (finalFrame) window.cancelAnimationFrame(finalFrame);
    };
  }, [conversationLoading, messages, selectedId]);

  useEffect(() => {
    llmThreadRef.current?.scrollTo({ top: llmThreadRef.current.scrollHeight, behavior: "smooth" });
  }, [llmTurns, llmLoading]);

  const loadLlmHistory = useCallback(async () => {
    setLlmHistoryLoading(true);
    setLlmHistoryError("");
    try {
      const params = new URLSearchParams({ limit: "80" });
      if (llmHistoryQuery.trim()) params.set("q", llmHistoryQuery.trim());
      if (llmHistoryScope === "current") params.set("username", selected.username);
      const data = await getJson(`/llm/history?${params.toString()}`);
      setLlmHistories(data.histories || []);
      if (data.history) setLlmStatus((current) => ({ ...current, history: data.history }));
    } catch (error) {
      setLlmHistoryError(error instanceof Error ? error.message : "本地历史暂时无法读取");
    } finally {
      setLlmHistoryLoading(false);
    }
  }, [getJson, llmHistoryQuery, llmHistoryScope, selected.username]);

  useEffect(() => {
    if (!showLlmHistory) return;
    const timer = window.setTimeout(() => { void loadLlmHistory(); }, 180);
    return () => window.clearTimeout(timer);
  }, [loadLlmHistory, showLlmHistory]);

  async function selectSession(session: Session) {
    const requestId = ++conversationRequestRef.current;
    selectedIdRef.current = session.username;
    setPendingLatestUsername("");
    pendingLatestSessionRef.current = session.username;
    suppressTimelineScrollRef.current = true;
    setConversationLoading(true);
    setSelectedId(session.username);
    setView(categoryOf(session) === "official" ? "official" : "chats");
    setAgentAnswer(null);
    setLlmTurns([]);
    setLlmConversationId("");
    setShowLlmHistory(false);
    setQuotedMessages([]);
    setMessageFilter("all");
    preserveScrollRef.current = null;
    try {
      const data = await getJson(`/chats/${encodeURIComponent(session.username)}/messages?limit=160`);
      if (requestId !== conversationRequestRef.current || selectedIdRef.current !== session.username) return;
      const nextMessages = data.messages?.length ? data.messages : [{ id: "empty", sender: "系统", senderId: "system", timestamp: baseTime, type: "system", content: "这段会话还没有可读取的本地消息" }];
      messagesSessionRef.current = session.username;
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setMessageTotal(Number(data.total ?? data.messages?.length ?? 0));
      setMessageHasMore(Boolean(data.hasMore));
      const stats = await getJson(statsPath(session.username, period));
      if (requestId !== conversationRequestRef.current || selectedIdRef.current !== session.username) return;
      if (stats.summary) setSummary(stats.summary);
    } catch {
      if (requestId !== conversationRequestRef.current || selectedIdRef.current !== session.username) return;
      const fallback = session.username === "ai-lab@chatroom" ? fallbackMessages : [{ id: `demo-${session.username}`, sender: "系统", senderId: "system", timestamp: baseTime, type: "system", content: "演示数据中暂无更多消息" }];
      messagesSessionRef.current = session.username;
      messagesRef.current = fallback;
      setMessages(fallback);
      setMessageTotal(fallback.length);
      setMessageHasMore(false);
    } finally {
      if (requestId === conversationRequestRef.current && selectedIdRef.current === session.username) setConversationLoading(false);
    }
  }

  async function loadLatestMessages() {
    const username = selected.username;
    const requestId = ++conversationRequestRef.current;
    selectedIdRef.current = username;
    pendingLatestSessionRef.current = username;
    suppressTimelineScrollRef.current = true;
    preserveScrollRef.current = null;
    setConversationLoading(true);
    try {
      const [chatData, statsData] = await Promise.all([
        getJson(`/chats/${encodeURIComponent(username)}/messages?limit=160`),
        getJson(statsPath(username, periodRef.current)),
      ]);
      if (requestId !== conversationRequestRef.current || selectedIdRef.current !== username) return;
      const nextMessages = chatData.messages?.length ? chatData.messages : [{ id: "empty", sender: "系统", senderId: "system", timestamp: baseTime, type: "system", content: "这段会话还没有可读取的本地消息" }];
      messagesSessionRef.current = username;
      messagesRef.current = nextMessages;
      setMessages(nextMessages);
      setMessageTotal(Number(chatData.total ?? chatData.messages?.length ?? 0));
      setMessageHasMore(Boolean(chatData.hasMore));
      if (statsData.summary) setSummary(statsData.summary);
      setPendingLatestUsername((current) => current === username ? "" : current);
    } catch {
      setToast("最新消息暂时无法读取");
      window.setTimeout(() => setToast(""), 1800);
    } finally {
      if (requestId === conversationRequestRef.current && selectedIdRef.current === username) setConversationLoading(false);
    }
  }

  async function loadOlderMessages() {
    if (loadingOlderRef.current || !messageHasMore || !messages.length) return;
    const oldestTimestamp = Math.min(...messages.map((message) => message.timestamp).filter(Number.isFinite));
    if (!Number.isFinite(oldestTimestamp)) return;
    loadingOlderRef.current = true;
    setLoadingOlder(true);
    const timeline = timelineRef.current;
    if (timeline) preserveScrollRef.current = { height: timeline.scrollHeight, top: timeline.scrollTop };
    try {
      const oldestSequence = messages[0]?.sortSeq;
      const cursor = oldestSequence ? `beforeSeq=${encodeURIComponent(oldestSequence)}` : `before=${oldestTimestamp}`;
      const data = await getJson(`/chats/${encodeURIComponent(selected.username)}/messages?limit=160&${cursor}`);
      const older = (data.messages || []) as Message[];
      if (older.length) {
        setMessages((current) => {
          const known = new Set(current.map((message) => String(message.id)));
          return [...older.filter((message) => !known.has(String(message.id))), ...current];
        });
      } else {
        preserveScrollRef.current = null;
      }
      setMessageTotal(Number(data.total ?? messageTotal));
      setMessageHasMore(Boolean(data.hasMore && older.length));
    } catch {
      preserveScrollRef.current = null;
      setToast("更早的消息暂时无法读取");
      window.setTimeout(() => setToast(""), 1600);
    } finally {
      loadingOlderRef.current = false;
      setLoadingOlder(false);
    }
  }

  function navigateTo(nextView: string) {
    if (nextView === "contacts") {
      setView("contacts");
      void refreshContacts().catch(() => {
        setToast("联系人暂时无法刷新，继续显示上次结果");
        window.setTimeout(() => setToast(""), 1800);
      });
      return;
    }
    if (nextView === "chats" || nextView === "official") {
      const nextCategory: SessionCategory = nextView === "official" ? "official" : "chat";
      const pool = nextCategory === "official" ? officialSessions : chatSessions;
      if (categoryOf(selected) !== nextCategory && pool[0]) {
        void selectSession(pool[0]);
        return;
      }
    }
    setView(nextView);
  }

  function openPrivacyHome() {
    conversationRequestRef.current += 1;
    setView("privacy");
    setAgentPanelOpen(false);
    setShowDetails(false);
    setShowContactDetails(false);
    setShowSettings(false);
    setImagePreview(null);
    setToast("");
  }

  async function runSearch(searchTerm = query) {
    if (!searchTerm.trim()) return;
    setView("search");
    setLoading(true);
    try {
      const data = await getJson(`/search?q=${encodeURIComponent(searchTerm.trim())}`);
      setGlobalResults(data.results || []);
    } catch {
      setGlobalResults(fallbackMessages.filter((item) => `${item.sender} ${item.content}`.toLowerCase().includes(searchTerm.toLowerCase())).map((item) => ({ ...item, chat: fallbackSessions[0].name, username: fallbackSessions[0].username })));
    } finally { setLoading(false); }
  }

  async function changeAnalysisPeriod(nextPeriod: AnalysisPeriod) {
    const username = selected.username;
    periodRef.current = nextPeriod;
    setPeriod(nextPeriod);
    setAgentAnswer(null);
    setAnalysisLoading(true);
    try {
      const data = await getJson(statsPath(username, nextPeriod));
      if (selectedIdRef.current === username && data.summary) setSummary(data.summary);
    } catch {
      setToast("所选时段暂时无法统计");
      window.setTimeout(() => setToast(""), 1600);
    } finally {
      setAnalysisLoading(false);
    }
  }

  async function generateSummary() {
    setLoading(true);
    setRightTab("local");
    try {
      const data = await getJson("/agent/summarize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: selected.username, period: analysisPeriodKey(period) }) });
      if (data.summary) setSummary(data.summary);
    } catch { setSummary(fallbackSummary); }
    finally { setLoading(false); }
  }

  async function askAgent(question = agentInput) {
    if (!question.trim()) return;
    setAgentInput("");
    setLoading(true);
    try {
      const data = await getJson("/agent/ask", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: selected.username, question, period: analysisPeriodKey(period) }) });
      setAgentAnswer(data.result);
    } catch {
      setAgentAnswer({ answer: "本地服务暂未连接。当前界面仍可浏览演示数据；启动本地服务后即可基于真实快照检索。", citations: [] });
    } finally { setLoading(false); }
  }

  function quoteForLlm(message: Message) {
    setRightTab("llm");
    setShowLlmHistory(false);
    setAgentPanelOpen(true);
    setQuotedMessages((current) => current.some((item) => String(item.id) === String(message.id)) ? current : [...current, message].slice(-6));
    setToast("已引用到 LLM 输入区");
    window.setTimeout(() => setToast(""), 1400);
    window.setTimeout(() => document.getElementById("llm-input")?.focus(), 0);
  }

  function startNewLlmConversation() {
    setLlmConversationId("");
    setLlmTurns([]);
    setQuotedMessages([]);
    setShowLlmHistory(false);
    setLlmInput("");
  }

  async function openLlmHistory(id: string) {
    setLlmHistoryLoading(true);
    setLlmHistoryError("");
    try {
      const data = await getJson(`/llm/history/${encodeURIComponent(id)}`);
      const history = data.history as LlmHistoryRecord;
      const target = sessions.find((session) => session.username === history.username);
      if (!target) throw new Error("对应的微信会话当前不在本地会话列表中，无法安全恢复上下文");
      if (target.username !== selected.username) await selectSession(target);
      setLlmConversationId(history.id);
      setLlmTurns(history.turns || []);
      setQuotedMessages([]);
      if (llmStatus.models.some((model) => model.id === history.modelId)) setSelectedLlmModelId(history.modelId);
      setShowLlmHistory(false);
      setRightTab("llm");
    } catch (error) {
      setLlmHistoryError(error instanceof Error ? error.message : "这条历史记录暂时无法打开");
    } finally {
      setLlmHistoryLoading(false);
    }
  }

  async function askLlm(question = llmInput) {
    const content = question.trim();
    if (!content || llmLoading) return;
    setRightTab("llm");
    if (!llmReady || !selectedLlmModel) {
      setShowSettings(true);
      setToast("请先选择一个已加载凭据的模型");
      window.setTimeout(() => setToast(""), 1800);
      return;
    }
    const userTurn: LlmTurn = { id: crypto.randomUUID(), role: "user", content };
    const history = llmTurns.filter((turn) => !turn.error).map((turn) => ({ role: turn.role, content: turn.content }));
    setLlmTurns((current) => [...current, userTurn]);
    setLlmInput("");
    setLlmLoading(true);
    try {
      const data = await getJson("/llm/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: selected.username, question: content, modelId: selectedLlmModel.id, conversationId: llmConversationId, history, referenceIds: quotedMessages.map((message) => message.id) }),
      });
      const result = data.result;
      setLlmTurns((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: result.answer, citations: result.citations || [], model: result.model, contextMessages: result.contextMessages, usage: result.usage }]);
      if (result.conversationId) setLlmConversationId(result.conversationId);
      if (data.conversation) setLlmStatus((current) => ({ ...current, history: { ...current.history, conversationCount: Math.max(current.history.conversationCount, llmConversationId ? current.history.conversationCount : current.history.conversationCount + 1) } }));
      setQuotedMessages([]);
    } catch (error) {
      setLlmTurns((current) => [...current, { id: crypto.randomUUID(), role: "assistant", content: error instanceof Error ? error.message : "LLM 请求失败，请稍后重试。", error: true }]);
      try {
        const llmData = await getJson("/llm/status");
        if (llmData.llm) setLlmStatus(normalizeLlmStatus(llmData.llm));
      } catch {}
    } finally {
      setLlmLoading(false);
    }
  }

  async function refreshWorkspace() {
    setLoading(true);
    try {
      const [health, sessionData, contactData, llmData] = await Promise.all([getJson("/health"), getJson("/sessions?limit=2000"), getJson("/contacts"), getJson("/llm/status")]);
      setService(health);
      if (health.sync) {
        setSync(health.sync);
        revisionRef.current = health.sync.revision || revisionRef.current;
      }
      const refreshedSessions = ((sessionData.sessions || []) as Session[]).filter(visibleSession);
      const refreshedSelection = refreshedSessions.find((session) => session.username === selectedId) || refreshedSessions[0];
      if (refreshedSessions.length) {
        setSessions(refreshedSessions);
        sessionsRef.current = refreshedSessions;
      }
      if (stableContactPayload(contactData)) {
        setContacts(Array.isArray(contactData.contacts) ? contactData.contacts : []);
        contactRevisionRef.current = String(contactData.revision || health.sync?.contactRevision || "");
      }
      if (llmData.llm) {
        setLlmStatus(normalizeLlmStatus(llmData.llm));
        setSelectedLlmModelId((current) => llmData.llm.models?.some((model: LlmModel) => model.id === current) ? current : llmData.llm.defaultModelId || llmData.llm.models?.[0]?.id || "");
      }
      if (refreshedSelection) {
        selectedIdRef.current = refreshedSelection.username;
        pendingLatestSessionRef.current = refreshedSelection.username;
        suppressTimelineScrollRef.current = true;
        preserveScrollRef.current = null;
        setPendingLatestUsername("");
        setSelectedId(refreshedSelection.username);
        const [chatData, statsData] = await Promise.all([
          getJson(`/chats/${encodeURIComponent(refreshedSelection.username)}/messages?limit=160`),
          getJson(statsPath(refreshedSelection.username, period)),
        ]);
        const refreshedMessages = chatData.messages?.length ? chatData.messages : [{ id: "empty", sender: "系统", senderId: "system", timestamp: baseTime, type: "system", content: "这段会话还没有可读取的本地消息" }];
        messagesSessionRef.current = refreshedSelection.username;
        messagesRef.current = refreshedMessages;
        setMessages(refreshedMessages);
        setMessageTotal(Number(chatData.total ?? chatData.messages?.length ?? 0));
        setMessageHasMore(Boolean(chatData.hasMore));
        if (statsData.summary) setSummary(statsData.summary);
      }
      setToast("本地索引已刷新");
    } catch {
      setToast("本地服务未连接，继续使用演示数据");
    } finally {
      setLoading(false);
      window.setTimeout(() => setToast(""), 1800);
    }
  }

  async function openDetails() {
    setShowDetails(true);
    setGroupMembers([]);
    if (!selected.isGroup) return;
    try {
      const data = await getJson(`/groups/${encodeURIComponent(selected.username)}/members`);
      setGroupMembers(data.members || []);
    } catch {}
  }

  async function openContactDetails(contact: Contact) {
    setContactDetail(contact);
    setContactMembers([]);
    setContactDetailLoading(true);
    setShowContactDetails(true);
    const [detailResult, memberResult] = await Promise.allSettled([
      getJson(`/contacts/${encodeURIComponent(contact.username)}`),
      contact.kind === "group" ? getJson(`/groups/${encodeURIComponent(contact.username)}/members`) : Promise.resolve(null),
    ]);
    if (detailResult.status === "fulfilled" && detailResult.value?.contact) {
      setContactDetail((current) => current?.username === contact.username ? { ...contact, ...detailResult.value.contact, avatar: detailResult.value.contact.avatar || contact.avatar } : current);
    }
    if (memberResult.status === "fulfilled" && memberResult.value) setContactMembers(memberResult.value.members || []);
    setContactDetailLoading(false);
  }

  function openContactConversation() {
    if (!contactSession) return;
    setShowContactDetails(false);
    void selectSession(contactSession);
  }

  function exportConversation(format: "markdown" | "json") {
    const safeName = selected.name.replace(/[\\/:*?"<>|]/g, "-");
    const content = format === "json"
      ? JSON.stringify({ exportedAt: new Date().toISOString(), readonly: true, session: selected, messages }, null, 2)
      : [`# ${selected.name}`, "", `- 会话 ID：${selected.username}`, `- 导出时间：${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`, "- 来源：Weixin AgentOS 本地只读视图", "", ...messages.map((message) => `## ${message.sender} · ${formatFullTime(message.timestamp)}\n\n${message.content}\n`)].join("\n");
    const blob = new Blob([content], { type: format === "json" ? "application/json;charset=utf-8" : "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${safeName}.${format === "json" ? "json" : "md"}`;
    link.click();
    URL.revokeObjectURL(url);
    setToast(`已导出 ${format === "json" ? "JSON" : "Markdown"}`);
    window.setTimeout(() => setToast(""), 1600);
  }

  function jumpToCitation(id: string | number) {
    setMessageFilter("all");
    window.setTimeout(() => document.getElementById(`message-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 0);
  }

  async function copyText(text: string) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(text);
      setToast("已复制到剪贴板");
    } catch {
      const input = document.createElement("textarea");
      input.value = text;
      input.setAttribute("readonly", "");
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand("copy");
      input.remove();
      setToast(copied ? "已复制到剪贴板" : "复制失败，请重试");
    }
    window.setTimeout(() => setToast(""), 1600);
  }

  async function transcribeVoice(message: Message) {
    const localId = Number(message.meta?.localId || 0);
    if (!Number.isSafeInteger(localId) || localId < 0) {
      setToast("这条语音缺少本地索引");
      window.setTimeout(() => setToast(""), 1800);
      return;
    }
    const messageId = String(message.id);
    setTranscribingVoiceId(messageId);
    setMessages((current) => current.map((item) => String(item.id) === messageId ? { ...item, meta: { ...item.meta, transcriptionError: "" } } : item));
    try {
      const data = await getJson(`/chats/${encodeURIComponent(selected.username)}/voice/${localId}/transcript`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ serverId: message.serverId || message.meta?.serverId || "", createTime: message.meta?.createTime || message.timestamp }),
      });
      const transcription = data.transcription || {};
      const transcript = String(transcription.transcript || "").trim();
      setMessages((current) => current.map((item) => String(item.id) === messageId ? { ...item, meta: { ...item.meta, transcript, transcriptionStatus: transcription.status || (transcript ? "available" : "no-speech"), transcriptionEngine: transcription.engine || "openai-whisper-local", transcriptionModel: transcription.model || "", transcriptionError: "" } } : item));
      setToast(transcript ? (transcription.cached ? "已读取本机转写缓存" : "语音已转为文字") : "这条语音没有识别到清晰内容");
    } catch (error) {
      const messageText = error instanceof Error ? error.message : "本地转写失败";
      setMessages((current) => current.map((item) => String(item.id) === messageId ? { ...item, meta: { ...item.meta, transcriptionError: messageText } } : item));
      setToast(messageText);
    } finally {
      setTranscribingVoiceId("");
      window.setTimeout(() => setToast(""), 2600);
    }
  }

  const navTitle = view === "official" ? "公众号与服务号" : view === "contacts" ? "联系人" : view === "search" ? "消息搜索" : view === "insights" ? "本地洞察" : "聊天";
  const speakerMax = Math.max(1, ...summary.topSpeakers.map((item) => item.count));
  const heatLeadingCells = heatmap ? (new Date(`${heatmap.month}-01T00:00:00+08:00`).getDay() + 6) % 7 : 0;
  const heatCalendarCells: (HeatmapDay | null)[] = heatmap ? [...Array.from({ length: heatLeadingCells }, () => null), ...heatmap.days] : [];
  while (heatCalendarCells.length % 7) heatCalendarCells.push(null);
  const selectedHeatDay = heatmap?.days.find((day) => day.date === selectedHeatDate) || null;
  const liveMode = service.source === "local-live";
  const syncLabel = liveMode
    ? ({ live: formatSyncAge(sync.lastSyncAt), syncing: "正在同步新消息", settling: "检测到微信更新", "needs-keys": "等待安全凭据", "waiting-for-wechat": "等待微信数据", error: "同步需要检查", offline: "同步服务离线", starting: "正在启动同步" }[sync.state] || "实时只读")
    : service.source === "local-snapshot" ? "本地快照已连接" : "安全演示模式";
  const syncDot = liveMode ? (sync.state === "live" ? "online" : sync.state === "error" || sync.state === "offline" ? "error" : "syncing") : service.ok ? "online" : "demo";
  const hasPendingLatest = pendingLatestUsername === selected.username;

  return (
    <main className={`agentos-shell ${view === "privacy" ? "privacy-mode" : ""}`}>
      <aside className="nav-rail" aria-label="主导航">
        <button type="button" className={`brand-mark profile-entry ${view === "privacy" ? "active" : ""}`} onClick={openPrivacyHome} aria-label="打开隐私首页" aria-pressed={view === "privacy"} title="隐私首页 · 隐藏聊天内容"><AvatarView value={avatar("我", "dark")} size="small" /><i /></button>
        <nav>
          {navItems.map((item) => <button key={item.id} className={view === item.id ? "active" : ""} onClick={() => navigateTo(item.id)} aria-label={item.label} title={item.label}><span>{item.icon}</span><small>{item.label}</small></button>)}
        </nav>
        <div className="rail-bottom">
          <button onClick={() => setShowSettings(true)} aria-label="设置" title="设置"><span>⚙</span><small>设置</small></button>
        </div>
      </aside>

      {view === "privacy" && <section className="privacy-home" aria-label="隐私首页">
        <div className="privacy-home-card">
          <div className="privacy-home-mark" aria-hidden="true"><span>隐</span><i /></div>
          <p className="eyebrow">PRIVACY HOME</p>
          <h1>聊天内容已隐藏</h1>
          <p>当前页面不显示好友、群聊、消息内容或对话详情，适合临时离开座位或防止旁人窥屏。</p>
          <div className="privacy-home-actions"><button type="button" onClick={() => navigateTo("chats")}>返回聊天</button><span>也可以从左侧选择其他功能</span></div>
        </div>
      </section>}

      {view !== "privacy" && <aside className="list-panel">
        <div className="list-heading">
          <div><p className="eyebrow">WEIXIN AGENTOS</p><h1>{navTitle}</h1></div>
          <div className="list-tools"><button className="icon-button" onClick={refreshWorkspace} aria-label="刷新本地索引" title="刷新本地索引">↻</button><button className={`icon-button ${unreadOnly ? "active" : ""}`} onClick={() => setUnreadOnly((value) => !value)} aria-pressed={unreadOnly} aria-label="仅显示未读会话" title={unreadOnly ? "显示全部会话" : "仅显示未读会话"}>≡</button></div>
        </div>
        <div className="search-box">
          <span>⌕</span>
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={(event) => event.key === "Enter" && runSearch()} placeholder={view === "contacts" ? "搜索联系人" : view === "official" ? "搜索公众号与服务号" : "搜索会话与消息"} aria-label="搜索" />
          {query ? <button onClick={() => setQuery("")} aria-label="清空搜索">×</button> : <kbd>⌘K</kbd>}
        </div>

        {view === "contacts" ? (
          <div className="contact-list scroll-area" onScroll={(event) => {
            const target = event.currentTarget;
            if (target.scrollHeight - target.scrollTop - target.clientHeight < 320) setContactVisibleLimit((current) => Math.min(current + 240, filteredContacts.length));
          }}>
            <div className="contact-kind-tabs" aria-label="联系人分类">
              <button className={contactKindFilter === "contact" ? "active" : ""} onClick={() => setContactKindFilter("contact")}><span>联系人</span><em>{contactCounts.contact}</em></button>
              <button className={contactKindFilter === "group" ? "active" : ""} onClick={() => setContactKindFilter("group")}><span>群聊</span><em>{contactCounts.group}</em></button>
            </div>
            <div className="section-caption"><span>{contactKindFilter === "group" ? "已保存的群聊" : "微信通讯录"}</span><em>{filteredContacts.length}</em></div>
            {visibleContacts.map((contact) => (
              <button key={contact.username} className="contact-row" onClick={() => void openContactDetails(contact)}>
                <AvatarView value={contact.avatar} /><div><strong>{contact.name}</strong><span>{contact.kind === "group" ? `${contact.memberCount || "—"} 人群聊` : contact.remark && contact.remark !== contact.name ? `昵称：${contact.nickName || contact.name}` : contact.nickName || contact.username}</span></div><i>›</i>
              </button>
            ))}
            {visibleContacts.length < filteredContacts.length && <button className="load-more-contacts" onClick={() => setContactVisibleLimit((current) => Math.min(current + 240, filteredContacts.length))}>继续加载 · 已显示 {visibleContacts.length} / {filteredContacts.length}</button>}
            {!filteredContacts.length && <div className="empty-state"><span>♙</span><p>没有匹配的联系人</p><small>联系人会随本地只读快照更新</small></div>}
          </div>
        ) : view === "search" ? (
          <div className="search-result-list scroll-area">
            <div className="section-caption"><span>全局结果</span><em>{globalResults.length}</em></div>
            {loading ? <div className="empty-state"><LoadingDots /><p>正在本地检索</p></div> : globalResults.length ? globalResults.map((result) => (
              <button key={`${result.username}-${result.id}`} className="search-result" onClick={() => {
                const session = sessions.find((item) => item.username === result.username);
                if (session) selectSession(session);
              }}><strong>{result.chat}</strong><p><b>{result.sender}</b> {result.content}</p><time>{formatFullTime(result.timestamp)}</time></button>
            )) : <div className="empty-state"><span>⌕</span><p>输入关键词后按回车</p><small>仅检索本地只读数据</small></div>}
          </div>
        ) : view === "insights" ? (
          <div className="insight-list scroll-area">
            <div className="insight-hero"><span>⌁</span><h3>今天值得关注</h3><p>{summary.overview}</p></div>
            {[{ label: "结论", count: summary.decisions.length, tone: "decision" as const }, { label: "待办", count: summary.todos.length, tone: "todo" as const }, { label: "风险", count: summary.risks.length, tone: "risk" as const }].map((item) => <button key={item.label} className={`insight-counter ${item.tone}`} onClick={() => { navigateTo("chats"); setSignalFilter(item.tone); setRightTab("local"); }}><span>{item.label}</span><strong>{item.count}</strong><i>查看 ›</i></button>)}
          </div>
        ) : (
          <div className="session-list scroll-area">
            <div className="section-caption"><span>{view === "official" ? "公众号 / 服务号" : "好友 / 群聊"}</span><em>{activeSessionPool.length}</em></div>
            {unreadOnly && <div className="active-filter"><span>仅显示未读会话</span><button onClick={() => setUnreadOnly(false)}>清除</button></div>}
            {filteredSessions.map((session) => (
              <button key={session.username} className={`session-row ${selectedId === session.username ? "selected" : ""}`} onClick={() => selectSession(session)}>
                <AvatarView value={session.avatar} />
                <div className="session-copy"><div><strong>{session.name}</strong>{categoryOf(session) === "official" && <span className={`official-badge official-${session.officialType || "account"}`}>{officialTypeLabel(session)}</span>}<time>{formatClock(session.timestamp)}</time></div><p>{session.pinned && <span className="pin">置顶</span>}{session.lastMessage}</p></div>
                {session.unread > 0 && <span className="unread">{session.unread > 99 ? "99+" : session.unread}</span>}
              </button>
            ))}
            {!filteredSessions.length && <div className="empty-state"><span>{view === "official" ? "▤" : "✓"}</span><p>{unreadOnly ? "没有匹配的未读会话" : view === "official" ? "暂无公众号或服务号消息" : "没有匹配的聊天"}</p><small>{unreadOnly ? "可以清除筛选查看全部" : "只显示本地微信已保存的会话"}</small></div>}
            <div className="list-footer"><span className={`status-dot ${syncDot}`} />{syncLabel}<small>{activeSessionPool.length} 个{view === "official" ? "账号" : "会话"}</small></div>
          </div>
        )}
      </aside>}

      {view !== "privacy" && <section className="conversation-panel">
        <header className="conversation-header">
          <div className="conversation-title"><AvatarView value={selected.avatar} size="small" /><div><h2>{selected.name}</h2><p>{selected.isGroup ? `${selected.memberCount || "—"} 位成员 · ` : categoryOf(selected) === "official" ? `${officialTypeLabel(selected)} · ` : ""}<span className="privacy-dot" /> {liveMode ? "实时只读" : "本地只读"}</p></div></div>
          <div className="header-actions">
            <button className="date-control" title="当前会话最近日期"><span>▣</span>{formatDateLabel(selected.timestamp)}</button>
            <button className={`icon-button ${messageFilter === "media" ? "active" : ""}`} aria-label="媒体" title={messageFilter === "media" ? "显示全部消息" : "仅显示媒体与文件"} aria-pressed={messageFilter === "media"} onClick={() => setMessageFilter((value) => value === "all" ? "media" : "all")}>▧</button>
            <button className="icon-button" aria-label="生成总结" title="生成总结" onClick={generateSummary}>◎</button>
            <button className="icon-button" aria-label="会话详情" title="会话详情" onClick={openDetails}>•••</button>
          </div>
        </header>

        <div className="timeline-toolbar"><span>{messageFilter === "media" ? `媒体与文件 · 当前 ${visibleMessages.length} 条` : `已加载 ${messages.length} / 共 ${messageTotal} 条`}{hasPendingLatest && <em role="status">新消息已更新，等待查看</em>}</span><div><button onClick={() => messageHasMore ? void loadOlderMessages() : timelineRef.current?.scrollTo({ top: 0, behavior: "smooth" })}>{messageHasMore ? "加载更早" : "最早"}</button><button className={hasPendingLatest ? "pending-latest" : ""} onClick={() => hasPendingLatest ? void loadLatestMessages() : timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight, behavior: "smooth" })}>{hasPendingLatest ? "查看新消息" : "最新"}</button></div></div>
        <div className="message-timeline scroll-area" ref={timelineRef} aria-busy={conversationLoading} onScroll={(event) => { if (!conversationLoading && !suppressTimelineScrollRef.current && event.currentTarget.scrollTop < 96) void loadOlderMessages(); }}>
          {conversationLoading ? <div className="timeline-loading"><LoadingDots /><span>正在读取最新消息</span></div> : <>
            <div className="date-divider"><span>当前记录</span></div>
            {messageHasMore && <button className="older-messages" onClick={() => void loadOlderMessages()} disabled={loadingOlder}>{loadingOlder ? <><LoadingDots /> 正在读取更早消息</> : "向上滚动或点击加载更早消息"}</button>}
            {visibleMessages.map((message) => {
              const quoteServerId = String(message.meta?.quoteServerId || "");
              const quotedMessage = quoteServerId ? messagesByServerId.get(quoteServerId) : undefined;
              return <MessageCard key={String(message.id)} message={message} quotedMessage={quotedMessage} onCopy={copyText} onQuote={quoteForLlm} onPreview={setImagePreview} onTranscribe={(item) => void transcribeVoice(item)} transcribing={transcribingVoiceId === String(message.id)} onJumpOriginal={quotedMessage ? () => jumpToCitation(quotedMessage.id) : undefined} />;
            })}
            {!visibleMessages.length && <div className="empty-state"><span>▧</span><p>当前记录中没有媒体或文件</p><small>再次点击顶部媒体按钮返回全部消息</small></div>}
            <div className={`timeline-end ${hasPendingLatest ? "pending" : ""}`}><span>{hasPendingLatest ? "↓" : "✓"}</span> {hasPendingLatest ? "当前会话的新消息已更新，向下查看" : liveMode ? "已同步至最新快照" : "已到最新消息"}</div>
          </>}
        </div>
        <footer className="readonly-bar"><div><span>◉</span><strong>只读模式</strong><small>不会写入数据库，也不会代你发送消息</small></div><button onClick={() => { setRightTab("llm"); setShowLlmHistory(false); setAgentPanelOpen(true); setLlmInput("请根据当前会话上下文起草一条简洁、自然的回复，只返回草稿并引用依据。 "); window.setTimeout(() => document.getElementById("llm-input")?.focus(), 0); }}>LLM 起草回复</button></footer>
      </section>}

      {view !== "privacy" && <aside className={`agent-panel ${agentPanelOpen ? "open" : ""}`}>
        <button type="button" className="agent-panel-close" aria-label="收起 LLM 工作区" title="收起 LLM 工作区" onClick={(event) => { event.currentTarget.blur(); setAgentPanelOpen(false); }}>×</button>
        <div className="agent-tabs agent-tabs-three">
          <button className={rightTab === "llm" ? "active" : ""} onClick={() => setRightTab("llm")}><span>✦</span> LLM</button>
          <button className={rightTab === "local" ? "active" : ""} onClick={() => setRightTab("local")}><span>◎</span> 本地分析</button>
          <button className={rightTab === "heat" ? "active" : ""} onClick={() => setRightTab("heat")}><span>⌁</span> 热度</button>
        </div>

        {rightTab === "llm" ? (
          <div className="llm-content scroll-area" ref={llmThreadRef}>
            <div className="llm-model-bar">
              <div className="llm-workspace-status"><span className={`llm-live-dot ${selectedLlmModel?.availability === "ready" ? "ready" : ""}`} /><div><strong>LLM 对话</strong><small>{llmStatus.models.length ? `${llmStatus.models.length} 个本机模型可选` : "等待本机模型配置"}</small></div></div>
              <div className="llm-toolbar-actions"><button className={showLlmHistory ? "active" : ""} onClick={() => setShowLlmHistory((current) => !current)}>{showLlmHistory ? "对话" : `历史${llmStatus.history.conversationCount ? ` ${llmStatus.history.conversationCount}` : ""}`}</button><button onClick={() => setShowSettings(true)}>{llmStatus.models.length ? `${llmStatus.models.length} 个模型` : "配置"}</button></div>
            </div>
            {showLlmHistory ? (
              <section className="llm-history-view" aria-label="LLM 对话历史">
                <header><div><span>本机历史</span><strong>{llmHistoryScope === "current" ? selected.name : "全部微信会话"}</strong></div><button onClick={startNewLlmConversation}>＋ 新对话</button></header>
                <div className="llm-history-search"><span>⌕</span><input value={llmHistoryQuery} onChange={(event) => setLlmHistoryQuery(event.target.value)} placeholder="搜索问题、回答或模型" aria-label="搜索 LLM 历史" /></div>
                <div className="llm-history-scope"><button className={llmHistoryScope === "current" ? "active" : ""} onClick={() => setLlmHistoryScope("current")}>当前会话</button><button className={llmHistoryScope === "all" ? "active" : ""} onClick={() => setLlmHistoryScope("all")}>全部会话</button></div>
                {llmHistoryLoading && !llmHistories.length ? <div className="llm-history-state"><LoadingDots /><span>正在查询本机历史…</span></div> : null}
                {llmHistoryError ? <div className="llm-history-state error"><span>!</span><p>{llmHistoryError}</p><button onClick={() => void loadLlmHistory()}>重试</button></div> : null}
                {!llmHistoryLoading && !llmHistoryError && !llmHistories.length ? <div className="llm-history-state"><span>⌕</span><p>{llmHistoryQuery ? "没有匹配的历史对话" : "还没有本地 LLM 对话记录"}</p></div> : null}
                <div className="llm-history-list">
                  {llmHistories.map((history) => <button key={history.id} className="llm-history-row" onClick={() => void openLlmHistory(history.id)}><div><strong>{history.title}</strong><time>{formatFullTime(history.updatedAt)}</time></div><small>{history.sessionName} · {Math.ceil(history.turnCount / 2)} 轮</small><p>{history.preview || "打开查看完整对话"}</p><footer><span>{history.provider || "LLM"}</span><span>{history.model || "模型记录"}</span></footer></button>)}
                </div>
                <p className="llm-history-footnote">仅保存提问、回答与引用，最多 {llmStatus.history.maxConversations} 个会话；不会复制整段微信聊天。</p>
              </section>
            ) : (
              <>
                {!llmReady ? (
                  <section className="llm-setup-card">
                    <span>✦</span><h3>接入你的 LLM</h3>
                    <p>API Key 只由本地服务读取，不会进入网页。服务会从凭据文件或环境变量加载模型，只有主动提问才会发送当前群的相关消息。</p>
                    <code>~/Documents/LLMApiKey.rtf</code>
                    <button onClick={() => setShowSettings(true)}>查看本地配置方式</button>
                  </section>
                ) : (
                  <>
                    {!llmTurns.length && <section className="llm-welcome"><span>✦</span><h3>询问这段群聊</h3><p>我会在本机选择相关原文，再交给 {selectedLlmModel?.name} 分析。涉及群聊事实的回答必须附带可点击引用。</p></section>}
                    <section className="llm-quick-actions">
                      <div className="signal-title"><span>快捷任务</span><small>{llmTurns.length ? <button className="llm-new-thread" onClick={startNewLlmConversation}>＋ 新对话</button> : "像 Codex 一样工作"}</small></div>
                      <div>
                        {["总结讨论并列出明确结论", "提取待办、负责人和截止时间", "找出分歧、风险和待确认事项", "根据最新讨论起草一条回复"].map((prompt, index) => <button key={prompt} onClick={() => askLlm(prompt)}><i>{["总", "办", "险", "稿"][index]}</i>{prompt}</button>)}
                      </div>
                    </section>
                  </>
                )}

                <div className="llm-thread">
                  {llmTurns.map((turn) => <article key={turn.id} className={`llm-turn ${turn.role} ${turn.error ? "error" : ""}`}>
                    <div className="llm-turn-meta"><span>{turn.role === "user" ? "你" : "✦ LLM"}</span>{turn.role === "assistant" && <button onClick={() => copyText(turn.content)}>复制</button>}</div>
                    {turn.role === "assistant" && !turn.error ? <LlmReadableContent content={turn.content} citations={turn.citations} onCitation={jumpToCitation} /> : <p>{turn.content}</p>}
                    {turn.citations && turn.citations.length > 0 && <div className="llm-citations">{turn.citations.map((citation) => <button key={`${turn.id}-${citation.id}`} onClick={() => jumpToCitation(citation.id)}><b>{citation.label || "原文"}</b><span>{citation.sender}</span></button>)}</div>}
                    {turn.role === "assistant" && !turn.error && <footer><span>{turn.model}</span><span>{turn.contextMessages} 条上下文</span>{turn.usage?.totalTokens ? <span>{turn.usage.totalTokens} tokens</span> : null}</footer>}
                  </article>)}
                  {llmLoading && <article className="llm-turn assistant pending"><div className="llm-turn-meta"><span>✦ LLM</span></div><p><LoadingDots /> 正在阅读群聊并组织引用…</p></article>}
                </div>
              </>
            )}
          </div>
        ) : rightTab === "local" ? (
          <>
          <div className="period-switch">{(["天", "周", "月", "季", "年"] as AnalysisPeriod[]).map((item) => <button key={item} className={period === item ? "active" : ""} disabled={analysisLoading} onClick={() => void changeAnalysisPeriod(item)}>{item}</button>)}</div>
          <div className="agent-content scroll-area">
            <div className="agent-status"><div><span className="local-spark">✦</span><div><strong>当前会话 · {analysisPeriodLabel(period)}</strong><small>{analysisLoading ? "正在重新统计…" : "规则统计与可回溯信号"}</small></div></div><span className="privacy-pill">不调用云模型</span></div>
            <section className="local-purpose"><div><span>⌁</span><strong>本地分析能做什么？</strong></div><p>只在这台电脑上统计所选时段的消息、成员和内容类型，并按规则提取结论、待办、风险与主题词。结果可点击回到原文；它适合快速浏览，不等同于 LLM 的语义分析。</p></section>
            <section className="summary-card">
              <div className="summary-heading"><p>{analysisPeriodLabel(period)}摘要</p><button onClick={generateSummary} disabled={loading || analysisLoading}>{loading || analysisLoading ? <LoadingDots /> : "↻"}</button></div>
              <h3>{summary.title}</h3><p>{summary.overview}</p>
              <div className="metric-grid"><div><strong>{summary.metrics.messages}</strong><span>消息</span></div><div><strong>{summary.metrics.participants}</strong><span>成员</span></div><div><strong>{summary.metrics.links}</strong><span>链接</span></div><div><strong>{summary.metrics.files}</strong><span>资料</span></div></div>
            </section>

            <section className="signal-section">
              <div className="signal-title"><span>关键信号</span><small>{filteredSignalItems.length} 条 · 点击回到原文</small></div>
              <div className="signal-tabs" role="group" aria-label="筛选关键信号">
                {[
                  { key: "all" as const, label: "全部", count: signalItems.length },
                  { key: "decision" as const, label: "结论", count: summary.decisions.length },
                  { key: "todo" as const, label: "待办", count: summary.todos.length },
                  { key: "risk" as const, label: "风险", count: summary.risks.length },
                ].map((item) => <button key={item.key} className={`${item.key} ${signalFilter === item.key ? "active" : ""}`} aria-pressed={signalFilter === item.key} onClick={() => setSignalFilter(item.key)}>{item.label} {item.count}</button>)}
              </div>
              {filteredSignalItems.slice(0, signalFilter === "all" ? 8 : 16).map((item) => <button key={`${item.kind}-${item.id}`} className="signal-row" onClick={() => jumpToCitation(item.id)}><i className={item.tone}>{item.kind}</i><div><strong>{item.sender}</strong><p>{item.content}</p><time>{formatFullTime(item.timestamp)}</time></div></button>)}
              {!filteredSignalItems.length ? <div className="signal-empty">{analysisPeriodLabel(period)}没有识别到这类信号</div> : null}
            </section>

            {agentAnswer && <section className="answer-card"><div><span>✦</span><strong>Agent 回答</strong><button onClick={() => copyText(agentAnswer.answer)}>复制</button></div><p>{agentAnswer.answer}</p>{agentAnswer.citations.length > 0 && <div className="answer-sources">{agentAnswer.citations.map((item, index) => <button key={String(item.id)} onClick={() => jumpToCitation(item.id)}>{index + 1} · {item.sender}</button>)}</div>}</section>}

            <section className="keyword-section"><div className="signal-title"><span>主题词</span><small>本地提取</small></div><div className="keyword-cloud">{summary.keywords.map((item) => <button key={item.name} onClick={() => { setQuery(item.name); runSearch(item.name); }}>{item.name}<sup>{item.count}</sup></button>)}</div></section>
          </div>
          </>
        ) : (
          <>
          <div className="heat-content scroll-area">
            <section className="month-heatmap" aria-label="月度聊天热力图">
              <header className="heatmap-heading"><div><p>月度聊天热力图</p><strong>{monthLabel(heatMonth)}</strong></div><button onClick={() => setHeatRefresh((value) => value + 1)} disabled={heatLoading} aria-label="刷新月度统计">{heatLoading ? <LoadingDots /> : "↻"}</button></header>
              <div className="heat-month-nav"><button onClick={() => setHeatMonth((value) => shiftMonth(value, -1))} aria-label="上个月">‹</button><span>{heatmap?.scopeName || (heatScope === "all" ? "全部聊天（含折叠）" : selected.name)}</span><button onClick={() => setHeatMonth((value) => shiftMonth(value, 1))} aria-label="下个月">›</button></div>
              <div className="heat-scope"><button className={heatScope === "all" ? "active" : ""} onClick={() => setHeatScope("all")}>全部聊天</button><button className={heatScope === "current" ? "active" : ""} onClick={() => setHeatScope("current")}>当前会话</button></div>
              {heatError ? <div className="heat-state error"><span>!</span><p>{heatError}</p><button onClick={() => setHeatRefresh((value) => value + 1)}>重试</button></div> : null}
              {!heatError && !heatmap && heatLoading ? <div className="heat-state"><LoadingDots /><span>正在统计真实消息…</span></div> : null}
              {heatmap ? <>
                <div className={`heatmap-body ${heatLoading ? "refreshing" : ""}`}>
                  <div className="heat-weekdays">{["一", "二", "三", "四", "五", "六", "日"].map((day) => <span key={day}>{day}</span>)}</div>
                  <div className="heat-grid">{heatCalendarCells.map((day, index) => day ? <button key={day.date} className={`heat-cell heat-level-${day.count && heatmap.max ? Math.max(1, Math.ceil(Math.log(day.count + 1) / Math.log(heatmap.max + 1) * 4)) : 0} ${selectedHeatDate === day.date ? "selected" : ""}`} onClick={() => setSelectedHeatDate(day.date)} title={`${heatDateLabel(day.date)}：${day.count.toLocaleString("zh-CN")} 条消息`} aria-label={`${heatDateLabel(day.date)}，${day.count} 条消息`} aria-pressed={selectedHeatDate === day.date}><span>{Number(day.date.slice(-2))}</span>{day.count > 0 && <small>{day.count > 999 ? `${(day.count / 1000).toFixed(1)}k` : day.count}</small>}</button> : <span className="heat-cell empty" key={`empty-${index}`} />)}</div>
                  <div className="heat-legend"><span>较少</span>{[0, 1, 2, 3, 4].map((level) => <i className={`heat-level-${level}`} key={level} />)}<span>较多</span></div>
                </div>
                <div className="heat-metrics"><div><strong>{heatmap.total.toLocaleString("zh-CN")}</strong><span>本月消息</span></div><div><strong>{heatmap.activeDays}</strong><span>活跃天数</span></div><div><strong>{Math.round(heatmap.total / Math.max(heatmap.days.length, 1)).toLocaleString("zh-CN")}</strong><span>日均消息</span></div></div>
                {selectedHeatDay && <button className="heat-day-detail" title="所选日期的聊天总数"><span><b>{heatDateLabel(selectedHeatDay.date)}</b><small>{heatScope === "all" ? "全部聊天的单日总数（含折叠群）" : `“${selected.name}”的单日总数`}</small></span><strong>{selectedHeatDay.count.toLocaleString("zh-CN")}<small>条</small></strong></button>}
                {heatmap.peakDay && <p className="heat-peak">本月峰值：{heatDateLabel(heatmap.peakDay.date)} · {heatmap.peakDay.count.toLocaleString("zh-CN")} 条</p>}
              </> : null}
            </section>
            <section className="speaker-section">
              <div className="signal-title"><span>当前会话活跃成员</span><small>{summary.topSpeakers.length} 人</small></div>
              {summary.topSpeakers.slice(0, 5).map((speaker, index) => <SpeakerRow speaker={speaker} index={index} maximum={speakerMax} key={speaker.senderId || speaker.name} />)}
              {summary.topSpeakers.length > 5 ? <details className="speaker-more"><summary>展开其余 {summary.topSpeakers.length - 5} 位成员</summary><div>{summary.topSpeakers.slice(5).map((speaker, index) => <SpeakerRow speaker={speaker} index={index + 5} maximum={speakerMax} key={speaker.senderId || speaker.name} />)}</div></details> : null}
              {!summary.topSpeakers.length ? <p className="speaker-empty">当前记录中没有成员消息</p> : null}
            </section>
            <section className="type-breakdown"><div className="signal-title"><span>内容构成</span><small>按消息类型</small></div><div className="donut" style={{ background: "conic-gradient(#bd673d 0 62%, #e5a65f 62% 76%, #617e89 76% 89%, #d6c1a9 89% 100%)" }}><span>{Math.round((summary.metrics.messages - summary.metrics.files - summary.metrics.links) / Math.max(summary.metrics.messages, 1) * 100)}%<small>文字</small></span></div><div className="legend"><span><i className="text" />文字</span><span><i className="link" />链接</span><span><i className="file" />文件</span><span><i className="other" />其他</span></div></section>
          </div>
          </>
        )}

        {rightTab === "llm" && !showLlmHistory && <div className="agent-composer llm-composer">
          <div className="llm-composer-context"><div><span>{llmConversationId ? "当前历史会话" : "当前上下文"}</span><strong>{selected.name}</strong></div><small>{quotedMessages.length ? `${quotedMessages.length} 条手动引用` : `自动选择最多 ${llmStatus.contextLimit} 条相关消息`}</small></div>
          {quotedMessages.length > 0 && <div className="quoted-context"><div><span>已引用 {quotedMessages.length} 条原文</span><button onClick={() => setQuotedMessages([])}>清空</button></div>{quotedMessages.map((message) => <button key={String(message.id)} onClick={() => setQuotedMessages((current) => current.filter((item) => String(item.id) !== String(message.id)))}><b>{message.sender}</b><span>{message.content}</span><i>×</i></button>)}</div>}
          <div className="llm-input-body"><label htmlFor="llm-input">针对当前会话提问</label><textarea id="llm-input" value={llmInput} disabled={!llmReady} onChange={(event) => setLlmInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); askLlm(); } }} placeholder={llmReady ? "询问结论、待办、风险，或让 LLM 起草回复…" : "请先加载并选择一个模型"} /></div>
          <div className="llm-composer-footer"><div className="llm-inline-model"><span className={`llm-live-dot ${selectedLlmModel?.availability === "ready" ? "ready" : ""}`} /><select id="llm-model" aria-label="对话模型" value={selectedLlmModel?.id || ""} disabled={!llmStatus.models.length || llmLoading} onChange={(event) => setSelectedLlmModelId(event.target.value)}>{llmStatus.models.length ? llmStatus.models.map((model) => <option key={model.id} value={model.id}>{model.availability === "ready" ? "✓ " : model.availability === "unavailable" ? "⚠ " : ""}{model.provider} · {model.name}</option>) : <option value="">未检测到可用模型</option>}</select></div><span title={selectedLlmModel?.model || ""}>{llmReady ? "↵ 发送" : "模型未就绪"}</span><button onClick={() => askLlm()} disabled={llmLoading || !llmInput.trim() || !llmReady} aria-label="发送给 LLM">↑</button></div>
        </div>}

        {rightTab === "local" && <div className="agent-composer">
          <label htmlFor="agent-input">就这个时段的记录提问</label>
          <textarea id="agent-input" value={agentInput} onChange={(event) => setAgentInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); askAgent(); } }} placeholder="例如：谁负责兼容迁移？" />
          <div><span>↵ 发送 · ⇧↵ 换行</span><button onClick={() => askAgent()} disabled={loading || !agentInput.trim()} aria-label="发送问题">↑</button></div>
        </div>}
      </aside>}

      {imagePreview && <ImageLightbox preview={imagePreview} onClose={() => setImagePreview(null)} />}

      {showContactDetails && contactDetail && <div className="modal-backdrop" onClick={() => setShowContactDetails(false)}>
        <aside className="details-drawer contact-details-drawer scroll-area" aria-label="联系人详情" onClick={(event) => event.stopPropagation()}>
          <header><div><p className="eyebrow">{contactDetail.kind === "group" ? "GROUP PROFILE" : "CONTACT PROFILE"}</p><h2>{contactDetail.kind === "group" ? "群聊详情" : "联系人详情"}</h2></div><button onClick={() => setShowContactDetails(false)} aria-label="关闭联系人详情">×</button></header>
          <div className="detail-profile"><AvatarView value={contactDetail.avatar} size="large" /><strong>{contactDetail.name}</strong><span>{contactDetail.kind === "group" ? `${contactDetail.memberCount || contactMembers.length || "—"} 位成员` : contactDetail.remark ? "已设置备注" : "微信联系人"}</span></div>
          {contactDetailLoading ? <div className="contact-detail-loading"><LoadingDots /><span>正在读取本地联系人资料</span></div> : <>
            <dl className="contact-facts">
              {contactDetail.remark && <div><dt>备注</dt><dd>{contactDetail.remark}</dd></div>}
              <div><dt>{contactDetail.kind === "group" ? "群聊名称" : "微信昵称"}</dt><dd>{contactDetail.nickName || contactDetail.name}</dd></div>
              {contactDetail.kind !== "group" && <div><dt>微信号 / 别名</dt><dd>{contactDetail.alias || "未设置"}</dd></div>}
              <div><dt>本地账号 ID</dt><dd className="mono">{contactDetail.username}</dd></div>
              {contactDetail.description && <div><dt>简介</dt><dd>{contactDetail.description}</dd></div>}
              {contactSession && <div><dt>最近会话</dt><dd>{formatFullTime(contactSession.timestamp)} · {contactSession.lastMessage || "暂无摘要"}</dd></div>}
            </dl>
            {contactDetail.kind === "group" && <section><h3>群成员</h3><div className="member-list">{contactMembers.length ? contactMembers.slice(0, 24).map((member) => <div key={member.username}><AvatarView value={member.avatar} size="small" /><span><strong>{member.name}</strong><small>{member.role === "owner" || member.role === "群主" ? "群主" : member.remark || member.username}</small></span></div>) : <p>本地联系人库暂未保存成员明细。</p>}</div>{contactMembers.length > 24 && <p>另有 {contactMembers.length - 24} 位成员未展开</p>}</section>}
            <section className="contact-detail-actions"><h3>快捷操作</h3>{contactSession ? <button className="primary" onClick={openContactConversation}>打开只读聊天</button> : <p>这个联系人当前没有保留在本机会话列表中。</p>}<button onClick={() => copyText(contactDetail.username)}>复制账号 ID</button></section>
          </>}
        </aside>
      </div>}

      {showDetails && <div className="modal-backdrop" onClick={() => setShowDetails(false)}><aside className="details-drawer scroll-area" onClick={(event) => event.stopPropagation()}><header><div><p className="eyebrow">会话详情</p><h2>{selected.name}</h2></div><button onClick={() => setShowDetails(false)}>×</button></header><div className="detail-profile"><AvatarView value={selected.avatar} size="large" /><strong>{selected.name}</strong><span>{selected.username}</span></div><div className="detail-grid"><div><span>消息</span><strong>{summary.metrics.messages}</strong></div><div><span>成员</span><strong>{selected.memberCount || groupMembers.length || summary.metrics.participants}</strong></div></div>{selected.isGroup && <section><h3>群成员</h3><div className="member-list">{groupMembers.length ? groupMembers.slice(0, 18).map((member) => <div key={member.username}><AvatarView value={member.avatar} size="small" /><span><strong>{member.name}</strong><small>{member.role === "owner" || member.role === "群主" ? "群主" : member.role || member.remark || member.username}</small></span></div>) : <p>真实快照接入后，将从联系人库只读加载群成员。</p>}</div>{groupMembers.length > 18 && <p>另有 {groupMembers.length - 18} 位成员未展开</p>}</section>}<section><h3>数据边界</h3><p>当前页面仅查询本地只读快照。没有发送消息、修改联系人或写入微信数据库的接口。</p></section><section><h3>快捷操作</h3><button onClick={() => copyText(selected.username)}>复制会话 ID</button><button onClick={generateSummary}>重新生成摘要</button><button onClick={() => exportConversation("markdown")}>导出当前会话为 Markdown</button><button onClick={() => exportConversation("json")}>导出当前会话为 JSON</button></section></aside></div>}

      {showSettings && <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
        <aside className="settings-modal scroll-area" onClick={(event) => event.stopPropagation()}>
          <header><div><p className="eyebrow">SETTINGS</p><h2>本地数据与隐私</h2></div><button onClick={() => setShowSettings(false)}>×</button></header>
          <div className="safety-banner"><span>✓</span><div><strong>只读保护已启用</strong><p>凭据仅由本机服务读取；实时同步只读取微信数据库，不包含消息发送或数据库写入能力。</p></div></div>
          <div className="setting-row"><div><strong>数据来源</strong><span>{liveMode ? `微信实时只读快照 · ${syncLabel}` : service.source === "local-snapshot" ? "已解密的本地快照" : "安全演示数据"}</span></div><em className={service.ok ? "ok" : "warn"}>{liveMode ? (sync.state === "live" ? "实时" : "同步中") : service.ok ? "已连接" : "演示"}</em></div>
          <div className="setting-row"><div><strong>网络范围</strong><span>服务仅监听 127.0.0.1</span></div><em className="ok">本机</em></div>
          <div className="setting-row"><div><strong>LLM 模型目录</strong><span>{llmStatus.configured ? `${llmStatus.credentialSource} · ${llmStatus.models.length} 个可选模型` : "尚未检测到可用凭据"}</span></div><em className={llmStatus.configured ? "ok" : "warn"}>{llmStatus.configured ? "已加载" : "关闭"}</em></div>
          <section className="setup-note"><h3>当前模型</h3><p>{selectedLlmModel ? `${selectedLlmModel.provider} · ${selectedLlmModel.name}（${selectedLlmModel.model}）` : "未选择模型"}</p><p>模型切换只改变下一次请求的提供方和模型，不会把 API Key 返回网页。模型权益在首次请求时由对应提供方校验。</p></section>
          {llmStatus.warnings.length > 0 && <section className="setup-note setup-warning"><h3>安全提醒</h3>{llmStatus.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
          <section className="setup-note"><h3>凭据与历史</h3><p>默认只在内存中读取 <code>~/Documents/LLMApiKey.rtf</code>。也可用 <code>WEIXIN_LLM_KEY_FILE</code> 指定其他文件，或继续通过 <code>.env</code> 配置单一 Responses API 模型。</p><p>提问、回答、引用和模型元数据保存在 <code>{llmStatus.history.location}</code>，不会保存 API Key 或整段微信群聊。Responses API 请求固定 <code>store: false</code>。</p></section>
          <section className="setup-note"><h3>实时同步</h3><p>后台只读监测微信数据库变化，验证 SQLite 完整性后原子切换本地快照。网页不会直接打开微信正在写入的文件。</p></section>
        </aside>
      </div>}
      {toast && <div className="toast" role="status">✓ {toast}</div>}
    </main>
  );
}
