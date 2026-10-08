import React from 'react'
import { Box, Text } from 'ink'
import { clientColor } from './List'
import { activitySparkline, type ResultStats } from './result-stats'
import { boundedDisplayText, padColumns } from './text'

/** A fixed-width overview of the current result window, including its cap. */
export interface StatsPanelProps { stats: ResultStats; columns: number; rows: number; overflowed: boolean }

/** Charts never consume preview width; short panels prioritize scope and activity. */
export function StatsPanel({ stats, columns, rows, overflowed }: StatsPanelProps) {
  const recent = stats.days.reduce((sum, day) => sum + day.count, 0)
  const heading = [
    { text: 'Current results', bold: true },
    { text: `${stats.total} session${stats.total === 1 ? '' : 's'} · ${stats.projects} proj` },
    ...(overflowed ? [{ text: 'Shown results only · capped', dim: true }] : []),
    { text: `Last 7 days · ${recent}`, dim: true },
    { text: activitySparkline(stats.days), color: 'cyan' },
    { text: stats.days.map(day => day.label).join(' '), dim: true },
    { text: 'Clients', dim: true },
  ]
  const clients = stats.clients.slice(0, Math.max(0, rows - heading.length - 1))
  const peak = stats.clients[0]?.count ?? 1
  return <Box width={columns} height={rows} flexDirection="column" overflow="hidden">
    {heading.map((line, index) => <Text key={index} bold={'bold' in line && line.bold} dimColor={'dim' in line && line.dim}
      color={'color' in line ? line.color : undefined} wrap="truncate-end">{boundedDisplayText(line.text, columns)}</Text>)}
    {clients.map(client => <Text key={client.id} color={clientColor(client.id)} wrap="truncate-end">
      {boundedDisplayText(`${padColumns(boundedDisplayText(client.label, 9), 9)} ${'█'.repeat(Math.max(1, Math.round(client.count / peak * 7))).padEnd(7)} ${client.count}`, columns)}
    </Text>)}
    <Text dimColor wrap="truncate-end">ctrl+s hide stats</Text>
  </Box>
}
