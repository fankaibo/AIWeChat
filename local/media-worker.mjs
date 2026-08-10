import { convertWxgfToJpeg, WechatMediaResolver } from "./wechat-media.mjs";

const [accountRoot, username, token, variant = "thumbnail"] = process.argv.slice(2);
if (!accountRoot || !username || !/^[a-f0-9]{32}$/.test(token || "")) process.exit(2);

try {
  let image = new WechatMediaResolver(accountRoot).image(username, token, variant === "full" ? "full" : "thumbnail");
  if (!image?.bytes) process.exit(3);
  if (image.format === "hevc") image = convertWxgfToJpeg(image.bytes);
  process.stdout.write(image.bytes);
} catch {
  process.exit(4);
}
