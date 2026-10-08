import {expect,spyOn,test} from 'bun:test'
import React from 'react'
import {render} from 'ink-testing-library'
import {IndexDb} from '../src/core/db'
import {DEFAULT_CONFIG} from '../src/config'
import {App} from '../src/tui/App'
import {buildAdapter} from '../src/core/adapter'
import {validateManifest} from '../src/manifests/load'
import {clearedFilters, type PickerRestore} from '../src/tui/state'
import type {ExecPlan,SessionRef} from '../src/types'
const now=1800000000000
const tick=()=>new Promise(resolve=>setTimeout(resolve,40))
const native=buildAdapter(validateManifest({schema:1,id:'claude',name:'Claude',roots:['/none'],format:'jsonl-transcript',tier:'resume',jsonl:{glob:'*.jsonl',variant:'claude'},resume:{cmd:'claude',args:['--resume','{id}'],cwd:'{cwd}'},brief:{cmd:'claude',args:['{prompt}'],cwd:'{cwd}'}}))
function setup(extra:Record<string,unknown>={}){
 const db=IndexDb.open(':memory:')
 const ref:SessionRef={uid:'claude:a',client:'claude',nativeId:'a',cwd:'/proj',gitBranch:'main',title:'Tenant retry',startedAt:now-1000,endedAt:now,turns:2,parentNativeId:null,tier:'resume',origin:'manifest',sourcePaths:[],fingerprint:''}
 db.upsertRef(ref);db.upsertDoc({ref,prompts:['tenant retries private retained text'],prose:['retained reply'],files:['src/legacy.ts'],truncated:false,...extra})
 return {db,ref}
}
const restore=(uid='claude:a'):PickerRestore=>({text:'',filters:clearedFilters(),selectedUid:uid,selectedIndex:0,listTop:0,reader:{anchor:{uid,ordinal:null,offset:0,fallbackLine:0},findText:'',hitIndex:-1}})
function mount(db:IndexDb,extra:Partial<React.ComponentProps<typeof App>>={}){return render(<App db={db} cfg={DEFAULT_CONFIG} adapters={[native]} cwd="/" now={now} rows={30} columns={100} onExec={()=>{}} checkResumePlan={()=>({ok:true})} checkHandoffPlan={()=>({ok:true})} {...extra}/>)}
test('mounted Filters Ctrl+U clears draft without clearing committed time or abandoning dialog',async()=>{
 const {db}=setup();let state:PickerRestore|undefined
 const initial={...restore(),reader:null,filters:{...clearedFilters(),time:{kind:'preset' as const,preset:'7d' as const}}}
 const view=mount(db,{initialState:initial,onStateChange:value=>{state=value}});await tick()
 view.stdin.write('\x07');await tick();view.stdin.write('/draft');await tick();view.stdin.write('\x15');await tick()
 expect(view.lastFrame()).toContain('Filters');expect(view.lastFrame()).not.toContain('/draft');expect(state?.filters.time).toEqual(initial.filters.time)
 view.unmount();db.close()
})
test('single native adapter context action reaches checked same-client fresh confirmation',async()=>{
 const {db}=setup();let checked=0
 const view=mount(db,{checkResumePlan:plan=>{if(plan.kind==='brief')checked++;return {ok:true}}});await tick();view.stdin.write('\x14');await tick()
 expect(view.lastFrame()).toContain('Start a new briefed session');expect(view.lastFrame()).not.toContain('no other client available');expect(checked).toBeGreaterThan(0)
 view.unmount();db.close()
})
test('restored hidden reader checks actual snapshot client before reading transcript',async()=>{
 const {db,ref}=setup();db.upsertRef({...ref,uid:'misleading:a'})
 db.upsertDoc({ref:{...ref,uid:'misleading:a'},prompts:['private retained text'],prose:[],files:[],truncated:false})
 const view=mount(db,{cfg:{...DEFAULT_CONFIG,hiddenClients:['claude']},initialState:restore('misleading:a')});await tick()
 expect(view.lastFrame()).not.toContain('private retained text');expect(view.lastFrame()).not.toContain('History ·');expect(view.lastFrame()).toContain('Reader session is unavailable')
 view.unmount();db.close()
})
test('path-only reader retains bounded fallback and ordering provenance',async()=>{
 const {db}=setup();const view=mount(db,{initialState:restore()});await tick()
 expect(view.lastFrame()).toContain('src/legacy.ts');expect(view.lastFrame()).toContain('file operation order unavailable')
 view.unmount();db.close()
})
test('ordered reader retains index-level file log cap caveat',async()=>{
 const {db}=setup({fileDetail:'ordered',fileEvents:[{path:'src/ordered.ts',kind:'edit',turn:0}],fileEventsTruncated:true})
 const view=mount(db,{initialState:restore()});await tick()
 expect(view.lastFrame()).toContain('edit src/ordered.ts');expect(view.lastFrame()).toContain('file operation log was capped')
 view.unmount();db.close()
})
test('effective resume launcher supplies native primary footer for raw search row',async()=>{
 const {db,ref}=setup();db.upsertRef({...ref,tier:'search'})
 const adapter=buildAdapter(validateManifest({schema:1,id:'claude',name:'Shared',roots:['/none'],format:'jsonl-transcript',tier:'search',jsonl:{glob:'*.jsonl',variant:'claude'},launchers:{fresh:{name:'Fresh',tier:'search',brief:{cmd:'fresh',args:['{prompt}'],cwd:'{cwd}'}},native:{name:'Native',tier:'resume',resume:{cmd:'native',args:['{id}'],cwd:'{cwd}'}}}}))
 const view=mount(db,{adapters:[adapter],cfg:{...DEFAULT_CONFIG,launchers:{claude:'native'}},onPath:()=>true,columns:160});await tick()
 expect(view.lastFrame()).toContain('Resume session available');expect(view.lastFrame()).toContain('enter Resume');expect(view.lastFrame()).not.toContain('enter Start fresh')
 view.unmount();db.close()
})

