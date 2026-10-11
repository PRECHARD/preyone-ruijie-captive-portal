# Conductor Manual — Manual Override, Shifts, and Ticket Numbers

For conductors and dispatchers. Read this once; it covers the changes that affect
how you work on the bus.

---

## 1. Ticket numbers identify one bus and one terminal

Every new ticket carries a number that no other ticket from any other bus or
terminal will share, and the server rejects a repeated number rather than letting
it reach the accounts twice.

**What it looks like**

```
AGJ-A1B-0041
  │    │    └── ticket sequence on this terminal
  │    └─────── this terminal (derived from the device, never changes)
  └──────────── the bus's ABS plate letters
```

- **The letters are the bus's plate letters.** The first letters of the
  registration on your shift, e.g. `AGJ` from `AGJ 1234`.
- **The middle part is your terminal.** It stays the same for this phone, forever.
  It is three characters, giving room for a large fleet before two phones could
  ever land on the same tag.
- **The last part counts up** and is never reused.

**Why the change.** Previously the number was just a counter on each phone, so two
buses could each produce `AGJ0001`. Two different passengers on two different buses
then held identical ticket numbers, and any reconciliation found a "duplicate".
New tickets cannot collide this way, and if two are ever produced with the same
number the server records the clash instead of quietly counting the sale twice.

**Tickets issued before this change are unaffected.** They keep their old
`AGJ0001`-style numbers, and some of those old numbers were reused across buses.
Those are being reconciled by the office from the paper records; you do not need
to do anything about them.

**What you must do**

- Nothing. Numbers are produced automatically at the moment you press Sell.
- When a passenger asks for their ticket number, read the whole thing, including
  the letters — `AGJ-A1B-0041`, not just `0041`.
- If the letters look wrong, check the **vehicle** on your open shift. The number
  follows the bus on the shift, so a wrong number means the wrong bus was
  selected. Fix the shift before selling more.
- If a sync reports a **duplicate number**, report it to the office with the time
  and your terminal. Do not re-sell that number by hand; the clash is recorded
  and needs reconciling against the other ticket.

> Note: if no shift is open, there is no bus, so the number falls back to the
> company prefix (e.g. `TKT-...`). Always start a shift before selling.

---

## 2. A driver shift must be started before you can sell

An open run (a trip not on the published schedule) needs a driver and a bus before
it can start. If you press **Open run and start selling** without a shift, the app
now tells you plainly and gives you a **START SHIFT** button to tap.

**What you must do**

1. If you see *"No driver shift is open"*, tap **START SHIFT** in the message (or
   open the shift yourself).
2. Choose the **correct driver** and the **correct bus**.
3. Tap **Start shift**, then open your run again.

**The driver is no longer pre-filled.** Previously the app quietly selected
whichever name happened to be first in the list — which meant tickets could be
printed with a driver's name who was not actually on the bus. Now the field starts
empty unless you are yourself the driver, and you must choose. This is deliberate:
a driver's name on a passenger ticket must be a decision, not a default.

> If a red screen ever appears, tell your supervisor and note the time. Do not
> keep retrying — restart the app and start a fresh shift.

---

## 3. Ending your shift now always reaches the office

**The change.** Previously, if you ended a shift while the phone had no network,
the end of shift was lost. The office kept showing your shift as **open**, so
dispatch could see a driver still on duty hours after the bus had finished.

**What happens now**

- Ending a shift works with or without network.
- If the phone is offline, the end of shift is **saved on the phone** and sent the
  moment you are back online — automatically, nothing for you to do.
- The office records the **real time you finished**, not the time the phone
  reconnected. A bus that finished at 14:35 shows as finishing at 14:35.
- The office also now sees the driver's and conductor's **names and phone
  numbers**, so they can reach you.

**What you must do**

- End your shift as usual, every time, even if the phone says no network. It is
  safe.
- Do not worry about a "sync pending" state. It clears on its own.
- If you sell tickets *after* ending a shift, that is a mistake — reopen the shift
  first, then sell.

---

## 4. Back button behaviour

| Where you are | Press back | What happens |
|---|---|---|
| Any screen | 1st press | Return to the **Dashboard** |
| Dashboard | 1st press | A message: *"Press back again to close Preyone."* |
| Dashboard | 2nd press (within 2s) | The app closes |

This means a stray back press deep inside ticketing can never cost you your place
at the counter, and the app only closes when you clearly intend to.

---

## 5. Status bar and navigation bar

The black strip at the top and the bar at the bottom now match the app's own
background, so the app fills the screen like a modern app. The buttons at the top
and the navigation at the bottom are still exactly where they were — nothing moved.

---

## 6. Manual override — what you may and may not do

A **manual override** means a ticket that could not be sold normally, entered by
hand because of a real-world exception.

**Use manual override only when:**

- The scheduled fare is genuinely wrong for that passenger (a child, a senior, a
  luggage-only load) **and** you have the reason.
- The route was changed on the ground by dispatch.

**Do not use it to:**

- Compensate for your own mis-keyed fare. Correct the ticket instead.
- Give a discount that was not approved. Discounts are a dispatch decision.
- Work around a device that will not start a shift. Report the device.

**Every override must be able to answer three questions:**

1. Which bus and which driver?
2. Which passenger, and at which stage did they board and get off?
3. Why was the normal fare not used?

If you cannot answer all three, do not issue the override — call dispatch.

**Records.** A new ticket number identifies the override uniquely and permanently
(see section 1), and the server will not accept it twice. Never reuse a number,
never write one by hand over a printed one. If a ticket is spoiled, keep the stub
and tell dispatch — do not reissue the same number.

---

## 7. Quick troubleshooting

| What you see | What it means | What to do |
|---|---|---|
| "No driver shift is open" | No shift started on this phone | Tap **START SHIFT**, pick the driver and bus, start it |
| "Selling is paused: this device has no valid offline authorization" | The phone has been offline too long | Reconnect to data, then **Settings → Sync now** |
| Sync says "Nothing to sync, and server unreachable" | No network | Carry on selling offline; sync will catch up |
| The Route Templates card is locked | Your company has not been given the permission | Ask your supervisor; do not use another account |
| A ticket number starts with the wrong letters | Wrong bus on the open shift | End the shift, start the correct bus, then sell |
| Red screen | Please report it | Note the time, restart the app, start a fresh shift |

---

## Who to contact

- **Dispatch / office** — fares, route changes, approved discounts, overrides.
- **Supervisor** — shift or driver problems, a device that will not start a shift,
  anything that stopped you selling.
- **IT** — the app crashing, a red screen, a ticket that will not print.
