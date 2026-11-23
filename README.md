# Did Germany's Nuclear Phase-Out Increase CO₂ Emissions?

A synchronized multiplayer classroom activity built on the published panel from
Loiacono, Rizzo & Secomandi (2025), *Nuclear phase-out: Can we catch up on CO₂
emissions?*, PLOS ONE. Four breakout rooms of four students each build their own
synthetic control for Germany, stress-test it, and defend a conclusion, while
the facilitator can freeze every room and demonstrate on all screens at once.

**No dependencies, no build step.** Everything runs on bare Node 18+.

---

## Run it

```bash
node server.js
```

The terminal prints two links and a facilitator key:

```
  Students      http://localhost:3000/
  Facilitator   http://localhost:3000/facilitator?key=a1b2c3d4e5

  Facilitator key: a1b2c3d4e5
```

Choose your own key (recommended, so it stays the same across restarts):

```bash
FACILITATOR_KEY=myclass2026 node server.js
```

### Settings

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on. Most hosts set this for you. |
| `HOST` | `0.0.0.0` | Interface to bind. |
| `FACILITATOR_KEY` | random each start | Password for the facilitator dashboard. |
| `ROOM_CAPACITY` | `4` | Students per breakout room. |
| `SEAT_TIMEOUT_MS` | `120000` | How long a disconnected student keeps their seat. |
| `STATE_FILE` | `./classroom-state.json` | Where work is saved between restarts. |

---

## Deploy it publicly

Students need a URL they can all reach. Any host that runs Node works; there is
nothing to compile.

**Render / Railway / Fly.io / Heroku** — point the host at this folder.
Build command: *(none)*. Start command: `node server.js`. Set `FACILITATOR_KEY`
as an environment variable. `render.yaml` and `Procfile` are included.

**Docker** — `docker build -t scm-classroom . && docker run -p 3000:3000 \
  -e FACILITATOR_KEY=myclass2026 scm-classroom`

**Your own machine on the campus network** — run it and give students
`http://<your-ip>:3000/`. Works if the network allows it; a hosted URL is safer.

> Keep the facilitator key out of the student link. Anyone with the key can
> freeze rooms and export answers.

---

## What is in here

| File | What it is |
|---|---|
| `server.js` | Authoritative state, permissions, persistence, static hosting |
| `ws.js` | A small RFC 6455 WebSocket server (so there are no dependencies) |
| `ot.js` | Operational transformation for conflict-safe group answers |
| `scm-solver.js` | The synthetic control method, in plain JavaScript |
| `model-view.js` | Turns a room's settings into charts and statistics |
| `panel.js` | The investigation controls and graphs |
| `charts.js` | SVG charts with tooltips and a table view |
| `student.js` / `index.html` | The student app |
| `facilitator.js` / `facilitator.html` | The facilitator dashboard |
| `net.js` | Connection handling and reconnection |
| `data_bundle.json` | The paper's panel: 12 countries, 1990–2023 |

---

## How the freeze is enforced

Every message that would change shared state passes a single server-side gate
before anything is written. Disabling the buttons in the browser is only a
courtesy: a student who opens the developer console and sends a raw WebSocket
frame while the room is frozen gets `{"type":"denied","reason":"frozen-all"}`
and the stored state does not move. The facilitator role itself is checked
against `FACILITATOR_KEY` with a timing-safe comparison.

## The model

The default model reproduces the paper's published synthetic Germany exactly:
Czechia 51.7%, Netherlands 31.2%, France 10.9%, Sweden 4.8%, Spain 1.4%. All
seventeen predictor means in the paper's Table 1 are reproduced to the printed
precision. The solver runs in the browser, so every student in a room computes
the identical result from the shared settings.

Two things students can discover that the paper does not flag:

1. The published donor weights give a pre-2011 RMSPE of **0.248**, not the
   0.218 the paper reports. Re-optimising the predictor weights reaches 0.20,
   with different donor weights — the flat-objective problem that makes
   synthetic control weights non-unique.
2. Dropping Czechia does not merely dent the model, it breaks it: the
   pre-2011 fit degrades from 0.25 to 0.64 and the placebo ratio collapses
   from 2.07 to about 0.5.

## Data

`data_bundle.json` is derived from the paper's own supporting-information
dataset (`pone.0336218.s006.csv`). Outcome: per-capita CO₂ from fossil fuels.
Donor pool: Bulgaria, Czechia, Finland, France, Hungary, Netherlands, Slovak
Republic, Slovenia, Spain, Sweden, Romania.
