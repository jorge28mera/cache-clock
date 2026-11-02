# cache-clock

A Claude Code mod that shows when your chat's prompt cache goes cold, keeps big chats warm, and hands off long chats to a fresh one.

Every message makes Claude re-read the whole chat. A saved copy (the prompt cache) makes that cheap, but it expires after a while with no activity: an hour on a Claude subscription, five minutes with an API key. After that, the next message re-reads everything at full price.

- **Countdown under the prompt.** `◔ Warm · cold in 41:20 · 180k tokens`, or `❄ Cold · your next message re-reads 180k tokens (~$1.44)`.
- **Keep-warm.** For chats over 100k tokens it turns on by itself and sends a tiny hidden ping just before the cache runs out, so the chat stays warm through a break. It stops when you send a message, two hours after the last reply, or when you press Stop. `/keepwarm` or the Keep warm button turns it on for any chat. The app has to be running for pings to go out.
- **Handoff.** The Hand off button (shown for long or cold chats) or `/handoff` has Claude write a detailed brief of the chat (goal, state, files, tools, your rules, open questions, next steps), saves it to `.claude/handoffs/` in your project, starts a fresh chat and puts the brief in the prompt box to review and send.
- **`/cacheclock`** prints the current state.

The clock itself uses no tokens. Each keep-warm ping is a cheap cached re-read, and a handoff costs about one message. Dollar figures are estimates at API prices; on a subscription they come out of your usage limits instead.

## Install

At the prompt of a terminal session:

```
/plugin install cache-clock --marketplace jorge28mera/cache-clock
```

Answer `y` to add the marketplace, then press Enter to pick the user scope.

From a shell:

```
claude plugin install cache-clock --marketplace jorge28mera/cache-clock
```

In the desktop app: click + next to the prompt box, then Plugins, Add marketplace with `jorge28mera/cache-clock`, then Add plugin.
