# cache-clock

A Claude Code mod that shows when your chat's prompt cache goes cold, keeps big chats warm, hands off long chats to a fresh one, and shows how much of your plan limits you've used.

Every message makes Claude re-read the whole chat. A saved copy (the prompt cache) makes that cheap, but it expires after a while with no activity: an hour on a Claude subscription, five minutes with an API key. After that, the next message re-reads everything at full price.

- **Countdown under the prompt.** `◔ Warm · cold in 41:20 · 180k tokens`, or `❄ Cold · your next message re-reads 180k tokens (~$1.44)`.
- **Keep-warm.** For chats over 100k tokens it turns on by itself and sends a tiny hidden ping just before the cache runs out, so the chat stays warm through a break. It stops when you send a message, two hours after the last reply, or when you press Stop. `/keepwarm` or the Keep warm button turns it on for any chat. The app has to be running for pings to go out.
- **Handoff.** The Hand off button (shown for long or cold chats) or `/handoff` has Claude write a detailed brief of the chat (goal, state, files, tools, your rules, open questions, next steps), saves it to `.claude/handoffs/` in your project, starts a fresh chat and puts the brief in the prompt box to review and send.
- **Plan usage meter.** On a Claude subscription the line also shows your plan limits as two little characters: a light Claude crab for the 5-hour limit and a red heart for the week, each with its percent. As a limit fills, the colour drains out from the top and the character wears down: sparkly and excited, fine, tired (half-closed eyes, a sweat drop), exhausted (eyes shut, snoozing), and at 100% spent (a grey crab with X eyes, a grey cracked heart). Hover for the reset time. A one-time notice appears when a limit passes 90%. It updates after each reply and whenever a limit moves a point; a brand-new chat shows it after its first reply. The terminal shows a tinted `▐▛█▜▌` and `♥` instead.
- **`/cacheclock`** prints the current state, plan limits included.

The clock and the usage meter use no tokens. Each keep-warm ping is a cheap cached re-read, and a handoff costs about one message. Dollar figures are estimates at API prices; on a subscription they come out of your usage limits instead.

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
