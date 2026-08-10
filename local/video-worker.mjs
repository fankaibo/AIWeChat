import { WechatMediaResolver } from "./wechat-media.mjs";

const [accountRoot, createTimeValue, thumbnailBytesValue] = process.argv.slice(2);
const createTime = Number(createTimeValue || 0);
const thumbnailBytes = Number(thumbnailBytesValue || 0);

if (!accountRoot || !Number.isFinite(createTime) || createTime <= 0) process.exit(2);

try {
  const asset = new WechatMediaResolver(accountRoot).video({ createTime, thumbnailBytes });
  if (!asset?.posterPath) process.exit(3);
  process.stdout.write(JSON.stringify(asset));
} catch {
  process.exit(4);
}
