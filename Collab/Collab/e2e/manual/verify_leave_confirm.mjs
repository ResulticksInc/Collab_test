// Confirm-before-exit for meetings AND calls: clicking Leave opens a
// confirmation ("Leave this meeting?"); "Stay" keeps you in; only "Leave"
// exits. Browser check (single participant meeting is enough — the exit
// control is identical for all). BASE = frontend.
import { createRequire } from "module";
const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const BASE = process.env.BASE || "http://localhost:3002";
const ts = Date.now(); const PW = "Passw0rd!123";
let pass=0, fail=0; const ok=(n,c,e="")=>{ if(c){pass++;console.log("  PASS "+n)}else{fail++;console.log("  FAIL "+n+"  "+e)} };
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const call=async(m,p,t,b)=>{const r=await fetch(BASE+p,{method:m,headers:{"Content-Type":"application/json",...(t?{Authorization:"Bearer "+t}:{})},body:b?JSON.stringify(b):undefined});let j=null;try{j=await r.json()}catch{};return{status:r.status,j}};
const u=(await call("POST","/api/auth/signup",null,{email:`lc-${ts}@t.local`,password:PW,name:"Leave Tester"})).j.data;
const mtg=await call("POST","/api/meetings",u.token,{title:`Leave ${ts}`,startsAt:new Date(Date.now()+90000).toISOString(),durationMin:60,attendees:[]});
const mid=mtg.j.data.id;
const browser=await chromium.launch({headless:false,args:["--use-fake-device-for-media-capture","--autoplay-policy=no-user-gesture-required","--hide-crash-restore-bubble"]});
const page=await(await browser.newContext({viewport:{width:1300,height:900},permissions:["microphone","camera"]})).newPage();
await page.goto(BASE+"/"); await page.fill('input[type="email"]',u.user.email); await page.fill('input[type="password"]',PW); await page.keyboard.press("Enter");
try{const sk=page.locator('button:has-text("Continue without an organization")');await sk.waitFor({state:"visible",timeout:12000});await sk.click()}catch{}
await page.waitForSelector("#rail",{timeout:60000}); await sleep(5000);
await page.goto(`${BASE}/?meeting=${mid}`); await page.waitForSelector(".pj-overlay-v2",{timeout:45000}); await page.click(".pj-join-v2");
await page.waitForSelector(".ms-wrap",{timeout:45000}); await sleep(2500);
console.log("on stage");

// Click Leave → confirmation dialog appears, still on stage.
await page.click(".ms-dock-leave");
await sleep(800);
const dlg = await page.evaluate(() => {
  const modal = document.querySelector('[role="dialog"], .modal, .cv-modal, .dlg');
  const txt = (document.body.innerText || "");
  return { hasLeavePrompt: /Leave this meeting\?/i.test(txt), stayBtn: !![...document.querySelectorAll("button")].find(b=>/^Stay$/i.test(b.textContent.trim())), stillStage: !!document.querySelector(".ms-wrap") };
});
ok("confirmation prompt appears on Leave", dlg.hasLeavePrompt, JSON.stringify(dlg));
ok("a 'Stay' option is offered", dlg.stayBtn);
ok("still in the meeting while the prompt is open", dlg.stillStage);

// Click Stay → dialog closes, still on stage.
await page.click('button:has-text("Stay")');
await sleep(1000);
ok("'Stay' keeps you in the meeting", await page.evaluate(() => !!document.querySelector(".ms-wrap") && !/Leave this meeting\?/i.test(document.body.innerText)));

// Click Leave again → confirm Leave → actually exits. The dialog's confirm
// button is the LAST "Leave" button in the DOM (dock has one too), so click by
// evaluating within the modal footer.
await page.click(".ms-dock-leave");
await sleep(800);
await page.evaluate(() => {
  const btns = [...document.querySelectorAll('[role="dialog"] button, .modal button, [style*="z-index: 15000"] button, [style*="z-index:15000"] button')];
  const leave = btns.reverse().find((b) => /^Leave$/i.test(b.textContent.trim()));
  (leave || [...document.querySelectorAll("button")].reverse().find((b)=>/^Leave$/i.test(b.textContent.trim()))).click();
});
await sleep(2500);
ok("confirming 'Leave' exits the meeting", await page.evaluate(() => !document.querySelector(".ms-wrap")));

await browser.close();
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
