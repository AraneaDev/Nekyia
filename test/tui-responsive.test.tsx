import {expect,test} from 'bun:test'
import React from 'react'
import {render} from 'ink-testing-library'
import {Actions} from '../src/tui/ActionMenu'
import {Filters} from '../src/tui/Filters'
import {History} from '../src/tui/History'
import {Details} from '../src/tui/Details'
import {clearedFilters} from '../src/tui/state'
import type {SessionDetail} from '../src/core/session-detail'
const tick=()=>new Promise(resolve=>setTimeout(resolve,15))
const detail:SessionDetail={uid:'legacy:a',turns:[],latestUser:'😀'.repeat(100),latestReply:'retained reply\n'.repeat(25),ordered:false,fileCount:null,fileCountCapped:false,reasons:['source-missing','legacy-text','reader-cap']}
test('action, filter, capped legacy history and missing-source details fit every terminal size',async()=>{
 for(const columns of [40,60,80,120,160])for(const rows of [8,12,16,24,40]){
  const variants=[
   <Actions items={[{id:'resume',label:'Resume session',shortcut:'enter',enabled:false,reason:'Source missing'},{id:'filters',label:'Filters',shortcut:'ctrl+g',enabled:true,reason:null}]} rows={rows} columns={columns} onAction={()=>{}} onClose={()=>{}}/>,
   <Filters value={clearedFilters()} now={1800000000000} cwd="/proj" clients={['claude']} branches={['main',null]} rows={rows} columns={columns} onApply={()=>{}} onClose={()=>{}}/>,
   <History detail={detail} rows={rows} columns={columns} onPosition={()=>{}} onClose={()=>{}} initial={{anchor:{uid:'legacy:a',ordinal:null,offset:0,fallbackLine:0},findText:'absent',hitIndex:-1}}/>,
   <Details detail={detail} refData={null} launchReason="Directory unavailable" rows={rows} columns={columns} onClose={()=>{}}/>,
  ]
  for(const variant of variants){
   const view=render(variant);await tick();const lines=view.lastFrame()!.split('\n')
   expect(lines.length).toBeLessThanOrEqual(rows)
   for(const line of lines)expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns)
   view.unmount()
  }
 }
})
