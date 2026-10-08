import {expect,test} from 'bun:test'
import React from 'react'
import {render} from 'ink-testing-library'
import {IndexDb} from '../src/core/db'
import {DEFAULT_CONFIG} from '../src/config'
import {App} from '../src/tui/App'
import type {SessionRef} from '../src/types'
const now=1800000000000
const tick=()=>new Promise(resolve=>setTimeout(resolve,40))
function setup(){
 const db=IndexDb.open(':memory:')
 const ref:SessionRef={uid:'claude:a',client:'claude',nativeId:'a',cwd:'/proj',gitBranch:'main',title:'Session title',startedAt:now-1000,endedAt:now,turns:2,parentNativeId:null,tier:'search',origin:'manifest',sourcePaths:[],fingerprint:''}
 db.upsertRef(ref);db.upsertDoc({ref,prompts:['tenant retries'],prose:['latest retained reply'],files:['src/a.ts'],truncated:false})
 return {db,ref}
}
test('stacked preview wraps both summaries within its available space',async()=>{
 const {db,ref}=setup()
 db.upsertDoc({ref,prompts:['request '.repeat(10)+'request end'],prose:['response '.repeat(9)+'reply end'],files:[],truncated:false})
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={24} columns={80}/>)
 await tick()
 expect(view.lastFrame()).toContain('request end')
 expect(view.lastFrame()).toContain('reply end')
 view.unmount();db.close()
})
test('action/help/filter dialogs preserve query and printable input',async()=>{
 const {db}=setup();const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={16} columns={80}/>)
 await tick();view.stdin.write('ten');await tick();expect(view.lastFrame()).toContain('1 session')
 view.stdin.write('\x0b');await tick();expect(view.lastFrame()).toContain('Actions')
 view.stdin.write('\x1b');await tick();expect(view.lastFrame()).toContain('ten')
 view.stdin.write('\x07');await tick();expect(view.lastFrame()).toContain('Filters')
 view.stdin.write('\x1b');await tick();view.stdin.write('?');await tick();expect(view.lastFrame()).toContain('ten?')
 view.unmount();db.close()
})
test('wide picker retains full-width session text and reader uses full screen',async()=>{
 const {db,ref}=setup()
 db.upsertRef({...ref,title:'A useful session title '.repeat(4)+'VISIBLE_END'})
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={24} columns={160}/>)
 await tick()
 expect(view.lastFrame()).toContain('VISIBLE_END')
 view.stdin.write('\x0f');await tick();expect(view.lastFrame()).toContain('History')
 expect(view.lastFrame()).toContain('Ctrl+F')
 view.stdin.write('\x1b');await tick();expect(view.lastFrame()).toContain('1 session')
 view.unmount();db.close()
})

test('stats follow visible results and collapse without losing search or selection',async()=>{
 const {db,ref}=setup()
 db.upsertRef({...ref,uid:'codex:b',client:'codex',nativeId:'b',title:'Other session'})
 db.upsertDoc({ref:{...ref,uid:'codex:b',client:'codex',nativeId:'b'},prompts:['other'],prose:[],files:[],truncated:false})
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={24} columns={160}/>)
 await tick();expect(view.lastFrame()).toContain('Current results');expect(view.lastFrame()).toContain('Last 7 days')
 view.stdin.write('tenant');await tick();expect(view.lastFrame()).toContain('1 session')
 view.stdin.write('\x13');await tick();expect(view.lastFrame()).not.toContain('Current results');expect(view.lastFrame()).toContain('tenant')
 view.stdin.write('\x13');await tick();expect(view.lastFrame()).toContain('Current results');expect(view.lastFrame()).toContain('Session title')
 view.rerender(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={24} columns={120}/>)
 await tick();expect(view.lastFrame()).not.toContain('Current results')
 view.unmount();db.close()
})

