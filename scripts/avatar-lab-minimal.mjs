import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

// Original vector portraits for the avatar lab. All artwork is self-contained.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../client/public/avatar-lab/sets');
const cats = [
  { id:'ragdoll', name:'宪宪', breed:'布偶猫', bg:'#EEE8F3', fur:'#F8F4EB', dark:'#74605F', ink:'#403B42', eye:'#79A9C4', blush:'#E4B6B4' },
  { id:'maine-coon', name:'砚砚', breed:'缅因猫', bg:'#E5ECDC', fur:'#8B9185', dark:'#51594F', ink:'#34423C', eye:'#D7C36F', blush:'#C8B5A1' },
  { id:'siamese', name:'烁烁', breed:'暹罗猫', bg:'#E1EBF2', fur:'#EAE0CA', dark:'#6B5751', ink:'#433F44', eye:'#79B9D1', blush:'#E3B1A0' },
  { id:'turkish-van', name:'墨墨', breed:'梵花猫', bg:'#E9E7EF', fur:'#FFFBF3', dark:'#C98C58', ink:'#6C5550', eye:'#D8AB55', blush:'#E8C0B0' },
  { id:'dsh', name:'鲸鲸', breed:'蓝灰短毛猫', bg:'#E0EDF0', fur:'#91A5B3', dark:'#647E91', ink:'#3E586A', eye:'#DBAE5C', blush:'#BEAAB0' },
  { id:'dragon-li', name:'小狸花', breed:'狸花猫', bg:'#EFE8D9', fur:'#B4A085', dark:'#6C5A49', ink:'#554B3E', eye:'#A9B77B', blush:'#CFA798' },
  { id:'bengal', name:'斑斑', breed:'孟加拉猫', bg:'#F3E2D0', fur:'#D3A06A', dark:'#815B3E', ink:'#614532', eye:'#A7AE6F', blush:'#D8A28F' },
  { id:'golden-chinchilla', name:'金哥', breed:'金渐层', bg:'#F3ECCD', fur:'#DFBD7B', dark:'#B18C4E', ink:'#6C583D', eye:'#98AA7B', blush:'#D9B49B' },
];
const p=(d,fill,extra='')=>`<path d="${d}" fill="${fill}" ${extra}/>`;
const e=(x,y,rx,ry,fill,extra='')=>`<ellipse cx="${x}" cy="${y}" rx="${rx}" ry="${ry}" fill="${fill}" ${extra}/>`;
const c=(x,y,r,fill,extra='')=>`<circle cx="${x}" cy="${y}" r="${r}" fill="${fill}" ${extra}/>`;
const line=(d,col,w=3)=>p(d,'none',`stroke="${col}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"`);
function svg(cat,style,body){return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" role="img" aria-labelledby="title desc"><title id="title">${cat.name} · ${cat.breed} · ${style}</title><desc id="desc">Original square cat portrait with a complete ear silhouette, designed for small chat avatars.</desc>${body}</svg>\n`;}
const head = {
  'ragdoll':'M45 108 C41 86 42 55 52 38 Q81 41 98 64 Q127 54 158 64 Q181 40 205 38 Q215 77 209 108 Q226 130 215 155 L226 166 L209 173 L218 183 L198 189 Q184 217 128 218 Q76 216 58 190 L39 181 L49 172 L31 165 L43 154 Q33 129 45 108Z',
  'maine-coon':'M43 111 L42 49 L33 32 L54 41 L60 27 L77 63 Q127 53 172 64 L192 27 L196 46 L221 32 L209 59 L211 112 L228 133 L216 144 L231 157 L212 166 L221 180 L198 187 L193 203 L168 202 Q128 231 88 204 L65 205 L62 187 L39 178 L48 166 L29 155 L44 142 L31 132Z',
  'siamese':'M56 118 Q35 84 29 33 Q63 35 99 75 Q129 67 157 76 Q192 34 228 34 Q223 84 202 119 Q213 147 196 178 Q178 209 128 220 Q77 206 60 177 Q43 146 56 118Z',
  'turkish-van':'M47 105 Q45 68 55 36 Q87 42 102 69 Q131 61 159 71 Q182 44 208 41 Q218 72 207 111 Q219 134 208 163 Q191 208 129 215 Q65 213 47 173 Q30 139 47 105Z',
  'dsh':'M48 107 Q45 74 53 48 Q79 44 98 69 Q128 60 160 70 Q178 46 203 49 Q214 77 206 109 Q226 137 211 174 Q192 217 129 220 Q62 218 43 175 Q29 137 48 107Z',
  'dragon-li':'M46 106 Q43 65 54 34 Q84 46 100 69 Q127 62 155 70 Q177 42 204 35 Q218 68 209 110 Q224 143 202 179 Q177 213 129 218 Q75 211 50 180 Q31 146 46 106Z',
  'bengal':'M46 108 Q40 74 50 35 Q80 42 101 69 Q132 59 158 72 Q182 42 210 40 Q221 78 208 112 Q221 143 204 174 Q183 207 132 215 Q81 215 55 181 Q32 148 46 108Z',
  'golden-chinchilla':'M48 105 Q45 73 59 47 Q83 47 100 67 Q131 60 158 69 Q178 44 201 49 Q215 76 207 109 Q227 139 211 176 Q191 219 128 220 Q65 218 44 179 Q27 144 48 105Z'
};
function ears(cat){
 const i=cat.id;
 if(i==='siamese')return p('M43 50 Q67 56 88 79 L58 110Z',cat.dark)+p('M212 52 Q190 57 170 81 L198 111Z',cat.dark)+p('M49 59 L75 80 L60 97Z','#B18A83')+p('M204 61 L182 83 L195 96Z','#B18A83');
 if(i==='maine-coon')return p('M53 53 L82 77 L57 112Z',cat.dark)+p('M199 52 L174 79 L204 111Z',cat.dark);
 return p('M58 54 Q77 57 89 78 L57 104Z',i==='ragdoll'?cat.dark:cat.blush)+p('M196 56 Q176 59 167 80 L201 105Z',i==='ragdoll'?cat.dark:cat.blush);
}
function softMarks(cat){
 let s=''; const d=cat.dark;
 switch(cat.id){
 case 'ragdoll':s+=p('M50 102 Q63 80 99 80 Q111 103 108 140 Q90 164 59 145Z',d)+p('M151 81 Q186 78 204 104 L197 145 Q168 164 148 140 Q143 105 151 81Z',d)+p('M128 79 Q115 116 105 151 Q128 169 150 150 Q141 110 128 79Z',cat.fur);break;
 case 'maine-coon':s+=p('M77 90 L102 102 L98 111 L69 104Z',d)+p('M179 90 L153 102 L157 111 L187 104Z',d)+p('M111 66 L118 98 L126 77 L135 100 L145 67Z',d)+p('M56 145 L82 152 L62 161 L82 172 L56 172Z',d)+p('M199 145 L174 153 L194 162 L174 174 L200 171Z',d)+p('M92 177 Q128 192 166 177 L157 204 Q128 219 99 203Z','#CAC8B8');break;
 case 'siamese':s+=p('M68 105 Q92 87 128 94 Q166 88 189 107 L185 151 Q169 185 128 196 Q84 183 70 151Z',d);break;
 case 'turkish-van':s+=p('M47 105 Q48 62 55 36 Q85 41 102 69 L108 107 Q81 128 47 105Z',d)+p('M158 71 Q181 44 208 41 Q219 74 207 111 Q185 120 167 105Z',d);break;
 case 'dsh':s+=p('M99 72 Q128 61 157 72 Q142 92 128 101 Q112 88 99 72Z',cat.dark);break;
 case 'dragon-li':s+=p('M101 70 L108 105 L119 82 L128 107 L138 83 L150 104 L158 72Z',d)+p('M46 126 L78 136 L71 145 L43 140Z',d)+p('M44 153 L75 157 L75 168 L50 170Z',d)+p('M208 127 L180 137 L185 146 L213 139Z',d)+p('M212 154 L182 158 L181 168 L205 169Z',d);break;
 case 'bengal':s+=p('M108 70 L116 95 L128 79 L139 97 L149 72Z',d);for(const [x,y,r] of [[59,118,7],[63,150,8],[78,172,6],[193,119,7],[194,151,8],[177,174,6],[83,92,5],[171,93,5]]) s+=e(x,y,r,r*.77,d)+e(x+.4,y,r*.43,r*.3,cat.fur);break;
 case 'golden-chinchilla':s+=p('M91 77 Q129 65 166 78 Q158 91 147 95 Q128 82 109 95Z',cat.dark);break;
 }
 return s;
}
function soft(cat){
 let s=`<rect width="256" height="256" rx="58" fill="${cat.bg}"/>`;
 s+=e(128,224,66,10,'#000', 'opacity=".045"');
 s+=p(head[cat.id],cat.fur)+ears(cat)+softMarks(cat);
 const darkFace=cat.id==='siamese'||cat.id==='ragdoll';
 const ink=cat.ink; let ey=cat.id==='maine-coon'?132:133;
 if(cat.id==='turkish-van'){
 s+=line('M81 133 Q92 124 103 133',ink,4)+line('M153 133 Q164 124 175 133',ink,4);
 }else{
 for(const x of [92,164]){
 s+=e(x,ey,cat.id==='siamese'?14:13,cat.id==='maine-coon'?12:16,cat.eye)+e(x,ey,5.5,cat.id==='maine-coon'?10:13,ink)+c(x-3,ey-5,3.2,'#fff');
 }
 if(cat.id==='maine-coon')s+=line('M77 120 L106 125 M150 125 L179 120',ink,4);
 }
 s+=e(109,165,22,16,darkFace?'#F7F0E3':'#FFFAEC','opacity=".92"')+e(147,165,22,16,darkFace?'#F7F0E3':'#FFFAEC','opacity=".92"');
 s+=p('M121 156 Q128 152 135 156 Q136 159 128 164 Q120 160 121 156Z',cat.id==='siamese'?'#C59C98':cat.blush);
 s+=line('M128 164 L128 168 Q119 176 113 168 M128 168 Q137 176 143 168',ink,2.5);
 s+=e(67,154,10,5,cat.blush,'opacity=".7"')+e(190,154,10,5,cat.blush,'opacity=".7"');
 if(cat.id==='ragdoll')s+=p('M83 195 Q128 211 173 195 L163 213 Q129 227 94 213Z','#FFFDF7');
 if(cat.id==='dsh')s+=line('M57 173 L75 170 M181 170 L201 174',cat.dark,2.6);
 if(cat.id==='bengal')s+=line('M70 190 Q79 196 87 194',cat.dark,3);
 return svg(cat,'奶油软糖',s);
}
function mono(cat,index){
 const ink='#252824'; const paper=['#F3F0E9','#ECEEE7','#F2EEE7','#F5F0E8','#EDEFEF','#F0EDE5','#F3ECE4','#F3F0E1'][index];
 let s=`<rect width="256" height="256" rx="58" fill="${paper}"/>`;
 // Line portraits deliberately share paper and ink, while breed is carried by silhouette and mark.
 s+=p(head[cat.id],'#FFFEF8',`stroke="${ink}" stroke-width="4.2" stroke-linejoin="round"`);
 const stroke=(d,w=3)=>line(d,ink,w);
 if(cat.id==='siamese'){
 s+=p('M43 51 L86 81 L59 105Z',ink)+p('M213 52 L172 82 L197 106Z',ink);
 s+=p('M69 109 Q96 92 128 98 Q164 92 189 108 L183 151 Q165 178 128 189 Q89 177 72 150Z',ink);
 }else if(cat.id==='ragdoll'){
 s+=p('M55 54 L88 80 L56 103Z',ink)+p('M197 54 L166 80 L201 105Z',ink);
 s+=p('M56 112 Q73 88 98 91 L106 141 Q83 153 62 139Z',ink)+p('M151 92 Q180 88 198 112 L194 141 Q172 154 149 141Z',ink);
 }else{
 s+=stroke('M60 60 L79 81 L59 98 M194 61 L177 82 L198 99',3);
 }
 if(cat.id==='maine-coon'){
 s+=p('M109 68 L117 100 L125 83 L134 101 L145 69Z',ink)+stroke('M51 138 L72 145 M47 150 L71 156 M204 138 L184 145 M208 153 L184 160');
 s+=stroke('M92 190 L106 201 M113 194 L121 207 M137 195 L137 207 M153 192 L150 204',2.5);
 }
 if(cat.id==='turkish-van')s+=p('M50 106 Q47 63 56 39 Q82 43 100 70 L106 105 Q76 119 50 106Z',ink)+p('M159 74 Q180 48 205 45 Q212 79 205 108 Q185 117 168 105Z',ink);
 if(cat.id==='dsh')s+=stroke('M101 80 Q127 70 155 80 M104 87 Q127 78 152 87 M108 94 Q128 85 147 94',2.5);
 if(cat.id==='dragon-li')s+=p('M102 73 L110 104 L119 85 L128 104 L139 84 L147 104 L155 74Z',ink)+p('M45 127 L74 137 L68 146 L43 141Z',ink)+p('M48 156 L75 160 L74 171 L53 171Z',ink)+p('M211 127 L182 137 L188 146 L215 141Z',ink)+p('M211 156 L182 160 L183 171 L205 171Z',ink);
 if(cat.id==='bengal')for(const [x,y] of [[65,114],[58,143],[72,169],[88,89],[173,91],[191,115],[199,144],[185,169]])s+=e(x,y,6,5,'none',`stroke="${ink}" stroke-width="3"`);
 if(cat.id==='golden-chinchilla')s+=stroke('M93 82 L103 87 M108 77 L117 84 M125 75 L132 82 M141 77 L147 85 M155 82 L160 89',3);
 // Eight quiet expressions, readable when reduced.
 const lightEyes=cat.id==='siamese'||cat.id==='ragdoll'; const eyeInk=lightEyes?'#FFFEF8':ink;
 if(cat.id==='turkish-van') s+=stroke('M79 137 Q92 125 105 137 M153 137 Q166 125 178 137',3.6);
 else if(cat.id==='maine-coon')s+=p('M78 127 L108 132 Q94 148 78 127Z',ink)+p('M149 132 L179 126 Q166 148 149 132Z',ink)+c(94,134,2.5,'#FFFEF8')+c(163,134,2.5,'#FFFEF8');
 else if(cat.id==='bengal') s+=stroke('M80 134 Q93 125 105 132',3.8)+e(166,132,5.5,10,ink);
 else {
 s+=e(92,132,lightEyes?9:5.5,lightEyes?11:10,eyeInk)+e(165,132,lightEyes?9:5.5,lightEyes?11:10,eyeInk);
 if(lightEyes)s+=e(94,132,3,8,ink)+e(167,132,3,8,ink);
 }
 if(lightEyes)s+=e(112,166,21,16,'#FFFEF8')+e(144,166,21,16,'#FFFEF8');
 s+=p('M121 156 Q128 153 135 156 L128 163Z',ink)+stroke('M128 163 L128 169 Q120 176 114 169 M128 169 Q137 176 143 169',2.7);
 s+=stroke('M57 153 L80 157 M55 165 L79 166 M177 157 L201 153 M178 167 L202 167',2);
 if(cat.id==='dsh')s+=stroke('M90 194 Q127 210 166 194',2);
 if(cat.id==='golden-chinchilla')s+=stroke('M77 184 L81 190 M86 190 L90 196 M170 190 L166 196 M179 184 L175 190',2);
 return svg(cat,'纸上墨线',s);
}
const palettes=[
 ['#E7DED0','#EAE8DC','#6D6580','#BDB2CB','#CE7352','#293A42'],
 ['#E2E6D4','#7E8B75','#46554B','#AFC09A','#D9A851','#263931'],
 ['#DBE5E8','#E7CA9D','#4C5963','#A6C9D1','#DC754D','#273944'],
 ['#EBDFD2','#F4ECDA','#C66C43','#DCAF6F','#8F8A9B','#373E3A'],
 ['#DDE5DF','#809EAD','#4A6D7D','#C4D0C6','#D19B4F','#2A4857'],
 ['#E8DFC8','#AA9168','#66553B','#D8C6A6','#72917C','#303F35'],
 ['#EBDAC9','#CC9452','#754A31','#E8BA7F','#769589','#3B493B'],
 ['#E7E1C6','#D5B36B','#A88B42','#F5E8BE','#6E9380','#374E40']
];
function geo(cat,i){
 const [bg,fur,dark,light,accent,ink]=palettes[i];
 let s=`<rect width="256" height="256" rx="58" fill="${bg}"/>`;
 // A printed-paper circular field creates a markedly graphic third family.
 s+=c(128,130,104,light,'opacity=".55"');
 const isLean=cat.id==='siamese', isMaine=cat.id==='maine-coon';
 if(isLean){
 s+=p('M35 37 L99 82 L128 69 L160 83 L225 36 L204 123 L196 174 L128 220 L57 174 L50 121Z',fur);
 s+=p('M36 38 L94 82 L60 112Z',dark)+p('M225 37 L164 83 L197 113Z',dark);
 s+=p('M65 115 L128 87 L192 115 L179 169 L128 207 L77 169Z',dark);
 }else if(isMaine){
 s+=p('M43 32 L90 70 L169 70 L211 31 L208 107 L227 132 L212 151 L225 175 L194 183 L175 207 L128 224 L80 205 L59 183 L29 173 L44 150 L29 131 L46 108Z',fur);
 s+=p('M44 34 L87 71 L56 98Z',dark)+p('M210 34 L170 71 L201 99Z',dark);
 s+=p('M53 152 L76 164 L63 175 L46 163Z',dark)+p('M204 153 L181 164 L195 175 L213 163Z',dark);
 }else{
 let cheek=cat.id==='dsh'||cat.id==='golden-chinchilla'?44:53;
 s+=p(`M51 40 L98 70 L158 70 L205 40 L211 109 L218 152 L199 188 L162 214 L94 214 L57 188 L${cheek-6} 151 L45 110Z`,fur);
 s+=p('M52 42 L92 74 L58 101Z',dark)+p('M204 43 L166 75 L201 101Z',dark);
 }
 // An asymmetrical side plane gives the geometric portraits depth without gradients.
 s+=p('M128 74 L158 74 L203 113 L210 155 L193 186 L161 210 L128 216Z',dark,'opacity=".16"');
 if(cat.id==='ragdoll')s+=p('M56 105 L92 84 L109 119 L98 153 L61 145Z',dark)+p('M160 84 L199 106 L194 145 L156 154 L146 119Z',dark)+p('M128 81 L103 155 L128 172 L153 155Z',fur);
 if(cat.id==='turkish-van')s+=p('M52 42 L98 70 L105 107 L72 127 L47 107Z',dark)+p('M157 70 L205 42 L209 109 L184 124 L165 104Z',dark);
 if(cat.id==='maine-coon'||cat.id==='dragon-li')s+=p('M102 74 L111 105 L124 84 L136 106 L152 74Z',dark);
 if(cat.id==='dragon-li')s+=p('M46 127 L79 140 L72 150 L44 143Z',dark)+p('M48 158 L77 166 L74 176 L54 172Z',dark)+p('M210 127 L178 140 L184 150 L212 143Z',dark)+p('M208 158 L179 166 L183 177 L202 173Z',dark);
 if(cat.id==='bengal')for(const [x,y]of [[62,119],[58,151],[75,176],[91,89],[170,91],[194,119],[199,151],[183,176]])s+=p(`M${x} ${y-6} L${x+7} ${y-1} L${x+3} ${y+7} L${x-6} ${y+4} L${x-7} ${y-3}Z`,dark);
 if(cat.id==='dsh')s+=p('M99 76 L128 99 L158 76Z',dark,'opacity=".6"');
 if(cat.id==='golden-chinchilla')s+=p('M88 82 L103 93 L128 82 L154 94 L170 83 L158 73 L99 73Z',dark);
 const ex=cat.id==='siamese'?16:17;
 if(cat.id==='turkish-van'){
 s+=line('M76 135 L92 126 L108 135 M149 135 L165 126 L181 135',ink,5);
 }else {
 for(const x of [92,164]){
 s+=p(`M${x-ex} 131 Q${x} 114 ${x+ex} 131 Q${x} 149 ${x-ex} 131Z`,cat.id==='ragdoll'||cat.id==='siamese'?'#BCD9DF':accent);
 s+=`<rect x="${x-3.5}" y="122" width="7" height="20" rx="3.5" fill="${ink}"/>`;
 }
 }
 s+=p('M94 155 L128 147 L163 156 L154 185 L128 197 L102 184Z','#F4EAD4');
 s+=p('M120 155 L137 155 L128 165Z',ink)+line('M128 165 L128 174 L115 179 M128 174 L141 179',ink,2.8);
 if(isMaine)s+=p('M95 191 L128 204 L162 191 L149 214 L128 225 L106 214Z','#E5DDC7');
 s+=p('M47 151 L74 156 L72 160Z',ink,'opacity=".7"')+p('M208 151 L182 157 L185 161Z',ink,'opacity=".7"');
 return svg(cat,'几何剪影',s);
}
for(const [style,render] of Object.entries({soft,mono,geo})){
 mkdirSync(resolve(root,style),{recursive:true});
 cats.forEach((cat,i)=>writeFileSync(resolve(root,style,cat.id+'.svg'),render(cat,i)));
}
console.log('Created 24 original SVG cat portraits: soft, mono, geo.');
