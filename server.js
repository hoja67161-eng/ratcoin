// RATCOIN backend. Node 18+, no dependencies.
// Env: BOT_TOKEN, BASE_URL (https://your.domain), WALLET (your receiving TON address),
//      WEBHOOK_SECRET (any random string), TONCENTER_KEY (optional), PORT, DATA_FILE
"use strict";
const http=require("http"),fs=require("fs"),path=require("path"),crypto=require("crypto");
const {BOT_TOKEN,BASE_URL,WALLET,WEBHOOK_SECRET="",TONCENTER_KEY="",PORT=3000,DATA_FILE="./data.json"}=process.env;
if(!BOT_TOKEN||!BASE_URL||!WALLET){console.error("Set BOT_TOKEN, BASE_URL and WALLET");process.exit(1)}

// ---- Game config (identical to the client) ----
const UNIT=1e5,DAY=864e5,TAPS=500,TAP_RAT=0.81,REF_BONUS=10; // REF_BONUS = RAT the inviter gets per new friend
const COOL_STEPS=[60,55,50,45,40];
const CD_PRICES=[0.20,0.35,0.55,0.80];
const MT_PRICES=[0.10,0.15,0.20,0.30,0.40,0.55,0.75,1.00,1.30,1.75];
const BOT_PACKS=[{d:1,p:0.15},{d:7,p:0.90},{d:30,p:3.00}];

// ---- Storage: in memory, saved to a JSON file ----
let DB={users:{},orders:{},usedTx:{},pendingRef:{}};
try{DB=Object.assign(DB,JSON.parse(fs.readFileSync(DATA_FILE,"utf8")))}catch{}
let dirty=false;const touch=()=>{dirty=true};
function flushDB(){if(!dirty)return;dirty=false;fs.writeFileSync(DATA_FILE+".tmp",JSON.stringify(DB));fs.renameSync(DATA_FILE+".tmp",DATA_FILE)}
setInterval(flushDB,3000);
setInterval(()=>{const cut=Date.now()-7*DAY;for(const k in DB.orders)if(DB.orders[k].exp<cut){delete DB.orders[k];touch()}},36e5);
for(const s of["SIGTERM","SIGINT"])process.on(s,()=>{flushDB();process.exit(0)});

// ---- Telegram initData validation ----
function auth(initData){
 if(!initData)return null;
 const p=new URLSearchParams(initData),hash=p.get("hash");p.delete("hash");
 const str=[...p.entries()].sort(([a],[b])=>a<b?-1:1).map(([k,v])=>k+"="+v).join("\n");
 const secret=crypto.createHmac("sha256","WebAppData").update(BOT_TOKEN).digest();
 const h=crypto.createHmac("sha256",secret).update(str).digest("hex");
 if(!hash||hash.length!==h.length||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(hash)))return null;
 if(Date.now()/1000-Number(p.get("auth_date"))>86400)return null;
 try{return String(JSON.parse(p.get("user")).id)}catch{return null}
}

// ---- Game logic (the server is the only source of truth) ----
const per=u=>Math.round(TAP_RAT*UNIT*(1+u.mt)), coolMs=u=>COOL_STEPS[u.cd]*60000;
function getUser(id){
 let u=DB.users[id];
 if(!u){
  u=DB.users[id]={bal:15*UNIT,mt:0,cd:0,taps:0,cool:0,friends:0,bot:0,botLast:0,botAcc:0};
  const r=DB.pendingRef[id];
  if(r&&r!==id&&DB.users[r]){DB.users[r].friends++;DB.users[r].bal+=REF_BONUS*UNIT}
  delete DB.pendingRef[id];touch();
 }
 return u;
}
function settle(u,now){
 if(u.bot){
  const t=Math.min(now,u.bot),dt=t-u.botLast;
  if(dt>0){
   u.botAcc+=dt/1000*(TAPS*per(u)/(coolMs(u)/1000));
   const w=Math.floor(u.botAcc);if(w>0){u.bal+=w;u.botAcc-=w}
   u.botLast=t;touch();
  }
  if(now>=u.bot){u.bot=0;u.botLast=0;u.botAcc=0;touch()}
 }
 if(u.cool&&now>=u.cool){u.cool=0;u.taps=0;touch()}
}
function tapRound(u,count,now){
 settle(u,now);
 if(u.cool)return;
 const n=Math.min(Math.floor(count),TAPS-u.taps);
 if(!(n>0))return;
 u.taps+=n;u.bal+=n*per(u);
 if(u.taps>=TAPS)u.cool=now+coolMs(u);
 touch();
}

