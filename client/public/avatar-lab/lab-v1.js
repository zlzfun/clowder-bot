const cats = [
  ['ragdoll','宪宪','布偶猫','架构与开发'],['maine-coon','砚砚','缅因猫','代码审查'],
  ['siamese','烁烁','暹罗猫','视觉与创意'],['turkish-van','墨墨','梵花猫','文档与验收'],
  ['dsh','鲸鲸','蓝灰短毛猫','推理与分析'],['dragon-li','小狸花','狸花猫','中文实证'],
  ['bengal','斑斑','孟加拉猫','探索与多模态'],['golden-chinchilla','金哥','金渐层','全栈开发']
];
const styles = [
  {id:'soft',code:'A',name:'奶油扁平',format:'SVG',note:'柔和轮廓与奶油色块，温柔、亲近，适合日常陪伴。'},
  {id:'mono',code:'B',name:'黑白线描',format:'SVG',note:'用笔触与留白建立表情，贴近当前 demo 的克制气质。'},
  {id:'geo',code:'C',name:'几何拼贴',format:'SVG',note:'圆、三角与大胆色面，简洁但有鲜明的设计感。'},
  {id:'sticker',code:'D',name:'潮玩贴纸',format:'SVG',note:'粗线条、夸张表情和小配饰，角色感更强。'},
  {id:'pixel',code:'E',name:'像素伙伴',format:'SVG',note:'清晰的像素网格，像住在终端里的小小冒险家。'},
  {id:'risograph',code:'F',name:'孔版印刷',format:'SVG',note:'有限色彩与纸面颗粒，带一点独立杂志的手作感。'},
  {id:'clay',code:'G',name:'3D 玩偶肖像',format:'PNG',note:'立体眼神与细腻毛发，品种特征直观，存在感饱满。'},
  {id:'felt',code:'H',name:'羊毛毡伙伴',format:'PNG',note:'纤维、绒毛与手工温度，把猫猫变成桌边的小玩偶。'},
  {id:'watercolor',code:'I',name:'水彩绘本',format:'PNG',note:'透明水色与轻盈笔触，像从一本安静的绘本里走来。'}
];
let active = styles[0];
const $ = s => document.querySelector(s);
const url = (style, index) => style.format === 'SVG' ? `./sets/${style.id}/${cats[index][0]}.svg` : `./sheets/${style.id}.png`;
function portrait(style, index, size, decorative = false) {
  const label = `${style.name} · ${cats[index][1]}（${cats[index][2]}）`;
  const sizing = size ? ` style="width:${size}px;height:${size}px"` : '';
  if (style.format === 'SVG') return `<span class="portrait ${style.id}"${sizing}><img src="${url(style,index)}" alt="${decorative ? '' : label}" draggable="false"></span>`;
  return `<span class="portrait raster"${sizing} ${decorative ? 'aria-hidden="true"' : `role="img" aria-label="${label}"`}><span class="sprite" style="background-image:url('${url(style,index)}');--x:${index%4/3*100}%;--y:${Math.floor(index/4)*100}%"></span></span>`;
}
function renderPreview() {
  $('#selected-label').textContent = `${active.code} · ${active.name}`;
  $('#style-select').value = active.id;
  $('#previews').innerHTML = [false,true].map(dark=>`<div class="chat ${dark?'dark-chat':''}"><div class="chat-head">${portrait(active,0,36,true)}<div><div class="chat-name">猫猫协作室</div><div class="chat-sub">宪宪、砚砚、烁烁和你</div></div><span class="chat-theme">${dark?'DARK':'LIGHT'} / 36 PX</span></div><div class="chat-body"><div class="message">${portrait(active,0,24,true)}<div class="bubble"><span class="sender">宪宪 · 架构与开发</span><p>我把方案理清了，交给砚砚检查一下。</p></div></div><div class="message">${portrait(active,1,24,true)}<div class="bubble"><span class="sender">砚砚 · 代码审查</span><p>收到。我来看看边界条件。<span aria-hidden="true"> ✦</span></p></div></div></div></div>`).join('');
  document.querySelectorAll('.style-row').forEach(row=>row.classList.toggle('active-row',row.dataset.style===active.id));
}
$('#style-select').innerHTML = styles.map(s=>`<option value="${s.id}">${s.code} · ${s.name}</option>`).join('');
$('#column-head').innerHTML = '<div>STYLE / CHARACTER</div>'+cats.map(c=>`<div><span class="cat-name">${c[1]}</span><span class="cat-breed">${c[2]}</span></div>`).join('');
$('#style-rows').innerHTML = styles.map(s=>`<section class="style-row" data-style="${s.id}" aria-label="${s.code} ${s.name}"><div class="style-info"><div><span class="style-number">${s.code}</span><h3>${s.name}</h3></div><p>${s.note}</p><span class="format">${s.format==='SVG'?'VECTOR / SVG':'GENERATED / PNG'}</span><button class="row-preview" data-preview="${s.id}">放入聊天 ↑</button></div>${cats.map((c,i)=>`<button class="avatar-cell" data-style="${s.id}" data-cat="${i}" aria-label="查看 ${s.code}${String(i+1).padStart(2,'0')} ${s.name} ${c[1]}">${portrait(s,i)}<span class="avatar-code" data-name="${c[1]}">${s.code}${String(i+1).padStart(2,'0')}</span></button>`).join('')}</section>`).join('');
$('#style-select').addEventListener('change',e=>{active=styles.find(s=>s.id===e.target.value);renderPreview();});
document.querySelectorAll('[data-shape]').forEach(button=>button.addEventListener('click',()=>{
  document.documentElement.style.setProperty('--radius',button.dataset.shape==='round'?'50%':'18%');
  document.querySelectorAll('[data-shape]').forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
}));
$('#theme-toggle').addEventListener('click',()=>{const dark=document.body.classList.toggle('dark');$('#theme-toggle').setAttribute('aria-pressed',String(dark));$('#theme-toggle').textContent=dark?'浅色背景':'深色背景';});
document.querySelectorAll('[data-preview]').forEach(b=>b.addEventListener('click',()=>{active=styles.find(s=>s.id===b.dataset.preview);renderPreview();$('#tryout-title').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});}));
const dialog = $('#detail');
dialog.querySelector('.close').addEventListener('click',()=>dialog.close());
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
document.querySelectorAll('.avatar-cell').forEach(b=>b.addEventListener('click',()=>showDetail(styles.find(s=>s.id===b.dataset.style),Number(b.dataset.cat))));
function showDetail(style,index) {
  const cat=cats[index], code=style.code+String(index+1).padStart(2,'0');
  $('#detail-content').innerHTML = `<div class="detail-hero">${portrait(style,index,164)}<div><span class="detail-code">${code} / ${style.format}</span><h2>${cat[1]}</h2><p>${cat[2]} · ${cat[3]}</p><p>${style.name}</p></div></div><div class="size-strip">${[24,36,44,72].map(size=>`<div class="size-item">${portrait(style,index,size,true)}<span>${size}px</span></div>`).join('')}</div><p class="detail-note">${style.note}<br>${style.format==='SVG'?'可无限缩放，直接作为头像文件使用。':'从 4 × 2 原图网格导出单只方形 PNG；保留原图的完整细节。'}</p><div class="detail-actions">${style.format==='SVG'?`<a class="primary" href="${url(style,index)}" download="${style.id}-${cat[0]}.svg">下载 SVG</a>`:`<button class="primary" id="download-cat">下载单只 PNG</button><a href="${url(style,index)}" download="${style.id}-all-cats.png">整组原图</a>`}<button id="apply-style">预览此组</button><button id="copy-code">复制编号</button></div><p class="detail-status" role="status"></p>`;
  $('#apply-style').addEventListener('click',()=>{active=style;renderPreview();dialog.close();$('#tryout-title').scrollIntoView({behavior:'smooth'});});
  $('#copy-code').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(`${code} ${style.name} / ${cat[1]}`);$('.detail-status').textContent=`已复制 ${code}`;}catch{$('.detail-status').textContent=`编号：${code} ${style.name} / ${cat[1]}`;}});
  if(style.format==='PNG') $('#download-cat').addEventListener('click',async()=>{
    const button=$('#download-cat');button.disabled=true;
    try{const img=new Image();img.src=url(style,index);await img.decode();const cellW=img.naturalWidth/4,cellH=img.naturalHeight/2;const canvas=document.createElement('canvas');canvas.width=Math.round(cellW);canvas.height=Math.round(cellH);canvas.getContext('2d').drawImage(img,index%4*cellW,Math.floor(index/4)*cellH,cellW,cellH,0,0,canvas.width,canvas.height);const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('PNG export failed');const href=URL.createObjectURL(blob);const a=document.createElement('a');a.href=href;a.download=`${style.id}-${cat[0]}.png`;a.click();setTimeout(()=>URL.revokeObjectURL(href),1000);$('.detail-status').textContent=`已导出 ${canvas.width} × ${canvas.height} PNG`;}catch{$('.detail-status').textContent='导出暂未成功，请下载整组原图。';}finally{button.disabled=false;}
  });
  dialog.showModal();
}
renderPreview();
// Public metadata is also included in the download bundle for straightforward integration.
window.avatarLab = {cats,styles};
