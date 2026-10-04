import express from "express";
import crypto from "crypto";
import QRCode from "qrcode";

const app = express();
app.set("trust proxy", true);
app.use(express.json({ limit: "256kb" }));

const PORT = process.env.PORT || 10000;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const MASTER_KEY = process.env.BROKER_MASTER_KEY || "";
const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
const EXTRA_SCOPES = "openid email";
const MOBILE_SCHEME = "solymail25";

function configured() { return Boolean(CLIENT_ID && CLIENT_SECRET && MASTER_KEY); }
function keyBytes() {
  const b = Buffer.from(MASTER_KEY, "base64url");
  if (b.length !== 32) throw new Error("BROKER_MASTER_KEY must decode to 32 bytes");
  return b;
}
function origin(req) { return `${req.protocol}://${req.get("host")}`; }
function esc(s="") {
  return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));
}
function signState(payload) {
  const raw = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", keyBytes()).update(raw).digest("base64url");
  return raw + "." + sig;
}
function verifyState(state) {
  const [raw, sig] = String(state || "").split(".");
  if (!raw || !sig) throw new Error("Bad OAuth state");
  const expected = crypto.createHmac("sha256", keyBytes()).update(raw).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !crypto.timingSafeEqual(got, expected)) throw new Error("Invalid OAuth state");
  const obj = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  if (!obj.exp || Date.now() > obj.exp) throw new Error("OAuth state expired");
  return obj;
}
function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", keyBytes(), iv);
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj))), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}
function unseal(token) {
  const all = Buffer.from(String(token || ""), "base64url");
  if (all.length < 29) throw new Error("Invalid bundle");
  const iv = all.subarray(0,12), tag = all.subarray(12,28), enc = all.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", keyBytes(), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8"));
}
async function postForm(url, params) {
  const r = await fetch(url,{method:"POST",headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams(params)});
  const text = await r.text(); let data;
  try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!r.ok) throw new Error(`Google token error ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function exchangeCode(code, redirectUri) {
  return postForm("https://oauth2.googleapis.com/token",{code,client_id:CLIENT_ID,client_secret:CLIENT_SECRET,redirect_uri:redirectUri,grant_type:"authorization_code"});
}
async function refreshAccess(refreshToken) {
  const data = await postForm("https://oauth2.googleapis.com/token",{client_id:CLIENT_ID,client_secret:CLIENT_SECRET,refresh_token:refreshToken,grant_type:"refresh_token"});
  if (!data.access_token) throw new Error("No access token returned");
  return data.access_token;
}
async function googleJson(url, accessToken, opts={}) {
  const r = await fetch(url,{...opts,headers:{"authorization":`Bearer ${accessToken}`,"accept":"application/json",...(opts.body?{"content-type":"application/json"}:{}),...(opts.headers||{})}});
  const text=await r.text(); let data;
  try { data=JSON.parse(text); } catch { data={raw:text}; }
  if (!r.ok) throw new Error(`Gmail API ${r.status}: ${JSON.stringify(data)}`);
  return data;
}
async function profileWithAccess(accessToken) { return googleJson("https://gmail.googleapis.com/gmail/v1/users/me/profile",accessToken); }
async function sessionFromBundle(bundle) {
  if (!configured()) throw new Error("Broker OAuth is not configured yet");
  const sealed=unseal(bundle);
  if (!sealed.refresh_token || !sealed.email) throw new Error("Bundle is incomplete");
  const accessToken=await refreshAccess(sealed.refresh_token);
  return {...sealed,accessToken};
}
function header(payload,name) {
  const h=(payload?.headers||[]).find(x=>String(x.name||"").toLowerCase()===name.toLowerCase());
  return h?.value||"";
}
function decodeB64Url(data="") {
  try { return Buffer.from(data.replace(/-/g,"+").replace(/_/g,"/"),"base64").toString("utf8"); } catch { return ""; }
}
function extractBody(part,wanted) {
  if (!part) return "";
  if (part.mimeType===wanted && part.body?.data) return decodeB64Url(part.body.data);
  for (const p of part.parts||[]) { const x=extractBody(p,wanted); if (x) return x; }
  return "";
}
function stripHtml(html="") {
  return html.replace(/<style[\s\S]*?<\/style>/gi," ").replace(/<script[\s\S]*?<\/script>/gi," ").replace(/<[^>]+>/g," ").replace(/&nbsp;/g," ").replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/\s+/g," ").trim();
}

app.get("/",(req,res)=>res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Soly Mail Broker</title><style>body{font-family:system-ui;margin:40px;background:#0f172a;color:white}main{max-width:720px;margin:auto;background:#111827;padding:28px;border-radius:24px}.ok{color:#4ade80}.bad{color:#f87171}code{background:#1f2937;padding:3px 7px;border-radius:7px}</style></head><body><main><h1>Soly Mail Broker</h1><p>External Google OAuth + Gmail relay for Soly Mail 25.</p><p>Status: <b class="${configured()?"ok":"bad"}">${configured()?"READY":"WAITING FOR GOOGLE OAUTH CREDENTIALS"}</b></p><p>Callback URL: <code>${esc(origin(req)+"/oauth/callback")}</code></p><p>No Gmail password is collected or stored by this service.</p></main></body></html>`));
app.get("/health",(req,res)=>res.json({ok:true,configured:configured(),service:"soly-mail-broker"}));