test('native preflight failures remain in picker and unavailable launcher asks stay visible',async()=>{
 const {db,ref}=setup();db.upsertRef({...ref,tier:'resume'})
 const {buildAdapter}=await import('../src/core/adapter')
 const {validateManifest}=await import('../src/manifests/load')
 const adapter=buildAdapter(validateManifest({schema:1,id:'claude',name:'Claude',roots:['/none'],format:'jsonl-transcript',tier:'resume',jsonl:{glob:'*.jsonl',variant:'claude'},resume:{cmd:'claude',args:['--resume','{id}'],cwd:'{cwd}'}}))
 let launched=false
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[adapter]} cwd="/" now={now} onExec={()=>{launched=true}} checkResumePlan={()=>({ok:false,reason:'Directory unavailable'})} rows={16}/>)
 await tick();view.stdin.write('\r');await tick()
 expect(launched).toBe(false);expect(view.lastFrame()).toContain('Directory unavailable')
 view.unmount();db.close()
})

test('F1 help returns to reader and filter draft without replacing context',async()=>{
 const {db}=setup();const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={16} columns={80}/>)
 await tick();view.stdin.write('\x0f');await tick();view.stdin.write('\x1bOP');await tick()
 expect(view.lastFrame()).toContain('History help');view.stdin.write('\x1b');await tick();expect(view.lastFrame()).toContain('History ·')
 view.stdin.write('\x1b');await tick();view.stdin.write('\x07');await tick();view.stdin.write('/draft');await tick()
 view.stdin.write('\x1bOP');await tick();expect(view.lastFrame()).toContain('Filter help')
 view.stdin.write('\x1b');await tick();expect(view.lastFrame()).toContain('/draft')
 view.unmount();db.close()
})

test('picker frames stay bounded across 25 terminal sizes',async()=>{
 const {db}=setup()
 for(const columns of [40,60,80,120,160])for(const rows of [8,12,16,24,40]){
  const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={rows} columns={columns}/>)
  await tick();const frame=view.lastFrame()!
  expect(frame.split('\n').length).toBeLessThanOrEqual(rows)
  for(const line of frame.split('\n'))expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns)
  view.unmount()
 }
 db.close()
})

test('bookmark persistence failures keep prior state and stale UIDs remain removable',async()=>{
 const {db}=setup();let uids=['stale:uid'];let fail=true
 const store={load:()=>({state:{version:1 as const,uids:[...uids]},warning:null,writable:true}),
 set:async(uid:string,enabled:boolean)=>{if(fail)throw new Error('Disk full');uids=enabled?[...uids,uid]:uids.filter(item=>item!==uid);return {version:1 as const,uids:[...uids]}},
 remove:async(uid:string)=>{uids=uids.filter(item=>item!==uid);return {version:1 as const,uids:[...uids]}}}
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} bookmarkStore={store} rows={16} columns={80}/>)
 await tick();view.stdin.write('\x02');await tick();expect(uids).toEqual(['stale:uid']);expect(view.lastFrame()).toContain('Disk full')
 fail=false;view.stdin.write('\x02');await tick();expect(uids).toEqual(['stale:uid','claude:a']);expect(view.lastFrame()).toContain('★')
 view.stdin.write('\x0b');await tick();view.stdin.write('Manage bookmarks');await tick();view.stdin.write('\r');await tick()
 expect(view.lastFrame()).toContain('stale:uid (unavailable)');view.stdin.write('\r');await tick();expect(uids).toEqual(['claude:a'])
 view.unmount();db.close()
})

test('indexed sessions excluded by client filter are not reported as an empty index',async()=>{
 const {db}=setup()
 const view=render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[]} cwd="/" now={now} onExec={()=>{}} rows={16} columns={80}
 initialState={{text:'',filters:{scope:null,client:'missing',time:{kind:'preset',preset:'all'},sort:'auto',bookmarkedOnly:false},selectedUid:null,selectedIndex:0,listTop:0,reader:null}}/>)
 await tick();expect(view.lastFrame()).toContain('No sessions match these filters')
 view.stdin.write('\x0b');await tick();expect(view.lastFrame()).toContain('Show all clients');view.stdin.write('\r');await tick();expect(view.lastFrame()).toContain('1 session')
 view.unmount();db.close()
})
