#!/usr/bin/env node
/**
 * dsh-workspace-tools 安装脚本
 *
 * 用法：
 *   node install.mjs              装到默认 profile "web"
 *   node install.mjs myprofile    装到指定 profile
 *
 * 做的事：
 *   1. 把插件复制进 <profile>/packages/<name>/ 与 <profile>/node_modules/<name>/
 *      （只带运行需要的文件：package.json / cordis.patch.yml / lib / assets）
 *   2. 在 <profile>/package.json 里登记 dependencies 与 dsh.profile.bundles（先自动备份）
 *   3. 全程 UTF-8 **无 BOM** 写入，并当场校验 JSON 可解析
 *
 * 注意：装完必须**重启 dsh web** 才生效（bundles 只在启动时读取）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NAME = 'dsh-workspace-tools';
const SRC = path.dirname(fileURLToPath(import.meta.url));
const KEEP = ['package.json', 'cordis.patch.yml', 'lib', 'assets'];

const profileName = process.argv[2] || 'web';
const profilesRoot = path.join(os.homedir(), '.dsh', 'profiles');
const profileDir = path.join(profilesRoot, profileName);
const pkgPath = path.join(profileDir, 'package.json');

if (!fs.existsSync(pkgPath)) {
  console.error('✗ 找不到 profile: ' + profileDir);
  if (fs.existsSync(profilesRoot)) {
    const avail = fs.readdirSync(profilesRoot)
      .filter((n) => fs.existsSync(path.join(profilesRoot, n, 'package.json')));
    if (avail.length) console.error('  可用的 profile: ' + avail.join(', '));
  }
  process.exit(1);
}

/* 1. 复制运行所需文件 */
function copyEntry(rel, dstRoot) {
  const src = path.join(SRC, rel);
  if (!fs.existsSync(src)) return;
  const dst = path.join(dstRoot, rel);
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const child of fs.readdirSync(src)) copyEntry(path.join(rel, child), dstRoot);
  } else {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
}
const targets = [
  path.join(profileDir, 'packages', NAME),
  path.join(profileDir, 'node_modules', NAME),
];
for (const t of targets) {
  for (const rel of KEEP) copyEntry(rel, t);
}

/* 2. 登记到 profile 的 package.json */
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const backup = pkgPath + '.bak-' + stamp + '-' + NAME;
fs.copyFileSync(pkgPath, backup);

const raw = fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, '');
let j;
try {
  j = JSON.parse(raw);
} catch (e) {
  console.error('✗ profile 的 package.json 不是合法 JSON：' + e.message);
  process.exit(1);
}
j.dependencies = j.dependencies || {};
j.dependencies[NAME] = 'file:packages\\' + NAME;
j.dsh = j.dsh || {};
j.dsh.profile = j.dsh.profile || {};
j.dsh.profile.bundles = Array.isArray(j.dsh.profile.bundles) ? j.dsh.profile.bundles : [];
if (!j.dsh.profile.bundles.includes(NAME)) j.dsh.profile.bundles.push(NAME);

fs.writeFileSync(pkgPath, JSON.stringify(j, null, 2) + '\n', 'utf8');   // node 写文件不带 BOM

/* 3. 校验 */
const buf = fs.readFileSync(pkgPath);
const bom = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
const check = JSON.parse(fs.readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));

console.log('✓ 已安装 ' + NAME + '  →  ' + profileDir);
console.log('  dependencies        : ' + check.dependencies[NAME]);
console.log('  bundles 数量        : ' + check.dsh.profile.bundles.length);
console.log('  备份                : ' + path.basename(backup));
console.log('  BOM                 : ' + (bom ? '有（异常！）' : '无'));
console.log('  assets/presets 张数 : ' +
  (fs.existsSync(path.join(targets[1], 'assets', 'presets'))
    ? fs.readdirSync(path.join(targets[1], 'assets', 'presets')).filter((f) => f.endsWith('.png')).length
    : 0));
console.log('\n下一步：**重启 dsh web**（bundles 只在启动时读取），然后到 设置 →「工作区」查看。');