// ---- Orders and TON payment verification ----
// Each order gets an exact amount (price + a unique few nanoTON). A payment that matches
// that amount on the blockchain activates the order. The client can't fake it.
const findOpen=(uid,kind,n)=>Object.values(DB.orders).find(o=>!o.done&&o.uid===uid&&o.kind===kind&&o.n===n&&o.exp>Date.now());
function createOrder(uid,u,kind,n){
 if(kind==="mt"){if(n!==u.mt+1||n>MT_PRICES.length)return null}
 else if(kind==="cd"){if(n!==u.cd+1||n>CD_PRICES.length)return null}
 else if(kind==="bot"){if(!BOT_PACKS[n])return null}
 else return null;
 const now=Date.now(),price=kind==="mt"?MT_PRICES[n-1]:kind==="cd"?CD_PRICES[n-1]:BOT_PACKS[n].p;
 const used=new Set(Object.values(DB.orders).filter(o=>!o.done&&o.exp>now).map(o=>o.amount));
 let amount;do{amount=Math.round(price*1e9)+1+crypto.randomInt(9999)}while(used.has(amount));
 const id=crypto.randomUUID();
 touch();return DB.orders[id]={id,uid,kind,n,amount,created:now,exp:now+15*60000,done:false};
}
let txCache={t:0,list:[]};
async function chainTxs(){
 if(Date.now()-txCache.t<4000)return txCache.list;
 const r=await fetch(`https://toncenter.com/api/v2/getTransactions?address=${WALLET}&limit=100`,{headers:TONCENTER_KEY?{"X-API-Key":TONCENTER_KEY}:{}});
 const j=await r.json();if(!j.ok)throw new Error("toncenter");
 txCache={t:Date.now(),list:j.result};return j.result;
}
async function claim(o){
 if(o.done)return;
 const txs=await chainTxs();
 const tx=txs.find(t=>t.in_msg&&t.in_msg.source&&String(t.in_msg.value)===String(o.amount)&&t.utime*1000>=o.created-30000&&!DB.usedTx[t.transaction_id.hash]);
 if(!tx||o.done)return;                       // (re-check o.done: another request may have finished it meanwhile)
 DB.usedTx[tx.transaction_id.hash]=o.id;o.done=true;
 const u=DB.users[o.uid],now=Date.now();settle(u,now);
 if(o.kind==="mt"&&u.mt<o.n){u.mt=o.n;u.taps=0;u.cool=0}
 else if(o.kind==="cd"&&u.cd<o.n){const diff=coolMs(u)-COOL_STEPS[o.n]*60000;u.cd=o.n;if(u.cool)u.cool=Math.max(now,u.cool-diff)}
 else if(o.kind==="bot"){const p=BOT_PACKS[o.n];if(u.bot>now)u.bot+=p.d*DAY;else{u.bot=now+p.d*DAY;u.botLast=now;u.botAcc=0}}
 touch();
}

// ---- HTTP ----
const send=(res,obj,code=200)=>{res.writeHead(code,{"Content-Type":"application/json"});res.end(JSON.stringify(obj))};
const readBody=req=>new Promise(ok=>{let s="";req.on("data",c=>{s+=c;if(s.length>1e4){s="";req.destroy()}});req.on("end",()=>{try{ok(JSON.parse(s||"{}"))}catch{ok({})}})});

async function handleApi(req,res,name){
 const uid=auth(req.headers["x-init-data"]);
 if(!uid)return send(res,{error:"unauthorized"},401);
 const b=await readBody(req),u=getUser(uid);
 const out=()=>{settle(u,Date.now());return {...u,now:Date.now()}};
 settle(u,Date.now());

 if(name==="state"){
  for(const o of Object.values(DB.orders))if(o.uid===uid&&!o.done&&o.exp+36e5>Date.now()){try{await claim(o)}catch{}}  // pick up late payments
  return send(res,out());
 }
 if(name==="tap"){tapRound(u,Number(b.count),Date.now());return send(res,out())}
 if(name==="order"){
  const kind=String(b.kind),n=Number(b.n),open=findOpen(uid,kind,n);
  if(open){try{await claim(open)}catch{} if(open.done)return send(res,{...out(),done:true})}  // already paid?
  const o=open||createOrder(uid,u,kind,n);
  if(!o)return send(res,{error:"invalid order"},400);
  return send(res,{id:o.id,amount:String(o.amount),wallet:WALLET});
 }
 if(name==="claim"){
  const o=DB.orders[b.id];
  if(!o||o.uid!==uid)return send(res,{error:"no such order"},404);
  try{await claim(o)}catch{}
  return send(res,{...out(),done:o.done});
 }
 send(res,{error:"not found"},404);
}

// Telegram webhook: /start ref_<id> records the referral and shows an "Open" button.
async function tgHook(req,res){
 if(WEBHOOK_SECRET&&req.headers["x-telegram-bot-api-secret-token"]!==WEBHOOK_SECRET){res.writeHead(403);return res.end()}
 const m=(await readBody(req)).message;
 res.writeHead(200);res.end("ok");
 if(!m?.text||!/^\/start/.test(m.text))return;
 const id=String(m.from.id),r=m.text.match(/ref_(\d+)/);
 if(r&&r[1]!==id&&!DB.users[id]){DB.pendingRef[id]=r[1];touch()}
 fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`,{method:"POST",headers:{"Content-Type":"application/json"},
  body:JSON.stringify({chat_id:m.chat.id,text:"⛏️ Welcome to RATCOIN! Tap to mine.",reply_markup:{inline_keyboard:[[{text:"Open RATCOIN",web_app:{url:BASE_URL}}]]}})}).catch(()=>{});
}

const MIME={".html":"text/html; charset=utf-8",".png":"image/png",".json":"application/json",".js":"text/javascript",".svg":"image/svg+xml",".css":"text/css"};
function serveStatic(res,p){
 const root=path.resolve("public"),f=path.join(root,p==="/"?"index.html":decodeURIComponent(p));
 if(!f.startsWith(root+path.sep)||!fs.existsSync(f)||!fs.statSync(f).isFile()){res.writeHead(404);return res.end("Not found")}
 res.writeHead(200,{"Content-Type":MIME[path.extname(f)]||"application/octet-stream","Access-Control-Allow-Origin":"*"}); // wallets fetch the manifest cross-origin
 fs.createReadStream(f).pipe(res);
}

http.createServer(async(req,res)=>{
 try{
  const p=new URL(req.url,"http://x").pathname;
  if(req.method==="POST"&&p==="/tg")return await tgHook(req,res);
  if(req.method==="POST"&&p.startsWith("/api/"))return await handleApi(req,res,p.slice(5));
  serveStatic(res,p);
 }catch(e){console.error(e);if(!res.headersSent)send(res,{error:"server"},500)}
}).listen(PORT,()=>console.log("RATCOIN server on :"+PORT));
