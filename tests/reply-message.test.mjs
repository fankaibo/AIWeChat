import assert from "node:assert/strict";
import test from "node:test";

import { displayContent, parseAppMessage, parseReplyMessage, splitMessagePayload } from "../local/readonly-store.mjs";

function replyXml({ title, type, sender, senderId, content, serverId, createTime, msgsource = "" }) {
  return `<?xml version="1.0"?><msg><appmsg><title><![CDATA[${title}]]></title><type>57</type><refermsg><type>${type}</type><svrid>${serverId}</svrid><fromusr>${senderId}</fromusr><chatusr>${senderId}</chatusr><displayname><![CDATA[${sender}]]></displayname><content><![CDATA[${content}]]></content><createtime>${createTime}</createtime><msgsource><![CDATA[${msgsource}]]></msgsource></refermsg></appmsg></msg>`;
}

test("parses the real content and identity from a text reply", () => {
  const parsed = parseReplyMessage(replyXml({
    title: "这是我的回复",
    type: 1,
    sender: "王子亨",
    senderId: "wxid_author",
    content: "这才是被引用的原文",
    serverId: "1177879567272530013",
    createTime: 1786003304,
  }));

  assert.deepEqual(parsed, {
    content: "这是我的回复",
    meta: {
      quote: "这才是被引用的原文",
      quoteSender: "王子亨",
      quoteSenderId: "wxid_author",
      quoteType: "text",
      quoteTypeLabel: "文字",
      quoteFilename: "",
      quoteTimestamp: 1786003304000,
      quoteServerId: "1177879567272530013",
    },
  });
});

test("identifies an image reply and restores its original filename", () => {
  const parsed = parseReplyMessage(replyXml({
    title: "请留意这个修改",
    type: 3,
    sender: "冰城晨露 Eric",
    senderId: "wxid_eric",
    content: "wxid_eric:\n&lt;msg&gt;&lt;img /&gt;&lt;/msg&gt;",
    serverId: "5401756725530469200",
    createTime: 1786004705,
    msgsource: "&lt;msgsource&gt;&lt;img_file_name&gt;19d026d0-4a02-419f-9fc0-0bec42f920e6.png&lt;/img_file_name&gt;&lt;/msgsource&gt;",
  }));

  assert.equal(parsed?.meta.quote, "图片 · 19d026d0-4a02-419f-9fc0-0bec42f920e6.png");
  assert.equal(parsed?.meta.quoteSender, "冰城晨露 Eric");
  assert.equal(parsed?.meta.quoteType, "image");
  assert.equal(parsed?.meta.quoteServerId, "5401756725530469200");
});

test("splits only the outer group sender prefix", () => {
  const payload = "wxid_outer:\n<appmsg><refermsg><content>wxid_inner:\n原消息</content></refermsg></appmsg>";
  assert.deepEqual(splitMessagePayload(payload, true), {
    prefixedSender: "wxid_outer",
    rawMessage: "<appmsg><refermsg><content>wxid_inner:\n原消息</content></refermsg></appmsg>",
  });
  assert.deepEqual(splitMessagePayload("<appmsg><content>wxid_inner:\n原消息</content></appmsg>", true), {
    prefixedSender: "",
    rawMessage: "<appmsg><content>wxid_inner:\n原消息</content></appmsg>",
  });
  assert.deepEqual(splitMessagePayload("标题:\n正文", false), { prefixedSender: "", rawMessage: "标题:\n正文" });
});

test("does not mistake a nested null title for an empty chat-record title", () => {
  const parsed = parseAppMessage(`<msg><appmsg><title /><des>[图片]\n[图片]...</des><type>24</type><url>https://support.weixin.qq.com/upgrade</url><recorditem>&lt;datalist count="14"&gt;&lt;/datalist&gt;</recorditem><emotionpageshared><title>null</title><desc>null</desc></emotionpageshared></appmsg></msg>`);
  assert.deepEqual(parsed, {
    content: "聊天记录",
    appType: 24,
    meta: {
      appType: 24,
      cardType: "record",
      cardTypeLabel: "聊天记录",
      description: "[图片]\n[图片]...",
      itemCount: 14,
    },
  });
});

test("parses title, description, URL and thumbnail from a regular link", () => {
  const parsed = parseAppMessage(`<msg><appmsg><title><![CDATA[Agent 设计笔记]]></title><des><![CDATA[工具调用与恢复执行]]></des><type>5</type><url><![CDATA[https://example.com/article]]></url><thumburl><![CDATA[https://example.com/cover.jpg]]></thumburl></appmsg></msg>`);
  assert.equal(parsed?.content, "Agent 设计笔记");
  assert.equal(parsed?.meta.description, "工具调用与恢复执行");
  assert.equal(parsed?.meta.url, "https://example.com/article");
  assert.equal(parsed?.meta.thumbnailUrl, "https://example.com/cover.jpg");
});

test("preserves text line breaks and intentional indentation", () => {
  const source = "课程分享\r\n\r\n  舟夜书所见\r\n      清·查慎行\r\n月黑见渔灯";
  assert.equal(displayContent(source, "text"), "课程分享\n\n  舟夜书所见\n      清·查慎行\n月黑见渔灯");
});
