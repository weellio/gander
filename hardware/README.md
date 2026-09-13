# Build a $4 ambient alert lamp

Gander's **ambient alerts** POST a small JSON body whenever something happens. A smart bulb is one way to catch it. A WiFi microcontroller costs a fraction of one and does more.

This folder has working firmware: [`ambient-lamp/ambient-lamp.ino`](ambient-lamp/ambient-lamp.ino).

Powered by **one USB port**. No hub, no cloud, no account.

---

## Parts

| Part | Why | Rough cost |
|---|---|---|
| **ESP32-C3 SuperMini** *or* **Wemos D1 mini (ESP8266)** | WiFi + USB power in one board | $2 – $4 |
| **WS2812B stick (8 LEDs)** or ring (16) | the actual light | $1 – $3 |
| 3 jumper wires | strip → board | pennies |
| USB cable you already own | power | $0 |

**Total: about $4** from AliExpress, **about $12** from Amazon (same parts, faster).

### Boards that work

The firmware builds for any ESP8266 or ESP32 without edits. Set two defines and upload.

| Board | Onboard RGB | `LED_PIN` | Cost | Verdict |
|---|---|---|---|---|
| **ESP32-C3 SuperMini** | usually yes | `8` | $2 – $4 | Cheapest complete lamp |
| **Wemos D1 mini (ESP8266)** | no | `4` (pin D2) | $2 – $4 | Fine, needs a strip |
| **ESP32-S3-DevKitC-1** | yes | `48`, or `38` on some revisions | $8 – $15 | Overkill, but great if you own one |
| **ESP32 DevKit / S2 / C6** | varies | check pinout | $4 – $10 | Works the same |

Already have an **ESP32-S3-DevKitC-1** in a drawer? Use it. It is more board than this needs, but the cost is zero and the onboard addressable LED means no wiring at all. Set `LED_PIN 48` and `LED_COUNT 1`.

Two things specific to that board:

- It has **two USB ports**. Flash through the one marked **UART**. That is the least fussy path.
- If you use the port marked **USB** instead, turn on **Tools → USB CDC On Boot** or the Serial Monitor stays empty.

### Cheapest possible version

Buy the **ESP32-C3 SuperMini alone (~$3)**. Most of them have an RGB LED on board (GPIO8).

Set `LED_PIN 8` and `LED_COUNT 1`. One board, one cable, full colour. No soldering, no wires.

It is small, so it works best as a desk-edge indicator rather than a room light.

---

## Wiring (only if you add a strip)

| Strip pin | Board pin |
|---|---|
| 5V / VCC | `5V` (D1 mini) or `5V` / `VBUS` (C3) |
| GND | `GND` |
| DIN | `D2` on D1 mini (GPIO4), or any free GPIO on C3 |

Keep `MAX_BRIGHTNESS` at 70 or below. A USB port supplies 500 mA, and 8 LEDs at full white would draw close to that on their own.

If the LEDs flicker, the 3.3V data line is marginal. Put one ordinary diode (1N4148) in the strip's 5V line. That drops it to about 4.4V and the strip then reads 3.3V data cleanly.

---

## Flash it

1. Install the **Arduino IDE**.
2. Boards Manager → add **esp8266** or **esp32**, then pick your board.
3. Library Manager → install **Adafruit NeoPixel**. That is the only library.
4. Open `ambient-lamp/ambient-lamp.ino` and edit the three lines at the top: WiFi name, WiFi password, `LED_PIN`.
5. Upload. Open the Serial Monitor at **115200** to see the address it got.

---

## Point Gander at it

**⚙ Settings → App configuration → 💡 Ambient alerts**

In each scenario's **webhook** field:

```
http://gander-lamp.local/alert
```

If `.local` names don't resolve on your network, use the IP the Serial Monitor printed, for example `http://192.168.1.42/alert`.

Hit **Test** in Settings. The lamp should react immediately.

Open `http://gander-lamp.local/` in a browser for a status page with its own test buttons.

---

## What each alert looks like

Gander's defaults, which you can change per scenario in Settings:

| Event | Meaning | Colour | Pattern |
|---|---|---|---|
| `awaiting` | a session needs you | amber | pulse |
| `error` | an agent hit an error | red | blink |
| `runaway` | burning money fast | red | strobe |
| `done` | a task finished | green | pulse |
| `clear` | all handled | off | solid |

The firmware understands every pattern Gander sends: `solid`, `blink`, `pulse`, `breathe`, `strobe`, `rainbow`. Colours can be names (`amber`, `red`, `limegreen`) or hex (`#F59E0B`).

---

## The payload, if you'd rather build your own

Any device that accepts an HTTP POST works. This is what arrives:

```json
{
  "event": "awaiting",
  "color": "amber",
  "effect": "pulse",
  "project": "shop",
  "agent": "session name",
  "reason": "waiting on your input",
  "state": "awaiting",
  "at": 1789019330000
}
```

Prefer a script over a device? Use the **command** field in the same Settings section instead. Gander runs it with `AOC_EVENT`, `AOC_COLOR`, `AOC_EFFECT` and `AOC_PROJECT` in the environment.
