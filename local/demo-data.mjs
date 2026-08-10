const now = Date.now();
const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;

const avatar = (label, tone = "apricot") => ({ label, tone });

export const demoSessions = [
  { username: "ai-lab@chatroom", name: "AI 技术交流群", avatar: avatar("AI", "blue"), lastMessage: "本周 Agent 评测结论已经整理好了", timestamp: now - 3 * minute, unread: 8, pinned: true, isGroup: true, memberCount: 111, category: "chat" },
  { username: "product-room@chatroom", name: "产品与设计协作", avatar: avatar("产", "purple"), lastMessage: "交互稿今晚可以合并", timestamp: now - 18 * minute, unread: 3, pinned: true, isGroup: true, memberCount: 38, category: "chat" },
  { username: "wxid_lin", name: "林然", avatar: avatar("林", "green"), lastMessage: "明天下午三点可以", timestamp: now - 52 * minute, unread: 1, pinned: false, isGroup: false, category: "chat" },
  { username: "gh_agentos_daily", name: "AgentOS 日报", avatar: avatar("报", "orange"), lastMessage: "今天的 Agent 行业动态已更新", timestamp: now - 70 * minute, unread: 2, pinned: false, isGroup: false, category: "official", officialType: "account" },
  { username: "infra@chatroom", name: "基础设施讨论组", avatar: avatar("基", "orange"), lastMessage: "延迟已经恢复到正常范围", timestamp: now - 2 * hour, unread: 0, pinned: false, isGroup: true, memberCount: 24, category: "chat" },
  { username: "reading@chatroom", name: "论文与研究", avatar: avatar("研", "rose"), lastMessage: "分享了一篇关于长上下文的新论文", timestamp: now - 5 * hour, unread: 12, pinned: false, isGroup: true, memberCount: 76, category: "chat" },
  { username: "wxid_mori", name: "Mori", avatar: avatar("M", "teal"), lastMessage: "文件已发送", timestamp: now - day, unread: 0, pinned: false, isGroup: false, category: "chat" },
  { username: "family@chatroom", name: "家人", avatar: avatar("家", "red"), lastMessage: "周末见", timestamp: now - 2 * day, unread: 0, pinned: false, isGroup: true, memberCount: 6, category: "chat" },
  { username: "filehelper", name: "文件传输助手", avatar: avatar("文", "gray"), lastMessage: "research-notes.pdf", timestamp: now - 3 * day, unread: 0, pinned: false, isGroup: false, category: "chat" },
  { username: "makers@chatroom", name: "独立开发者", avatar: avatar("造", "indigo"), lastMessage: "第一版已经上线", timestamp: now - 4 * day, unread: 22, pinned: false, isGroup: true, memberCount: 208, category: "chat" },
];

export const demoContacts = [
  { username: "wxid_lin", name: "林然", remark: "产品 林然", avatar: avatar("林", "green"), kind: "contact" },
  { username: "wxid_mori", name: "Mori", remark: "", avatar: avatar("M", "teal"), kind: "contact" },
  { username: "wxid_chen", name: "陈川", remark: "基础设施 陈川", avatar: avatar("陈", "blue"), kind: "contact" },
  { username: "wxid_ye", name: "叶子", remark: "设计 叶子", avatar: avatar("叶", "purple"), kind: "contact" },
  ...demoSessions.filter((s) => s.isGroup).map((s) => ({ username: s.username, name: s.name, remark: "", avatar: s.avatar, kind: "group", memberCount: s.memberCount })),
];

