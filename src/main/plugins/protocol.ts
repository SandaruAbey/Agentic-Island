import type { PluginValue } from '@shared/types'

/**
 * Messages between Isla (main process) and a plugin's worker (its own utility process).
 * Everything a plugin may ask Isla to do goes through `call` — Isla checks the plugin's permissions there.
 */

export type HostCall =
  | { method: 'ai.ask'; args: [prompt: string, system: string] }
  | { method: 'ai.research'; args: [prompt: string, title: string] }
  | { method: 'notify'; args: [title: string, body: string] }
  | { method: 'storage.get'; args: [key: string] }
  | { method: 'storage.set'; args: [key: string, value: unknown] }
  | { method: 'report.save'; args: [report: { title: string; markdown: string; files?: Record<string, string> }] }
  | { method: 'browser.open'; args: [url: string, opts: { width?: number; height?: number; timeoutMs?: number; fresh?: boolean }] }
  | { method: 'browser.eval'; args: [script: string, timeoutMs: number] }
  | { method: 'browser.show'; args: [show: boolean] }
  | { method: 'browser.close'; args: [] }

export type HostMessage =
  | {
      type: 'run'
      pluginId: string
      entry: string
      toolId: string
      input: { text: string; trigger: 'manual' | 'chat' | 'schedule' }
      settings: Record<string, PluginValue>
    }
  | { type: 'reply'; callId: number; ok: true; value: unknown }
  | { type: 'reply'; callId: number; ok: false; error: string }

export type WorkerMessage =
  | ({ type: 'call'; callId: number } & HostCall)
  | { type: 'log'; text: string }
  | { type: 'progress'; value: number | null; text?: string }
  | { type: 'done'; summary: string }
  /** stack: kept in the run's log for the plugin's author, never shown as the result. */
  | { type: 'error'; message: string; stack?: string }
