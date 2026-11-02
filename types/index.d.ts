// The chat as of its last warm moment: a reply, or a keep-warm ping.
export type Chat = { warmAt: number; tokens: number; model: string }

// off: no pings. auto: switched on because the chat is big. on: the person asked.
export type KeepWarm = { mode: 'off' | 'auto' | 'on'; until: number; pings: number }

export type Handoff = 'idle' | 'writing' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'cache-clock': {
      chat: Shaped<Chat | null>
      keepWarm: Shaped<KeepWarm>
      handoff: Handoff
      now: number
    }
  }
}