test('fixture journey preserves prefix child evidence, literal find, custom filters, bookmarks, chain, handoff cancel and refresh',async()=>{
 const {db,ref:original}=setup()
 const ref={...original,title:'Root unrelated'}
 db.upsertRef(ref)
 const child={...ref,uid:'claude:child',nativeId:'child',parentNativeId:'a',endedAt:now-100,title:'Child context'}
 db.upsertRef(child);db.upsertDoc({ref:child,prompts:['tenant tenant tenant retries evidence and café'],prose:['Unicode café retained answer'],files:['src/child.ts'],truncated:false,dialogue:[{role:'user',text:'Opening unrelated request'},{role:'assistant',text:'tenant tenant tenant retries evidence and café'},{role:'user',text:'café again'}],fileDetail:'ordered'})
 // Both members match; the newer root represents the child's stronger evidence.
 db.upsertDoc({ref,prompts:['one passing tenant mention '+ 'unrelated '.repeat(50)],prose:['root answer'],files:['src/root.ts'],truncated:false,dialogue:[{role:'user',text:'Root unrelated request'}]})
 let bookmarks:string[]=[];let state:PickerRestore|undefined;let refreshed=false;let launched=false;let emitted:ExecPlan|null=null
 const store={load:()=>({state:{version:1 as const,uids:[...bookmarks]},warning:null,writable:true}),set:async(uid:string,enabled:boolean)=>{bookmarks=enabled?[...bookmarks,uid]:bookmarks.filter(value=>value!==uid);return {version:1 as const,uids:[...bookmarks]}},remove:async(uid:string)=>{bookmarks=bookmarks.filter(value=>value!==uid);return {version:1 as const,uids:[...bookmarks]}}}
 const target=buildAdapter(validateManifest({schema:1,id:'codex',name:'Codex',roots:['/none'],format:'jsonl-transcript',tier:'search',jsonl:{glob:'*.jsonl',variant:'claude'},brief:{cmd:'codex',args:['{prompt}'],cwd:'{cwd}'}}))
 const filters={...clearedFilters(),time:{kind:'custom' as const,range:{since:now-10000,until:now+1000},sinceText:'2027-01-15T07:59:50Z',untilText:'2027-01-15T08:00:01Z'}}
 const view=mount(db,{adapters:[native,target],bookmarkStore:store,initialState:{...restore(),reader:null,filters:clearedFilters()},onStateChange:value=>{state=value},onReindex:()=>{refreshed=true},onExec:plan=>{launched=true;emitted=plan}})
 const capture:Record<string,string>={}
 const tabs=async(count:number)=>{for(let index=0;index<count;index++){view.stdin.write('\t');await tick()}}
 await tick();view.stdin.write('\x07');await tick();await tabs(4);view.stdin.write('\x1b[D');await tick();await tabs(2);view.stdin.write(filters.time.sinceText);await tick();await tabs(2);view.stdin.write(filters.time.untilText);await tick();view.stdin.write('\x13');await tick();expect(state?.filters.time).toEqual(filters.time)
 view.stdin.write('ten');await tick();capture.prefix=view.lastFrame()!
 expect(view.lastFrame()).toContain('Matched related session claude:child')
 view.stdin.write('\x0f');await tick();capture.reader=view.lastFrame()!
 expect(view.lastFrame()).toContain('History · claude:child');expect(state?.reader?.anchor.ordinal).toBe(1)
 view.stdin.write('\x06');await tick();view.stdin.write('café');await tick();expect(view.lastFrame()).toContain('hit 1 of 2')
 view.stdin.write('\r');await tick();view.stdin.write('\x1bOR');await tick();expect(state?.reader?.hitIndex).toBe(1)
 view.stdin.write('\x1b');await tick();expect(state?.text).toBe('ten');expect(state?.filters.time).toEqual(filters.time)
 view.stdin.write('\x07');await tick();capture.filters=view.lastFrame()!;view.stdin.write('\x13');await tick();expect(state?.filters.time).toEqual(filters.time)
 view.stdin.write('\x02');await tick();expect(bookmarks).toEqual(['claude:a'])
 view.stdin.write('\x07');await tick();await tabs(12);view.stdin.write('\r');await tick();await tabs(2);view.stdin.write('src/');await tick();await tabs(3);view.stdin.write('\r');await tick();view.stdin.write('\x13');await tick()
 expect(state?.filters.branch).toBe('main');expect(state?.filters.file).toEqual({path:'src/',exact:false});expect(state?.filters.bookmarkedOnly).toBe(true)
 view.stdin.write('\x05');await tick();capture.chain=view.lastFrame()!;expect(view.lastFrame()).toContain('Related sessions (2 visible)');view.stdin.write('Child context');await tick();view.stdin.write('\r');await tick();view.stdin.write('\r');await tick();expect(view.lastFrame()).toContain('History · claude:child');view.stdin.write('\x1b');await tick()
 view.stdin.write('\x14');await tick();expect(view.lastFrame()).toContain('Codex');view.stdin.write('\r');await tick();capture.confirmation=view.lastFrame()!;expect(view.lastFrame()).toContain('Start a new briefed session');view.stdin.write('\x1b');await tick();view.stdin.write('\x1b');await tick();expect(launched).toBe(false)
 view.stdin.write('\x05');await tick();view.stdin.write('Child context');await tick();view.stdin.write('\r');await tick();view.stdin.write('\r');await tick();view.stdin.write('\x06');await tick();for(let index=0;index<3;index++){view.stdin.write('\x7f');await tick()}view.stdin.write('café');await tick();view.stdin.write('\r');await tick();view.stdin.write('\x12');await tick()
 expect(refreshed).toBe(true);expect(state?.reader?.anchor.uid).toBe('claude:child');expect(state?.reader?.findText).toBe('café');expect(state?.text).toBe('ten');expect(state?.filters.time).toEqual(filters.time)
 const saved=state!
 view.unmount();db.close()
 const refreshedDb=IndexDb.open(':memory:')
 refreshedDb.upsertRef(ref);refreshedDb.upsertDoc({ref,prompts:['one passing tenant mention '+ 'unrelated '.repeat(50)],prose:['root answer'],files:['src/root.ts'],truncated:false,dialogue:[{role:'user',text:'Root unrelated request'}]})
 refreshedDb.upsertRef(child);refreshedDb.upsertDoc({ref:child,prompts:['tenant tenant tenant retries evidence and café'],prose:[],files:['src/child.ts'],truncated:false,dialogue:[{role:'user',text:'Opening unrelated request'},{role:'assistant',text:'tenant tenant tenant retries evidence and café'},{role:'user',text:'café again'}],fileDetail:'ordered'})
 const restored=mount(refreshedDb,{adapters:[native,target],bookmarkStore:store,initialState:saved,onStateChange:value=>{state=value},onExec:plan=>{emitted=plan}});await tick();capture.refreshed=restored.lastFrame()!
 expect(state?.selectedUid).toBe('claude:a');expect(state?.reader).toEqual(saved.reader);expect(state?.text).toBe('ten');expect(state?.filters).toEqual(saved.filters);expect(restored.lastFrame()).toContain('History · claude:child')
 restored.stdin.write('\x1b');await tick();restored.stdin.write('\r');await tick();expect(emitted).toMatchObject({kind:'resume',cmd:'claude',args:['--resume','a'],cwd:'/proj'})
 await Bun.write('/tmp/nekyia-tui-ux/final-integration-frames.json',JSON.stringify(capture,null,2))
 restored.unmount();refreshedDb.close()
})

