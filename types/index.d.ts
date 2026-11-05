// The chat as of its last warm moment: a reply, or a keep-warm ping.
export type Chat = { warmAt: number; tokens: number; model: string }

// off: no pings. auto: switched on because the chat is big. on: the person asked.
export type KeepWarm = { mode: 'off' | 'auto' | 'on'; until: number; pings: number }

export type Handoff = 'idle' | 'writing' | 'failed'

// One plan limit as the last reply reported it: five_hour, seven_day, or a gateway's spend_limit.
export type Limit = { kind: string; percentUsed: number; resetsAt?: string }

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      chat: Shaped<Chat | null>
      keepWarm: Shaped<KeepWarm>
      handoff: Handoff
      limits: Shaped<Limit[]>
      now: number
    }
  }
}