app.get("/oauth/start",(req,res)=>{
  try{
    if(!configured()) return res.status(503).send("Soly Mail Broker is not configured with Google OAuth credentials yet.");
    const redirectUri=origin(req)+"/oauth/callback";
    const state=signState({exp:Date.now()+10*60*1000,nonce:crypto.randomBytes(16).toString("hex")});
    const q=new URLSearchParams({client_id:CLIENT_ID,redirect_uri:redirectUri,response_type:"code",scope:`${GMAIL_SCOPE} ${EXTRA_SCOPES}`,access_type:"offline",prompt:"consent",include_granted_scopes:"true",state});
    res.redirect("https://accounts.google.com/o/oauth2/v2/auth?"+q.toString());
  }catch(e){res.status(500).send("Start error: "+esc(e.message));}
});

app.get("/oauth/callback",async(req,res)=>{
  try{
    verifyState(req.query.state);
    if(!req.query.code) throw new Error("Missing authorization code");
    const redirectUri=origin(req)+"/oauth/callback";
    const token=await exchangeCode(req.query.code,redirectUri);
    if(!token.refresh_token) throw new Error("Google did not return a refresh token.");
    const profile=await profileWithAccess(token.access_token);
    const email=profile.emailAddress||"";
    if(!email) throw new Error("Could not read Gmail profile");
    const bundle=seal({v:1,email,refresh_token:token.refresh_token,created_at:Date.now()});
    const deepLink=`${MOBILE_SCHEME}://link?broker=${encodeURIComponent(origin(req))}&bundle=${encodeURIComponent(bundle)}`;
    const qr=await QRCode.toDataURL(deepLink,{width:340,margin:2,errorCorrectionLevel:"M"});
    res.set("Content-Security-Policy","default-src 'none'; img-src data:; style-src 'unsafe-inline';");
    res.type("html").send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Linked — Soly Mail 25</title><style>body{font-family:system-ui;background:#f5f7fb;color:#111827;margin:0;padding:24px}.card{max-width:560px;margin:20px auto;background:white;border-radius:28px;padding:28px;text-align:center;box-shadow:0 12px 40px #0001}img{width:min(340px,90vw);height:auto}.email{font-weight:800;font-size:20px}.small{color:#6b7280;line-height:1.6}</style></head><body><div class="card"><h1>تم ربط Gmail ✅</h1><div class="email">${esc(email)}</div><p class="small">امسح الـQR بالموبايل. هيُفتح Soly Mail 25 ويستورد الحساب بدون إدخال كلمة السر على الموبايل.</p><img src="${qr}" alt="Soly Mail link QR"><p class="small">لا تشارك الـQR؛ هو مفتاح الربط للحساب داخل Soly Mail.</p></div></body></html>`);
  }catch(e){res.status(400).type("html").send(`<h2>تعذر الربط</h2><pre>${esc(e.message)}</pre>`);}
});

app.post("/api/profile",async(req,res)=>{try{const s=await sessionFromBundle(req.body?.bundle);const p=await profileWithAccess(s.accessToken);res.json({ok:true,email:p.emailAddress||s.email,messagesTotal:p.messagesTotal||0,threadsTotal:p.threadsTotal||0});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.post("/api/list",async(req,res)=>{try{const s=await sessionFromBundle(req.body?.bundle);const max=Math.min(Math.max(Number(req.body?.max||30),1),50);const q=new URLSearchParams({maxResults:String(max)});if(req.body?.label)q.set("labelIds",String(req.body.label));if(req.body?.query)q.set("q",String(req.body.query));const list=await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/messages?"+q.toString(),s.accessToken);const out=[];for(const m of (list.messages||[]).slice(0,max)){const x=await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+encodeURIComponent(m.id)+"?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date",s.accessToken);out.push({id:x.id,threadId:x.threadId,from:header(x.payload,"From"),subject:header(x.payload,"Subject"),date:header(x.payload,"Date"),snippet:x.snippet||""});}res.json({ok:true,email:s.email,messages:out});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.post("/api/full",async(req,res)=>{try{const s=await sessionFromBundle(req.body?.bundle);const id=String(req.body?.id||"");if(!id)throw new Error("Missing message id");const x=await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+encodeURIComponent(id)+"?format=full",s.accessToken);let body=extractBody(x.payload,"text/plain");if(!body)body=stripHtml(extractBody(x.payload,"text/html"));if(!body)body=x.snippet||"";res.json({ok:true,message:{id:x.id,threadId:x.threadId,from:header(x.payload,"From"),to:header(x.payload,"To"),subject:header(x.payload,"Subject"),date:header(x.payload,"Date"),body}});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.post("/api/send",async(req,res)=>{try{const s=await sessionFromBundle(req.body?.bundle);const to=String(req.body?.to||"").trim();if(!to.includes("@"))throw new Error("Invalid destination email");const subject=String(req.body?.subject||""),body=String(req.body?.body||"");const mime=`To: ${to}\r\nSubject: ${subject}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\n${body}`;const raw=Buffer.from(mime,"utf8").toString("base64url");const x=await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/send",s.accessToken,{method:"POST",body:JSON.stringify({raw})});res.json({ok:true,id:x.id,threadId:x.threadId});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.post("/api/modify",async(req,res)=>{try{const s=await sessionFromBundle(req.body?.bundle);const id=String(req.body?.id||"");if(!id)throw new Error("Missing message id");const payload={};if(Array.isArray(req.body?.addLabelIds))payload.addLabelIds=req.body.addLabelIds;if(Array.isArray(req.body?.removeLabelIds))payload.removeLabelIds=req.body.removeLabelIds;await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+encodeURIComponent(id)+"/modify",s.accessToken,{method:"POST",body:JSON.stringify(payload)});res.json({ok:true});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.post("/api/trash",async(req,res)=>{try{const s=await sessionFromBundle(req.body?.bundle);const id=String(req.body?.id||"");if(!id)throw new Error("Missing message id");await googleJson("https://gmail.googleapis.com/gmail/v1/users/me/messages/"+encodeURIComponent(id)+"/trash",s.accessToken,{method:"POST",body:"{}"});res.json({ok:true});}catch(e){res.status(400).json({ok:false,error:e.message});}});
app.listen(PORT,()=>console.log(`Soly Mail Broker listening on ${PORT}`));
