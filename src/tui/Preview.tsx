import React from 'react'
import { Box, Text } from 'ink'

/** Width of the hanging label column in the preview. */
const LABEL_COLUMNS = 9

/**
 * Hands each block a share of the space one line at a time, so a session with a
 * long reply cannot push what was asked or which files moved off the pane.
 * Whatever a short block does not want falls to the others.
 */
export function shareLines(room: number, wanted: number[]): number[] {
  const given = wanted.map(() => 0)
  let left = Math.max(0, room)
  let moved = true
  while (left > 0 && moved) {
    moved = false
    for (let index = 0; index < wanted.length && left > 0; index++) {
      if (given[index]! >= wanted[index]!) continue
      given[index]!++
      left--
      moved = true
    }
  }
  return given
}

/** One line of the session preview, with the styling it should be drawn in. */
export interface PreviewLine {
  spans?: {start:number;end:number}[]
  text: string
  /** Hanging label, drawn only on a block's first line. */
  label?: string
  dim?: boolean
  bold?: boolean
  color?: string
  /** Code units at the start of the text that name it, drawn dimmed like a label. */
  lead?: number
}

/** Draws a scrollable window over the selected session's prompts, replies, and touched files. */
export function Preview({ lines, offset = 0, maxLines = 12 }: {
  lines: PreviewLine[]
  /** First line to draw, so the caller can scroll a long history. */
  offset?: number
  maxLines?: number
}) {
  if (!lines.length) return <Box><Text dimColor>nothing selected</Text></Box>
  const start = Math.max(0, Math.min(offset, Math.max(0, lines.length - 1)))
  const shown = lines.slice(start, start + Math.max(1, maxLines))
  return (
    <Box flexDirection="column">
      {shown.map((line, index) => (
        <Box key={`${start + index}:${line.label ?? ''}:${line.text}`} flexDirection="row">
          {line.label !== undefined
            ? <Box width={LABEL_COLUMNS} flexShrink={0}><Text dimColor>{line.label}</Text></Box>
            : null}
          <Text
            wrap="truncate-end"
            dimColor={line.dim}
            bold={line.bold}
            color={line.color}
          >
            {line.spans?.length ? highlightEvidence(line.text,line.spans)
              : line.lead ? <><Text dimColor>{line.text.slice(0, line.lead)}</Text>{line.text.slice(line.lead)}</>
              : line.text}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** Native evidence spans, already sanitized by the core reader, carry real FTS matches. */
function highlightEvidence(text:string,spans:readonly {start:number;end:number}[]):React.ReactNode[] {
  const out:React.ReactNode[]=[]
  let end=0
  spans.forEach((span,index)=>{
    out.push(text.slice(end,span.start),<Text key={index} color="black" backgroundColor="yellow">{text.slice(span.start,span.end)}</Text>)
    end=span.end
  })
  out.push(text.slice(end))
  return out
}
