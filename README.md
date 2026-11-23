# 🌙 hypnos

**Standard polysomnography metrics from an EDF file, computed entirely in your browser.**

[![Live app](https://img.shields.io/badge/app-hypnos.circadia--lab.uk-014370)](https://hypnos.circadia-lab.uk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20modules-F7DF1E)](https://developer.mozilla.org/docs/Web/JavaScript)
[![webR](https://img.shields.io/badge/webR-0.6.0-276DC3)](https://docs.r-wasm.org/webr/latest/)
[![Circadia Lab](https://img.shields.io/badge/circadia--bio-GitHub-014370)](https://github.com/circadia-bio)

<p align="center"><img src="logo.svg" width="140" alt="hypnos logo: a pocket watch swinging like a pendulum"></p>

---

## 📖 What is hypnos?

hypnos is a web app for getting standard sleep metrics from a polysomnography (PSG) recording without installing anything. You select an EDF file, and the page returns the stage composition of the night, a hypnogram, a spectrogram of the EEG channel used for staging, and the usual sleep architecture markers.

Everything runs in the browser. The recording is processed on your device and is never uploaded: there is no account and no server holding your data. The analysis is done by two R packages from the Circadia Lab ecosystem, [mrpheus](https://mrpheus.circadia-lab.uk) and [hypnoR](https://hypnor.circadia-lab.uk), running as WebAssembly through [webR](https://docs.r-wasm.org/webr/latest/).

---

## ✨ Features

- 🔒 **Private by design** — the EDF is read and processed on the device. (The page itself loads webR, R packages, Plotly and fonts from CDNs; the recording is not sent anywhere.)
- 📂 **Large files** — only the header and the EEG, EOG and EMG channels needed for staging are read, in slices, so a night-long file of several hundred MB is practical. A 786 MiB recording was reduced to 66 MB before reaching R.
- 🛏️ **Automatic AASM staging** — each 30 s epoch is scored with the pre-trained [YASA](https://github.com/raphaelvallat/yasa) model through `mrpheus`.
- 📊 **Stage composition** — minutes per stage across the night.
- 📈 **Interactive hypnogram** — hover, zoom, pan and reset (Plotly).
- 🌈 **Spectrogram** — power spectral density of the staging EEG channel, 0 to 30 Hz, with its time axis linked to the hypnogram.
- 🩺 **Clinical markers** — total sleep time, time in bed, sleep efficiency, sleep onset latency, wake after sleep onset, REM and N3 latency, and stage percentages, from `hypnoR::compute_sleep_architecture()`.
- 📤 **CSV export** — the markers and the hypnogram.
- 🎨 **Circadia Lab design** — light and dark themes, a welcome screen on the first visit, and the same icon set as [circadia-lab.uk](https://circadia-lab.uk).

---

## ⚙️ How it works

1. **Channel extraction (JavaScript).** The EDF header is read and the first EEG, EOG and EMG channel labels are chosen. A reduced plain EDF holding only those signals is built from slices of the file and written to webR's in-memory filesystem.
2. **Ingestion.** `mrpheus::read_edf()` and `mrpheus::prepare_psg()` read the reduced file and segment it into 30 s epochs.
3. **Features.** The YASA feature set is computed with mrpheus (`stage_epochs()`'s internal feature code, which applies its own 0.4 to 30 Hz bandpass and 100 Hz resample).
4. **Prediction.** The bundled LightGBM model is evaluated in plain R (`analysis.R`). The WebAssembly build of the `lightgbm` package cannot be loaded in the browser, because it is compiled with threads. The R evaluation was checked against Python LightGBM 4.7.0 on the YASA reference features: the largest probability difference was 3.3e-16, with identical predicted stages.
5. **Spectrogram and markers.** `mrpheus::compute_spectrogram()` and `hypnoR::compute_sleep_architecture()`.

`preprocess_psg()` is not run: staging does its own filtering, and the full-night filters are very slow in WebAssembly.

---

## 🗂️ Project Structure

```
hypnos/
├── index.html        # page structure, welcome screen and footer
├── style.css         # Circadia styling, light and dark
├── app.js            # webR boot, channel extraction, pipeline runner, plots
├── welcome.js        # welcome screen (first visit, remembered in localStorage)
├── analysis.R        # pipeline stages run in webR, plus the pure-R LightGBM predictor
├── logo.svg          # logo
├── favicon.svg       # small-size logo: browser tab and navbar
├── models/           # YASA staging model, used if the mrpheus WebAssembly build lacks it
├── vendor/           # self-hosted Bootstrap Icons and the mrpheus and hypnoR hex logos
├── netlify.toml      # Netlify configuration (static site, headers)
├── LICENSE
└── README.md
```

---

## 🚀 Getting Started

### Use it online

Open [hypnos.circadia-lab.uk](https://hypnos.circadia-lab.uk), wait for the engine pill to read "ready", and select an EDF file. The first visit downloads R and its packages, which can take a minute or two.

### Run it locally

**Prerequisites:** a current browser, an internet connection for the first load (webR and the R packages come from CDNs), and any static file server. The page must be served over HTTP; opening `index.html` directly will not work, because it uses ES modules and `fetch`.

```bash
git clone https://github.com/circadia-bio/hypnos.git
cd hypnos
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

### Deploy

hypnos is a static site with no build step. The repository includes a `netlify.toml` that publishes the repository root; on Netlify, leave the build command empty.

---

## ⚠️ Limitations

- **Automatic scoring.** Stages come from an automatic model and can differ from manual scoring. The markers have not been validated against manually scored hypnograms. Check them before relying on them.
- **Channel choice.** The first channel whose label matches an EEG, EOG or EMG pattern is used. This can be a frontal derivation, whereas YASA was trained on central ones, and the patterns are loose (`O2` also matches `SpO2`).
- **Files.** EDF and EDF+ recordings that are continuous. The annotations channel is dropped, and discontinuous EDF+D files are not supported.
- **Artefacts.** Artefact epochs are not detected or excluded.
- **Not a medical device.** hypnos is a research tool and is not intended for diagnosis or treatment. It is independent of the YASA authors and is not endorsed by them.

---

## 📦 Dependencies

| Component | Version | Purpose |
|-----------|---------|---------|
| [webR](https://docs.r-wasm.org/webr/latest/) | 0.6.0 (pinned) | R compiled to WebAssembly |
| [mrpheus](https://mrpheus.circadia-lab.uk) | [r-universe](https://circadia-bio.r-universe.dev) | EDF ingestion, features, staging, spectrogram |
| [hypnoR](https://hypnor.circadia-lab.uk) | [r-universe](https://circadia-bio.r-universe.dev) | Sleep architecture metrics |
| jsonlite | [repo.r-wasm.org](https://repo.r-wasm.org) | Passing results from R to the page |
| [Plotly.js](https://plotly.com/javascript/) (cartesian bundle) | 2.35.2 | Interactive plots |
| [Bootstrap Icons](https://icons.getbootstrap.com/) | 1.11.1 | Icons (self-hosted in `vendor/`) |
| Playfair Display, Alice | Google Fonts | Typefaces, as on circadia-lab.uk |

---

## 📄 Citation

hypnos has no archived release yet. If you use the automatic sleep staging, please cite YASA:

```bibtex
@article{vallat2021,
  author  = {Vallat, Raphael and Walker, Matthew P},
  title   = {An open-source, high-performance tool for automated sleep staging},
  journal = {eLife},
  volume  = {10},
  pages   = {e70092},
  year    = {2021},
  doi     = {10.7554/eLife.70092}
}
```

---

## 👥 Authors

| Role | Name | Affiliation |
|------|------|-------------|
| Author, maintainer | Lucas França | Northumbria University, Circadia Lab |
| Author | Mario Leocadio-Miguel | Circadia Lab |

---

## 🤝 Related Tools

- 🌙 [**mrpheus**](https://mrpheus.circadia-lab.uk) - raw physiological signal analysis, PSG ingestion and automatic staging
- 😴 [**hypnoR**](https://hypnor.circadia-lab.uk) - hypnogram handling and sleep architecture metrics
- 🌊 [**zeitR**](https://zeitr.circadia-lab.uk) - wrist actigraphy analysis and circadian metrics
- 🔗 [**syncR**](https://syncr.circadia-lab.uk) - unified participant-indexed database
- 🎨 [**circadia**](https://github.com/circadia-bio/circadia) - shared visual identity (palettes, themes)
- 🔬 [**circadia-bio**](https://github.com/circadia-bio) — the Circadia Lab GitHub organisation

---

## 📄 Licence

Released under the [MIT License](./LICENSE).

Copyright © Lucas França, Mario Leocadio-Miguel, 2026

---

> **Third-party attribution:** The sleep staging model was originally trained as part of YASA (Vallat & Walker, *eLife*, 2021; [doi:10.7554/eLife.70092](https://doi.org/10.7554/eLife.70092)) and is used under YASA's BSD 3-Clause License with attribution. Bootstrap Icons are used under the MIT License.