test('path-only reader fallback fetches at most 500 bounded paths and reports its cap',async()=>{
 const {db}=setup({files:Array.from({length:501},(_,index)=>`src/path-${String(index).padStart(3,'0')}.ts`)})
 const fallback=db.filePathsForUid('claude:a')
 expect(fallback.paths).toHaveLength(500);expect(fallback.capped).toBe(true)
 expect(fallback.paths).not.toContain('src/path-500.ts')
 const view=mount(db,{initialState:restore()});await tick();view.stdin.write('\x1b[F');await tick()
 expect(view.lastFrame()).toContain('file operation log was capped');expect(view.lastFrame()).not.toContain('src/path-500.ts')
 view.unmount();db.close()
})

test('search context action exposes its failed preflight and uses alternate targets when available',async()=>{
 const {db,ref}=setup();db.upsertRef({...ref,tier:'search'})
 const search=buildAdapter(validateManifest({schema:1,id:'claude',name:'Claude',roots:['/none'],format:'jsonl-transcript',tier:'search',jsonl:{glob:'*.jsonl',variant:'claude'},brief:{cmd:'claude',args:['{prompt}'],cwd:'{cwd}'}}))
 const view=mount(db,{adapters:[search],columns:160,checkResumePlan:()=>({ok:false,reason:'Directory unavailable'})});await tick()
 expect(view.lastFrame()).toContain('Directory unavailable');view.stdin.write('\x0b');await tick()
 view.stdin.write('\x1b[B');await tick()
 expect(view.lastFrame()).toContain('▸ Start fresh with context (ctrl+t)')
 expect(view.lastFrame()).toContain('Directory unavailable')
 view.stdin.write('Start fresh');await tick();view.stdin.write('\r');await tick();expect(view.lastFrame()).toContain('Actions');expect(view.lastFrame()).toContain('Directory unavailable')
 view.unmount()
 const alternate=buildAdapter(validateManifest({schema:1,id:'codex',name:'Codex',roots:['/none'],format:'jsonl-transcript',tier:'search',jsonl:{glob:'*.jsonl',variant:'claude'},brief:{cmd:'codex',args:['{prompt}'],cwd:'{cwd}'}}))
 const other=mount(db,{adapters:[search,alternate],checkResumePlan:()=>({ok:false,reason:'Directory unavailable'})});await tick();other.stdin.write('\x14');await tick()
 expect(other.lastFrame()).toContain('Hand off to another client');expect(other.lastFrame()).toContain('Codex')
 other.unmount();db.close()
})
test('allowed restored reader retains original browse selection fallback notice on return',async()=>{
 const {db}=setup();const initial={...restore(),selectedUid:'claude:removed'}
 const view=mount(db,{initialState:initial,columns:160});await tick();expect(view.lastFrame()).toContain('History · claude:a');view.stdin.write('\x1b');await tick()
 expect(view.lastFrame()).toContain('Selected session no longer matches; nearest result selected')
 view.unmount();db.close()
})
test('ambiguous effective tier advertises choosing a launcher before launch',async()=>{
 const {db,ref}=setup();db.upsertRef({...ref,tier:'search'})
 const adapter=buildAdapter(validateManifest({schema:1,id:'claude',name:'Shared',roots:['/none'],format:'jsonl-transcript',tier:'search',jsonl:{glob:'*.jsonl',variant:'claude'},launchers:{fresh:{name:'Fresh',tier:'search',brief:{cmd:'fresh',args:['{prompt}'],cwd:'{cwd}'}},native:{name:'Native',tier:'resume',resume:{cmd:'native',args:['{id}'],cwd:'{cwd}'}}}}))
 const view=mount(db,{adapters:[adapter],onPath:()=>true});await tick()
 expect(view.lastFrame()).toContain('enter Choose launcher');view.stdin.write('\x0b');await tick();expect(view.lastFrame()).toContain('Choose launcher (enter)')
 view.unmount();db.close()
})
test('reader scrolling reuses bounded file metadata without additional selected-file queries or launch planning',async()=>{
 const {db}=setup({dialogue:[{role:'user',text:Array.from({length:100},(_,index)=>`retained line ${index}`).join('\n')}]})
 const events=spyOn(db,'fileEventsForUid');const paths=spyOn(db,'filePathsForUid');const metadata=spyOn(db,'fileDetailsFor');let checks=0
 const view=mount(db,{initialState:restore(),checkResumePlan:()=>{checks++;return {ok:true}}});await tick()
 const before=[events.mock.calls.length,paths.mock.calls.length,metadata.mock.calls.length,checks]
 for(let index=0;index<8;index++){view.stdin.write('\x1b[B');await tick()}
 expect([events.mock.calls.length,paths.mock.calls.length,metadata.mock.calls.length,checks]).toEqual(before)
 expect(events.mock.calls.length).toBe(1);expect(paths.mock.calls.length).toBe(1);expect(checks).toBe(0)
 view.unmount();events.mockRestore();paths.mockRestore();metadata.mockRestore();db.close()
})
