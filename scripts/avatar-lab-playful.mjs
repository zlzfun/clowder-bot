import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve('client/public/avatar-lab/sets');
const cats = [
  {id:'ragdoll',name:'宪宪',breed:'布偶猫',fur:'#FFF5E2',dark:'#7B625F',eye:'#69BCE4',bg:'#B7D9E8',type:'rag',ink:'#3C6276',second:'#DB7566'},
  {id:'maine-coon',name:'砚砚',breed:'缅因猫',fur:'#82776D',dark:'#423D38',eye:'#A3C66C',bg:'#C4CFAD',type:'coon',ink:'#285D53',second:'#C58A54'},
  {id:'siamese',name:'烁烁',breed:'暹罗猫',fur:'#EDCCA6',dark:'#5C4541',eye:'#64B8D6',bg:'#D5C5E5',type:'siam',ink:'#565A8B',second:'#DE7762'},
  {id:'turkish-van',name:'墨墨',breed:'梵花猫',fur:'#FFF7E9',dark:'#DB7E3D',eye:'#7B9873',bg:'#E7C3A9',type:'van',ink:'#BF633D',second:'#377681'},
  {id:'dsh',name:'鲸鲸',breed:'蓝灰短毛猫',fur:'#7795AB',dark:'#45647A',eye:'#F1CB6B',bg:'#C1D6D4',type:'blue',ink:'#3A6C7D',second:'#DD9A51'},
  {id:'dragon-li',name:'小狸花',breed:'狸花猫',fur:'#B9986E',dark:'#5D5140',eye:'#96B653',bg:'#DFD6B5',type:'tabby',ink:'#696B3C',second:'#C66D46'},
  {id:'bengal',name:'斑斑',breed:'孟加拉猫',fur:'#E9A75B',dark:'#6A442E',eye:'#ADD09A',bg:'#D7C4AB',type:'bengal',ink:'#674C37',second:'#DB8B3D'},
  {id:'golden-chinchilla',name:'金哥',breed:'金渐层',fur:'#E9BC71',dark:'#B77A42',eye:'#7BA884',bg:'#EBC8B7',type:'gold',ink:'#41786F',second:'#D79543'},
];
const line='#28272B';
const styles={sticker:'潮玩贴纸',pixel:'像素伙伴',risograph:'孔版印刷'};
const svg = (c,style,body,view='0 0 256 256') => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view}" role="img" aria-labelledby="title desc"${style==='pixel'?' shape-rendering="crispEdges"':''}><title id="title">${c.name} · ${styles[style]}</title><desc id="desc">${c.breed}原创预设头像，完整猫耳和清晰面部轮廓。</desc>${body}</svg>\n`;
const path=(d,fill,attrs='')=>`<path d="${d}" fill="${fill}" ${attrs}/>`;
const ell=(x,y,rx,ry,fill,attrs='')=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${attrs}/>`;
const cir=(x,y,r,fill,attrs='')=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${attrs}/>`;
const strokes=`stroke="${line}" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"`;
function outline(c) {
 switch(c.type){
 case 'coon':return 'M50 111 47 49 66 61 72 36 92 82 Q128 65 164 82 L184 36 190 61 209 49 206 111 220 137 206 143 219 162 204 165 212 183 192 186 Q169 213 128 215 87 213 64 186 L44 183 52 165 37 162 50 143 36 137Z';
 case 'siam':return 'M62 114 49 40 Q78 38 99 87 Q128 79 157 87 178 38 207 40 L194 114 Q208 150 188 180 167 207 128 212 89 207 68 180 48 150 62 114Z';
 case 'rag':return 'M58 105 53 47 Q79 44 98 80 Q128 70 158 80 177 44 203 47 L198 105 211 130 201 139 219 154 205 162 215 180 196 181 Q174 214 128 216 82 214 60 181 L41 180 51 162 37 154 55 139 45 130Z';
 case 'blue':return 'M49 112 56 56 Q79 54 96 84 Q128 73 160 84 177 54 200 56 L207 112 Q230 156 205 187 180 219 128 220 76 219 51 187 26 156 49 112Z';
 case 'bengal':return 'M58 108 59 52 Q83 49 103 83 Q128 76 153 83 173 49 197 52 L198 108 Q218 148 197 176 172 205 128 217 84 205 59 176 38 148 58 108Z';
 default:return 'M54 109 57 52 Q82 49 101 83 Q128 75 155 83 174 49 199 52 L202 109 Q223 148 205 181 184 215 128 219 72 215 51 181 33 148 54 109Z';
 }
}
function sticker(c,i){
 const d=outline(c);
 let b=`<rect width="256" height="256" rx="52" fill="${c.bg}"/>`;
 b+=`<g opacity=".28" fill="#fff"><circle cx="31" cy="31" r="10"/><circle cx="221" cy="205" r="13"/><path d="m222 65 3 7 8 2-8 3-3 8-3-8-7-3 7-2z"/></g>`;
 b+=path(d,'#fff','stroke="#fff" stroke-width="21" stroke-linejoin="round"');
 b+=path(d,c.fur,strokes);
 b+=`<clipPath id="face"><path d="${d}"/></clipPath><g clip-path="url(#face)">`;
 if(c.type==='rag'){
 b+=path('M42 44Q86 36 102 89L99 146Q72 165 59 143Z',c.dark)+path('M214 44Q170 36 154 89L157 146Q184 165 197 143Z',c.dark);
 b+=path('M125 87Q111 116 105 154L128 173 151 154Q145 116 131 87Z','#FFFFFF');
 }
 if(c.type==='siam')b+=path('M40 29Q85 35 100 91L103 108Q128 89 153 108L156 91Q171 35 216 29L201 144Q192 180 128 190 64 180 55 144Z',c.dark);
 if(c.type==='van')b+=path('M48 40Q99 48 118 88L111 128Q86 143 64 125Z',c.dark)+path('M183 49Q212 35 211 107L169 102Z',c.dark);
 if(['tabby','coon','bengal'].includes(c.type)){
  b+=path('M106 78 116 108 122 81 129 108 136 80 141 108 153 80',c.dark);
  if(c.type!=='bengal')b+=path('M43 123 75 136 45 140 77 151 46 162 72 166 56 178M213 123 181 136 211 140 179 151 210 162 184 166 200 178',c.dark);
 }
 if(c.type==='bengal') for(const [x,y,r] of [[73,113,7],[184,113,7],[58,140,6],[196,142,7],[74,166,6],[181,167,6],[87,91,5],[168,91,5]]) b+=ell(x,y,r+2,r,c.dark)+ell(x,y,r-2,r-2,c.fur);
 if(c.type==='gold')b+=path('M40 176Q76 161 90 144 128 127 166 144 180 161 216 176L220 230H30Z','#FFEDCC');
 if(c.type==='coon') b+=path('M70 185 90 181 104 195 128 181 152 195 166 181 187 186 166 227H89Z','#D9CBAD');
 b+='</g>';
 const inner=c.type==='siam'?'#BB827C':'#E7A3A1';
 b+=path(c.type==='siam'?'M61 53Q84 61 88 91L68 105Z':'M65 65 91 93 68 107Z',inner);
 b+=path(c.type==='siam'?'M195 53Q172 61 168 91L188 105Z':'M191 65 165 93 188 107Z',inner);
 if(c.type==='coon'){
   b+=path('M81 129 109 135M147 135 175 129','none',strokes);
   b+=ell(96,143,10,10,c.eye)+ell(160,143,10,10,c.eye)+cir(97,143,5,line)+cir(159,143,5,line);
 }else if(c.type==='van'){
   b+=path('M81 138Q95 126 108 138M148 138Q161 126 175 138','none',strokes);
 }else{
   b+=ell(94,139,13,17,line)+ell(162,139,13,17,line);
   b+=ell(94,141,9,12,c.eye)+ell(162,141,9,12,c.eye)+ell(96,141,4,10,line)+ell(160,141,4,10,line);
   b+=cir(91,133,3.5,'#fff')+cir(159,133,3.5,'#fff');
 }
 b+=ell(114,169,18,14,c.type==='siam'?'#A47D6A':'#FFF5E4')+ell(142,169,18,14,c.type==='siam'?'#A47D6A':'#FFF5E4');
 b+=path('M119 159Q128 155 137 159L128 168Z','#BA797A',`stroke="${line}" stroke-width="3" stroke-linejoin="round"`);
 b+=path('M128 168V174Q120 183 113 175M128 174Q136 183 143 175','none','stroke="'+line+'" stroke-width="3.5" stroke-linecap="round"');
 b+=path('M70 159 49 154M70 170 45 171M186 159 207 154M186 170 211 171','none','stroke="'+line+'" stroke-width="4" stroke-linecap="round"');
 if(c.type==='siam')b+=path('M123 181Q128 187 133 181V189Q128 197 123 189Z','#D98D91');
 if(c.type==='blue') b+=path('M109 214 128 207 147 214 144 230 128 223 112 230Z','#EEA46A','stroke="#28272B" stroke-width="4" stroke-linejoin="round"');
 return svg(c,'sticker',b);
}
const rect=(x,y,w,h,f)=>`<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="${f}"/>`;
function pixel(c,i){
 const d=c.type==='siam'?'M8 7H10V8H12V10H14V13H26V10H28V8H30V7H32V21H34V28H32V31H29V33H25V35H15V33H11V31H8V28H6V21H8Z':c.type==='coon'?'M7 6H9V8H11V10H13V13H27V10H29V8H31V6H33V20H35V24H34V26H35V28H32V31H30V33H25V35H15V33H10V31H8V28H5V26H6V24H5V20H7Z':'M8 8H12V10H14V13H26V10H28V8H32V19H34V22H35V28H33V31H30V33H26V35H14V33H10V31H7V28H5V22H6V19H8Z';
 let b=rect(0,0,40,40,c.bg)+path(d,'#31404B','transform="translate(1 1)" opacity=".25"')+path(d,line);
 b+=`<clipPath id="px"><path d="${d}"/></clipPath><g clip-path="url(#px)">`;
 b+=rect(9,10,3,9,c.fur)+rect(28,10,3,9,c.fur)+rect(10,12,4,7,c.fur)+rect(26,12,4,7,c.fur)+rect(9,16,23,15,c.fur)+rect(7,21,27,6,c.fur)+rect(8,26,24,3,c.fur)+rect(11,30,18,2,c.fur)+rect(15,32,10,2,c.fur);
 b+=rect(10,12,2,5,'#D9A5A0')+rect(28,12,2,5,'#D9A5A0');
 if(c.type==='rag'){
 b+=rect(9,10,3,7,c.dark)+rect(28,10,3,7,c.dark)+rect(9,18,7,8,c.dark)+rect(25,18,7,8,c.dark)+rect(14,16,2,4,c.dark)+rect(24,16,2,4,c.dark)+rect(18,17,4,7,'#FFFAF0')+rect(16,22,8,7,'#FFFAF0');
 }
 if(c.type==='siam') b+=rect(9,9,3,10,c.dark)+rect(28,9,3,10,c.dark)+rect(12,18,16,11,c.dark)+rect(10,21,20,6,c.dark)+rect(16,29,8,3,c.dark);
 if(c.type==='van') b+=rect(9,10,4,8,c.dark)+rect(12,15,5,5,c.dark)+rect(28,10,3,9,c.dark)+rect(26,16,4,3,c.dark);
 if(['coon','tabby','bengal'].includes(c.type)) {
 b+=rect(16,16,2,3,c.dark)+rect(19,15,2,5,c.dark)+rect(22,16,2,3,c.dark);
 if(c.type!=='bengal')b+=rect(8,23,3,2,c.dark)+rect(9,27,3,2,c.dark)+rect(29,23,3,2,c.dark)+rect(28,27,3,2,c.dark);
 }
 if(c.type==='bengal')for(const [x,y]of [[11,18],[27,18],[8,23],[29,23],[11,27],[27,28]])b+=rect(x,y,2,2,c.dark);
 if(c.type==='gold'||c.type==='coon') b+=rect(13,26,14,5,'#FFE9C7')+rect(16,31,8,2,'#FFE9C7');
 b+='</g>';
 b+=rect(12,21,5,4,line)+rect(24,21,5,4,line)+rect(13,21,3,3,c.eye)+rect(25,21,3,3,c.eye)+rect(14,21,1,3,line)+rect(26,21,1,3,line)+rect(13,21,1,1,'#FFFFFF')+rect(25,21,1,1,'#FFFFFF');
 if(c.type==='coon') b+=rect(12,20,5,1,line)+rect(24,20,5,1,line);
 b+=rect(18,26,4,1,'#C48289')+rect(19,27,2,1,'#C48289')+rect(19,28,2,1,line)+rect(17,29,2,1,line)+rect(21,29,2,1,line);
 b+=rect(5,26,5,1,line)+rect(30,26,5,1,line)+rect(4,28,5,1,line)+rect(31,28,5,1,line);
 b+=rect(4,7,1,1,'#fff')+rect(35,10,1,1,'#fff');
 if(c.type==='blue') b+=rect(17,34,6,2,'#E9A458')+rect(19,34,2,2,'#A3633C');
 return svg(c,'pixel',b,'0 0 40 40');
}
function riso(c,i){
 const ink=c.ink,accent=c.second,paper='#F6EFD9';
 const tilt=[-5,4,7,-5,0,4,-6,3][i];
 let b=`<rect width="256" height="256" rx="8" fill="${paper}"/><defs><pattern id="grain" width="17" height="19" patternUnits="userSpaceOnUse"><circle cx="3" cy="4" r=".65" fill="${ink}" opacity=".18"/><circle cx="12" cy="13" r=".5" fill="${ink}" opacity=".16"/><path d="m8 2 1 1m-4 10 1 1" stroke="${ink}" stroke-width=".4" opacity=".22"/></pattern><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse"><path d="M-2 8 8-2M6 10 10 6" stroke="${ink}" stroke-width="1.1" opacity=".18"/></pattern></defs>`;
 b+=cir(130,134,100,accent,'opacity=".13"')+path('M28 187Q81 170 106 204 149 175 225 190V225H28Z',accent,'opacity=".1"');
 b+=`<g transform="rotate(${tilt} 128 139)">`;
 const d=c.type==='siam'?'M65 111 55 40 100 83Q127 73 156 83L201 40 191 111Q210 156 182 188L128 217 74 188Q46 156 65 111Z':c.type==='coon'?'M55 113 55 43 91 81Q128 70 165 81L201 43 201 113 216 151 202 154 213 179 192 181 183 203 159 199 128 221 97 199 73 203 64 181 43 179 54 154 40 151Z':'M57 110 60 50 99 85Q129 74 157 85L197 50 200 110Q217 154 195 183 171 214 129 214 86 214 61 183 39 154 57 110Z';
 b+=path(d,accent,'transform="translate(3 -2)" opacity=".28"')+path(d,paper,`stroke="${ink}" stroke-width="3" stroke-linejoin="round"`);
 b+=`<clipPath id="printFace"><path d="${d}"/></clipPath><g clip-path="url(#printFace)">`;
 if(['blue','gold','coon','tabby','bengal'].includes(c.type)) b+=path(d,accent,'opacity=".68"');
 if(c.type==='rag') b+=path('M45 40H94L106 110 94 151 60 154ZM211 40H162L150 110 162 151 196 154Z',ink,'opacity=".9"');
 if(c.type==='siam') b+=path('M45 32 100 77 107 112Q128 100 149 112L156 77 211 32 203 140 175 178 128 196 81 178 53 140Z',ink);
 if(c.type==='van')b+=path('M45 42 98 48 114 104Q90 142 57 130ZM174 51 208 42 204 118 166 107Z',accent);
 if(['coon','tabby'].includes(c.type))b+=path('M105 73 116 114 128 84 140 114 151 73M43 123 84 137 43 141 81 154 44 165 79 170M213 123 172 137 213 141 175 154 212 165 177 170',ink,'opacity=".8"');
 if(c.type==='bengal')for(const [x,y]of [[80,104],[175,104],[59,139],[197,139],[72,174],[182,174],[112,88],[145,90]])b+=ell(x,y,7,5,ink,'opacity=".9"')+ell(x,y,3,2,accent);
 if(c.type==='gold'||c.type==='rag'||c.type==='coon')b+=path('M78 175Q98 139 128 150 159 139 179 175L185 218H72Z',paper);
 b+=path(d,'url(#hatch)','opacity=".7"')+'</g>';
 b+=path('M68 70 87 94 69 107ZM188 70 169 94 187 107Z',accent);
 const eyesFill=c.type==='siam'?paper:ink;
 if(c.type==='van') b+=path('M82 137Q95 123 108 137M148 137Q161 123 174 137','none',`stroke="${ink}" stroke-width="4" stroke-linecap="round"`);
 else {
 b+=path('M79 135Q94 119 109 135 94 149 79 135ZM147 135Q162 119 177 135 162 149 147 135Z',eyesFill);
 b+=ell(96,135,3.4,9,c.type==='siam'?accent:paper)+ell(160,135,3.4,9,c.type==='siam'?accent:paper);
 }
 b+=path('M119 158 138 158 129 166Z',c.type==='siam'?accent:ink)+path('M129 165V174L119 181M129 174 139 181','none',`stroke="${c.type==='siam'?paper:ink}" stroke-width="2.5" stroke-linecap="round"`);
 b+=path('M85 160 44 155M85 168 42 173M171 160 212 155M171 168 214 173','none',`stroke="${ink}" stroke-width="2" stroke-linecap="round"`);
 b+='</g>';
 b+=`<rect width="256" height="256" fill="url(#grain)"/>`;
 return svg(c,'risograph',b);
}
for (const [style, fn] of Object.entries({sticker,pixel,risograph:riso})){
 const dir=resolve(root,style);mkdirSync(dir,{recursive:true});
 cats.forEach((c,i)=>writeFileSync(resolve(dir,`${c.id}.svg`),fn(c,i)));
}
console.log('Created 24 SVG avatars in sticker/, pixel/, risograph/.');
