// 发布新版本到 GitHub Releases（先 npm run tauri:build）。
//   node scripts/release.mjs            只生成 latest.json，打印要上传的文件
//   node scripts/release.mjs --publish  用 gh 创建 vX.Y.Z 版本并上传安装包 + latest.json
// 更新说明写在 release-notes/vX.Y.Z.md（没有就用一句默认说明）。
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
const version = conf.version;
const tag = `v${version}`;
const repo = conf.plugins?.updater?.endpoints?.[0]?.match(/github\.com\/([^/]+\/[^/]+)\//)?.[1];
if (!repo) throw new Error("tauri.conf.json 里没有 GitHub 更新地址");

const bundleDir = path.join(root, "src-tauri", "target", "release", "bundle", "nsis");
const installer = `${conf.productName}_${version}_x64-setup.exe`;
const installerPath = path.join(bundleDir, installer);
const sigPath = `${installerPath}.sig`;
for (const file of [installerPath, sigPath]) {
  if (!fs.existsSync(file)) throw new Error(`找不到 ${file}，先运行 npm run tauri:build（需要本机有签名私钥）`);
}

const notesFile = path.join(root, "release-notes", `${tag}.md`);
const notes = fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8").trim() : `Paw ${tag}`;

// GitHub 会把文件名里的空格换成点，这里保持和上传后的名字一致
const assetName = installer.replace(/ /g, ".");
const latest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    "windows-x86_64": {
      signature: fs.readFileSync(sigPath, "utf8").trim(),
      url: `https://github.com/${repo}/releases/download/${tag}/${assetName}`,
    },
  },
};
const latestPath = path.join(bundleDir, "latest.json");
fs.writeFileSync(latestPath, JSON.stringify(latest, null, 2));
console.log(`已生成 ${latestPath}`);
console.log(`版本 ${tag} → ${repo}`);
console.log(`上传：\n  ${installerPath}\n  ${latestPath}`);

if (process.argv.includes("--publish")) {
  const args = ["release", "create", tag, installerPath, latestPath, "--repo", repo, "--title", `Paw ${tag}`];
  if (fs.existsSync(notesFile)) args.push("--notes-file", notesFile);
  else args.push("--notes", notes);
  execFileSync("gh", args, { stdio: "inherit" });
  console.log("发布完成");
}
