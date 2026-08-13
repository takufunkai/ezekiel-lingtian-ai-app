#!/usr/bin/env tsx
/**
 * The stupidest possible results frontend: `npm run ui`, open the printed URL.
 *
 * Storage is a directory of JSON files (`results/`). Every schema-valid profile
 * dropped there — by hand, by `reconcile --out results/foo.json`, or pasted into
 * the page's Import box — shows up in the list. No database, no build step.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tryReadJsonFile, validateProfile, formatSchemaErrors } from "../src/schema.js";

const PORT = Number(process.env.PORT || 4177);
const DIR = join(process.cwd(), "results");
mkdirSync(DIR, { recursive: true });
// Seed: if a fresh `out.json` sits in the repo root and the store is empty, adopt it.
if (existsSync("out.json") && readdirSync(DIR).length === 0) {
  copyFileSync("out.json", join(DIR, "out.json"));
}

function listResults() {
  return readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const parsed = tryReadJsonFile(join(DIR, f));
      const check = parsed.ok ? validateProfile(parsed.data) : null;
      return {
        file: f,
        mtime: statSync(join(DIR, f)).mtimeMs,
        error: !parsed.ok ? parsed.error : check && !check.valid ? "schema-invalid" : null,
        profile: check?.valid ? check.data : null,
      };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/api/results") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(listResults()));
  }
  if (req.method === "POST" && req.url === "/api/results") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      let data: unknown;
      try {
        data = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: "not valid JSON" }));
      }
      const check = validateProfile(data);
      if (!check.valid) {
        res.statusCode = 422;
        return res.end(
          JSON.stringify({
            error: "schema violations (rejected, not patched)",
            details: formatSchemaErrors(check.errors).slice(0, 5),
          }),
        );
      }
      const slug = check.data.entity.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .slice(0, 40);
      const file = `${slug}-${Date.now()}.json`;
      writeFileSync(join(DIR, file), JSON.stringify(check.data, null, 2));
      res.end(JSON.stringify({ ok: true, file }));
    });
    return;
  }
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.end(PAGE);
});

const PAGE = /* html */ `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Reconciled Profiles</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1c1b19;--mut:#77736b;--line:#e5e2db;--acc:#0e7c66;--warn:#b4552d;--warnbg:#fbeee7;--accbg:#e9f4f1}
@media(prefers-color-scheme:dark){:root{--bg:#171614;--card:#201f1c;--ink:#ece9e3;--mut:#9b968c;--line:#33312c;--acc:#4cc2a7;--warn:#e08d63;--warnbg:#3a251a;--accbg:#1d332d}}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--ink);font:15px/1.55 ui-sans-serif,system-ui,sans-serif}
header{padding:20px 28px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:baseline}
header h1{font-size:18px}header small{color:var(--mut)}
main{display:grid;grid-template-columns:320px 1fr;min-height:calc(100vh - 62px)}
#list{border-right:1px solid var(--line);padding:16px;overflow-y:auto}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin-bottom:10px;cursor:pointer}
.card:hover,.card.sel{border-color:var(--acc)}.card h3{font-size:14px}.card p{font-size:12px;color:var(--mut)}
.badge{display:inline-block;font-size:11px;border-radius:99px;padding:1px 8px;margin-left:6px;background:var(--accbg);color:var(--acc)}
.badge.w{background:var(--warnbg);color:var(--warn)}
#detail{padding:26px 34px;max-width:820px}#detail h2{font-size:22px;margin-bottom:2px}
.meta{color:var(--mut);font-size:13px;margin-bottom:22px}
section{margin-bottom:26px}section>h4{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--mut);margin-bottom:10px}
.grp{background:var(--card);border:1px solid var(--line);border-left:3px solid var(--acc);border-radius:8px;padding:12px 16px;margin-bottom:10px}
.grp.disp{border-left-color:var(--warn)}.grp .q{font-weight:600;font-size:14px;margin-bottom:6px}
.claim{margin:6px 0 6px 4px;padding-left:10px;border-left:2px solid var(--line);font-size:14px}
.cite{font-size:11px;background:var(--accbg);color:var(--acc);border-radius:5px;padding:0 6px;margin-left:5px;white-space:nowrap;text-decoration:none}
.src{font-size:13px;color:var(--mut);margin:3px 0}.src b{color:var(--ink)}
textarea{width:100%;height:70px;background:var(--card);color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px;font:12px ui-monospace,monospace}
button{background:var(--acc);color:#fff;border:0;border-radius:7px;padding:6px 14px;font-size:13px;cursor:pointer;margin-top:6px}
#msg{font-size:12px;color:var(--warn);margin-top:4px}.empty{color:var(--mut);padding:40px;text-align:center}
</style></head><body>
<header><h1>Reconciled Profiles</h1><small>filesystem-backed · results/</small></header>
<main><div id="list"></div><div id="detail"><p class="empty">Select a result</p></div></main>
<script>
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
let items=[],sel=null;
async function load(){items=await (await fetch("/api/results")).json();renderList();
  if(items.length&&!sel){pick(items.find(i=>i.profile)?.file)}}
function renderList(){
  const cards=items.map(i=>{
    if(!i.profile)return '<div class="card"><h3>'+esc(i.file)+'</h3><p>unreadable: '+esc(i.error)+'</p></div>';
    const d=i.profile.groups.filter(g=>g.status==="disputed").length;
    return '<div class="card'+(sel===i.file?" sel":"")+'" onclick="pick(\\''+esc(i.file)+'\\')">'+
      '<h3>'+esc(i.profile.entity.name)+(d?'<span class="badge w">'+d+' disputed</span>':'<span class="badge">clean</span>')+'</h3>'+
      '<p>'+esc(i.profile.model||"hand-written")+' · '+esc(i.profile.claims.length)+' claims · '+new Date(i.profile.generatedAt).toLocaleString()+'</p></div>';
  }).join("");
  document.getElementById("list").innerHTML=cards+
    '<div class="card"><h3>Import result</h3><textarea id="paste" placeholder="paste a reconciled profile JSON"></textarea>'+
    '<button onclick="imp()">Store</button><div id="msg"></div></div>';
}
function pick(f){sel=f;renderList();const p=items.find(i=>i.file===f)?.profile;if(!p)return;
  const claim=id=>p.claims.find(c=>c.id===id);
  const claimHtml=c=>c?'<div class="claim">'+esc(c.text)+c.citations.map(x=>'<a class="cite" href="#src-'+esc(x.sourceId)+'" title="'+esc(x.quote)+'">'+esc(x.sourceId)+'</a>').join("")+'</div>':"";
  const grp=g=>'<div class="grp'+(g.status==="disputed"?" disp":"")+'"><div class="q">'+esc(g.question)+'</div>'+g.claimIds.map(id=>claimHtml(claim(id))).join("")+'</div>';
  const agreed=p.groups.filter(g=>g.status==="agreed"),disp=p.groups.filter(g=>g.status==="disputed");
  document.getElementById("detail").innerHTML=
    '<h2>'+esc(p.entity.name)+'</h2><div class="meta">'+esc((p.entity.aliases||[]).join(", "))+
    (p.entity.aliases?.length?" · ":"")+esc(p.model||"hand-written")+' · '+esc(p.generatedAt)+'</div>'+
    (disp.length?'<section><h4>⚠ Disputed ('+disp.length+')</h4>'+disp.map(grp).join("")+'</section>':"")+
    '<section><h4>Agreed ('+agreed.length+')</h4>'+agreed.map(grp).join("")+'</section>'+
    '<section><h4>Sources</h4>'+p.sources.map(s=>'<p class="src" id="src-'+esc(s.id)+'"><b>'+esc(s.id)+'</b> · '+esc(s.date)+' · '+esc(s.title)+'</p>').join("")+'</section>';
}
async function imp(){const r=await fetch("/api/results",{method:"POST",body:document.getElementById("paste").value});
  const j=await r.json();document.getElementById("msg").textContent=j.error?j.error+(j.details?": "+j.details.join("; "):""):"stored ✓";if(j.ok)load();}
load();setInterval(load,4000);
</script></body></html>`;

server.listen(PORT, () =>
  console.log(`results ui → http://localhost:${PORT}  (storing in ${DIR})`),
);
