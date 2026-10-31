import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Render the contact-sheet artwork independently of the browser's window size.
// Pass the absolute path to a sharp installation as the first argument if needed.
const require = createRequire(import.meta.url);
const sharp = require(process.argv[2] || '/Users/zhuliuzi/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/sharp');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../client/public/avatar-lab');
const data = JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8'));
const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const uri = (file, mime) => `data:${mime};base64,${readFileSync(resolve(root, file)).toString('base64')}`;
const text = (x, y, value, size=14, color='#272828', weight=400, extra='') => `<text x="${x}" y="${y}" font-size="${size}" fill="${color}" font-weight="${weight}" ${extra}>${xml(value)}</text>`;
const line = y => `<path d="M36 ${y}H1404" fill="none" stroke="#E0E2DD"/>`;
const groups = {active:'01  /  当前使用 · 3D 玩偶肖像与猫咖配色', retained:'02  /  保留方案 · 手绘墨稿与水彩绘本'};
const definitions = ['<clipPath id="avatar-circle"><circle cx="50" cy="50" r="50"/></clipPath>'];
for (const s of data.collections) {
  if (s.format === 'PNG') definitions.push(`<image id="sheet-${s.id}" width="400" height="200" preserveAspectRatio="none" href="${uri(s.sheet, 'image/png')}"/>`);
}
let parts = [
  text(36, 39, 'CLOWDER-BOT   /   AVATAR STUDIES', 12, '#797C75', 500, 'letter-spacing="1.4"'),
  text(1404, 39, 'SELECTED · 2026.10.31', 12, '#797C75', 400, 'text-anchor="end"'),
  text(36, 91, '猫猫咖啡馆 · 已选方案', 34, '#252725', 600),
  text(36, 122, '当前使用 G · 3D 玩偶肖像   /   保留 N · 手绘墨稿、I · 水彩绘本', 14, '#777B73'),
  line(145)
];
const left = 218, step = 146;
data.characters.forEach((cat, index) => {
  const x = left + index * step + 58;
  parts.push(text(x, 174, cat.name, 14, '#333631', 500, 'text-anchor="middle"'));
  parts.push(text(x, 195, cat.breed, 11, '#81857D', 400, 'text-anchor="middle"'));
});
let y = 210;
for (let si = 0; si < data.collections.length; si++) {
  const s = data.collections[si];
  if (si === 0 || s.group !== data.collections[si-1].group) {
    parts.push(`<rect x="36" y="${y}" width="1368" height="38" rx="4" fill="#EBEEE7"/>`);
    parts.push(text(50, y+24, groups[s.group], 13, '#596153', 500));
    y += 51;
  }
  parts.push(text(36, y+31, s.code, 14, '#868A83', 500));
  parts.push(text(61, y+31, s.name, 18, '#262927', 600));
  const descriptions = {
    'ink-portrait':['微侧姿态 · 杏仁眼','流畅轮廓与细墨线'],
    'round-comic':['圆脸 · 轻松表情','实黑色块与留白'],
    'ink-editorial':['自然笔触 · 灵动姿态','精细钢笔插画'],
    capsule:['石墨底 · 圆润剪影','少量色块与胶囊双眼'],
    'quiet-flat':['暖灰底 · 柔和毛色','安静的极简色面'],
    'bot-flat':['有机轮廓 · 平整色面','保留猫耳与花色'],
    risograph:['首轮原稿保留','复古纸感与双色叠印'],
    clay:['当前已接入应用','立体眼神与细腻毛发'],
    watercolor:['首轮原稿保留','透明水色与轻盈笔触']
  };
  descriptions[s.id].forEach((t,i)=>parts.push(text(36,y+60+i*20,t,12,'#7A7E76')));
  parts.push(text(36, y+111, s.format==='SVG'?'SVG / 原创矢量':'PNG / 生图探索', 10, '#8C9088'));
  s.avatars.forEach((avatar, index) => {
    const x=left+index*step;
    const bg=s.id==='capsule'?'#292A2D':s.id==='bot-flat'?'#999A96':'#F5F4EF';
    let graphic=`<circle cx="50" cy="50" r="50" fill="${bg}"/>`;
    if(s.format==='SVG') graphic+=`<image width="100" height="100" href="${uri(avatar.path,'image/svg+xml')}"/>`;
    else {
      const inset=s.id==='bot-flat'?0:5, size=100-inset*2;
      graphic+=`<svg x="${inset}" y="${inset}" width="${size}" height="${size}" viewBox="${avatar.column*100} ${avatar.row*100} 100 100" overflow="hidden"><use href="#sheet-${s.id}"/></svg>`;
    }
    parts.push(`<svg x="${x}" y="${y}" width="116" height="116" viewBox="0 0 100 100"><g clip-path="url(#avatar-circle)">${graphic}</g></svg>`);
    parts.push(text(x+58,y+139,avatar.code,11,'#7C8178',400,'text-anchor="middle" letter-spacing="1"'));
  });
  y += 156;
  parts.push(line(y));
  y += 17;
}
parts.push(text(36,y+22,'同样八只猫，不同表达。编号可用于选择单只头像，或选择整组作为主题方向。',13,'#797F73'));
parts.push(text(1404,y+22,'G / N / I',12,'#797F73',400,'text-anchor="end"'));
const svg=`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1440" height="${y+55}" viewBox="0 0 1440 ${y+55}" role="img"><title>clowder-bot 猫猫头像已选方案</title><desc>当前使用G三维玩偶肖像，保留N手绘墨稿和I水彩绘本。每组八位猫猫，共二十四款。</desc><defs>${definitions.join('')}</defs><rect width="1440" height="${y+55}" fill="#F8F9F6"/><g font-family="PingFang SC, Noto Sans CJK SC, Arial, sans-serif">${parts.join('')}</g></svg>`;
writeFileSync(resolve(root,'overview-board.svg'),svg);
await sharp(Buffer.from(svg)).png().toFile(resolve(root,'overview.png'));
console.log(`Rendered 1440 × ${y+55} overview.png and editable overview-board.svg.`);