export const demoMessages = {
  "ai-lab@chatroom": [
    { id: 1, sender: "周屿", senderId: "wxid_zhou", avatar: avatar("周", "orange"), timestamp: now - 7 * hour, type: "text", content: "今天把 Agent 的评测结果过一遍，重点看工具调用稳定性和长任务恢复。" },
    { id: 2, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: now - 6.8 * hour, type: "link", content: "Agent Harness 设计笔记", meta: { url: "https://example.com/agent-harness", description: "从任务规划、工具调用到可恢复执行的一套工程化思路" } },
    { id: 3, sender: "陈川", senderId: "wxid_chen", avatar: avatar("陈", "blue"), timestamp: now - 6.3 * hour, type: "text", content: "线上观察到两个问题：并行工具超过 6 个后偶发超时；长任务在网络切换时会丢失最后一个检查点。" },
    { id: 4, sender: "我", senderId: "me", avatar: avatar("我", "dark"), timestamp: now - 6.1 * hour, type: "text", content: "先把并发上限收紧到 4，检查点改为每个工具返回后落盘。今天出一个小版本验证。", isMine: true },
    { id: 5, sender: "叶子", senderId: "wxid_ye", avatar: avatar("叶", "purple"), timestamp: now - 5.5 * hour, type: "image", content: "评测看板截图", meta: { width: 920, height: 520, status: "demo" } },
    { id: 6, sender: "周屿", senderId: "wxid_zhou", avatar: avatar("周", "orange"), timestamp: now - 4.9 * hour, type: "file", content: "agent-eval-2026-08.xlsx", meta: { size: "1.8 MB", ext: "XLSX" } },
    { id: 7, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: now - 3.6 * hour, type: "quote", content: "同意。先解决恢复一致性，复杂的自动重试放到下一轮。", meta: { quoteSender: "我", quote: "今天出一个小版本验证。" } },
    { id: 8, sender: "陈川", senderId: "wxid_chen", avatar: avatar("陈", "blue"), timestamp: now - 2.2 * hour, type: "text", content: "补充风险：旧任务记录里没有 schema_version，迁移时需要做兼容读取。负责人我，截止周四。" },
    { id: 9, sender: "周屿", senderId: "wxid_zhou", avatar: avatar("周", "orange"), timestamp: now - 73 * minute, type: "voice", content: "语音消息", meta: { duration: "0:18" } },
    { id: 10, sender: "我", senderId: "me", avatar: avatar("我", "dark"), timestamp: now - 37 * minute, type: "text", content: "结论：并发上限先设为 4；陈川负责兼容迁移；我负责恢复检查点，周四一起回归。", isMine: true },
    { id: 11, sender: "系统", senderId: "system", timestamp: now - 22 * minute, type: "system", content: "“周屿”修改了群公告" },
    { id: 12, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: now - 3 * minute, type: "text", content: "本周 Agent 评测结论已经整理好了，晚点补充到文档。" },
  ],
  "product-room@chatroom": [
    { id: 20, sender: "叶子", senderId: "wxid_ye", avatar: avatar("叶", "purple"), timestamp: now - 2 * hour, type: "text", content: "三栏布局已经调整，右侧分析面板默认保留 360px。" },
    { id: 21, sender: "我", senderId: "me", avatar: avatar("我", "dark"), timestamp: now - 90 * minute, type: "text", content: "可以，窄屏时先收起右侧面板。", isMine: true },
    { id: 22, sender: "叶子", senderId: "wxid_ye", avatar: avatar("叶", "purple"), timestamp: now - 18 * minute, type: "file", content: "agentos-interaction-v1.fig", meta: { size: "6.4 MB", ext: "FIG" } },
  ],
  "wxid_lin": [
    { id: 30, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: now - 2 * hour, type: "text", content: "我们找个时间把本周规划对齐一下？" },
    { id: 31, sender: "我", senderId: "me", avatar: avatar("我", "dark"), timestamp: now - 95 * minute, type: "text", content: "可以，明天下午方便吗？", isMine: true },
    { id: 32, sender: "林然", senderId: "wxid_lin", avatar: avatar("林", "green"), timestamp: now - 52 * minute, type: "text", content: "明天下午三点可以。" },
  ],
};

export function messagesFor(username) {
  return demoMessages[username] || [
    { id: Math.abs(username.split("").reduce((a, c) => a + c.charCodeAt(0), 0)), sender: "系统", senderId: "system", timestamp: now - day, type: "system", content: "演示数据中暂无更多消息" },
  ];
}

export const demoMembers = [
  { username: "me", name: "我", role: "成员", avatar: avatar("我", "dark") },
  { username: "wxid_zhou", name: "周屿", role: "群主", avatar: avatar("周", "orange") },
  { username: "wxid_lin", name: "林然", role: "管理员", avatar: avatar("林", "green") },
  { username: "wxid_chen", name: "陈川", role: "成员", avatar: avatar("陈", "blue") },
  { username: "wxid_ye", name: "叶子", role: "成员", avatar: avatar("叶", "purple") },
];
