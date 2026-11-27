# 🌙 hypnos <img src="logo.svg" align="right" height="140"/>

**Standard polysomnography metrics from an EDF file, computed entirely in your browser.**

[![Live app](https://img.shields.io/badge/app-hypnos.circadia--lab.uk-014370)](https://hypnos.circadia-lab.uk)
[![Version](https://img.shields.io/badge/version-0.1.0%20beta-fc544a)](./version.js)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![JavaScript](https://img.shields.io/badge/JavaScript-ES%20modules-F7DF1E)](https://developer.mozilla.org/docs/Web/JavaScript)
[![webR](https://img.shields.io/badge/webR-0.6.0-276DC3)](https://docs.r-wasm.org/webr/latest/)
[![Circadia Lab](https://img.shields.io/badge/circadia--bio-GitHub-014370)](https://github.com/circadia-bio)

> **Beta.** hypnos is an early release. The markers have not been validated against manually scored hypnograms; see the Limitations section below.

---

## 📖 What is hypnos?

hypnos is a web app for getting standard sleep metrics from a polysomnography (PSG) recording without installing anything. You select an EDF file, and the page returns the stage composition of the night, a hypnogram, a spectrogram of the EEG channel used for staging, and the usual sleep markers.

Everything runs in the browser. The recording is processed on your device and is never uploaded: there is no account and no server holding your data. The analysis is done by two R packages from the Circadia Lab ecosystem, [mrpheus](https://mrpheus.circadia-lab.uk) and [hypnoR](https://hypnor.circadia-lab.uk), running as WebAssembly through [webR](https://docs.r-wasm.org/webr/latest/).

---

## ✨ Features

- 🔒 **Private by design** — the EDF is read and processed on the device. (The page itself loads webR, R packages, Plotly and fonts from CDNs; the recording is not sent anywhere.)
- 📂 **Large files** — only the header and the EEG, EOG and EMG channels needed for staging are read, in slices, so a night-long file of several hundred MB is practical. A 786 MiB recording was reduced to 66 MB before reaching R.
- 🛏️ **Automatic AASM staging** — each 30 s epoch is scored with the pre-trained [YASA](https://github.com/raphaelvallat/yasa) model through `mrpheus`, using the classifier that matches the channels present.
- 🧭 **Signal validity and analysis window** — epochs where the EEG is flat are not staged, and the markers are computed over a window that ends where the signal is lost for good. The window can be adjusted.
- ⚙️ **Analysis settings** — choose the EEG, EOG and EMG channels from the file's own channel list, and set the analysis window by hand. A new window recomputes the markers instantly; a new channel runs the analysis again.
- 📊 **Stage composition** — minutes per stage across the analysis window.
- 📈 **Interactive hypnogram** — hover, zoom, pan and reset (Plotly).
- 🌈 **Spectrogram** — power spectral density of the staging EEG channel, 0 to 30 Hz, with its time axis linked to the hypnogram.
- 🩺 **Clinical markers** — total sleep time, time in bed, sleep efficiency, sleep onset latency, wake after sleep onset, REM and N3 latency, and stage percentages, from `hypnoR::compute_sleep_architecture()`.
- 📤 **CSV export** — the markers (with the channel and window used) and the hypnogram (with signal state and window membership per epoch).
- 🎨 **Circadia Lab design** — light and dark themes with a toggle, a welcome screen on the first visit, and the same icon set as [circadia-lab.uk](https://circadia-lab.uk).

---

## ⚙️ How it works

1. **Channel extraction (JavaScript).** The EDF header is read. The EEG channel defaults to a central derivation (C4, then C3, then Cz) when the file has one, otherwise the first channel that looks like EEG, and never an oximetry channel such as `SpO2`. EOG and EMG are the first labels matching `EOG|ROC|LOC` and `EMG|chin|Chin`. A reduced plain EDF holding only the chosen signals is built from slices of the file and written to webR's in-memory filesystem.
2. **Ingestion.** `mrpheus::read_edf()` and `mrpheus::prepare_psg()` read the reduced file and segment it into 30 s epochs.
3. **Signal validity.** Each epoch of the EEG is classed as flat (more than half of its samples are one value), clipped (more than 0.1% of its samples sit on the channel's extremes) or ok. The automatic analysis window runs from the first epoch with a signal to the epoch before the first hour of consecutive flat epochs.
4. **Features.** The YASA feature set is computed with mrpheus (`stage_epochs()`'s internal feature code, which applies its own 0.4 to 30 Hz bandpass and 100 Hz resample).
5. **Prediction.** The LightGBM model that matches the channels present (EEG, EEG and EOG, EEG and EMG, or all three) is evaluated in plain R (`analysis.R`), on features rounded to single precision as YASA does. The WebAssembly build of the `lightgbm` package cannot be loaded in the browser, because it is compiled with threads. The R evaluation matched Python LightGBM 4.7.0 on all eight shipped models (largest probability difference 4.4e-16, identical predicted stages). Flat epochs are then set to not staged.
6. **Spectrogram and markers.** `mrpheus::compute_spectrogram()`, with flat epochs left blank, and `hypnoR::compute_sleep_architecture()` over the analysis window.

`preprocess_psg()` is not run: staging does its own filtering, and the full-night filters are very slow in WebAssembly.

### The markers

They come from `hypnoR::compute_sleep_architecture(waso_until = "end")` on the hypnogram of the analysis window, and reproduce the notebook's `sleep_summary()`. Epochs with no valid EEG inside the window are unscored (`NA`): they count towards time in bed but towards no stage. hypnoR's default WASO stops at the last sleep epoch; hypnos asks for the end of the window. The note above the markers says which engine produced them. `waso_until` and the handling of unscored epochs arrived in hypnoR 0.1.2; if the installed hypnoR is older, hypnos uses an equivalent built-in function and the note says so.

| Marker | Definition |
|--------|------------|
| Time in bed | Length of the analysis window |
| Total sleep time | Epochs staged N1, N2, N3 or REM |
| Sleep efficiency | Total sleep time / time in bed |
| Sleep onset latency | Window start to the first non-wake epoch |
| Wake after sleep onset | Wake epochs from sleep onset to the **end of the window** |
| REM and N3 latency | First REM or N3 epoch, from sleep onset |
| Stage percentages | Minutes in the stage / total sleep time |

---

## 🗂️ Project Structure

```
hypnos/
├── index.html        # page structure, settings pop-up, welcome screen and footer
├── style.css         # Circadia styling, light and dark
├── app.js            # webR boot, pipeline runner, rendering, plots
├── channels.js       # EDF header reading and default channel choice
├── settings.js       # Analysis settings pop-up
├── theme.js          # light and dark toggle
├── welcome.js        # welcome screen (first visit, remembered in localStorage)
├── version.js        # version number and release stage
├── analysis.R        # pipeline stages run in webR, validity and window, pure-R LightGBM predictor
├── logo.svg          # logo
├── favicon.svg       # small-size logo: browser tab and navbar
├── models/           # YASA staging model, used only if the mrpheus WebAssembly build lacks it
├── vendor/           # self-hosted Bootstrap Icons and the mrpheus and hypnoR hex logos
├── netlify.toml      # Netlify configuration (static site, headers)
├── LICENSE
└── README.md
```

---

## 🚀 Getting Started

### Use it online

Open [hypnos.circadia-lab.uk](https://hypnos.circadia-lab.uk), wait for the engine pill to read "ready", and select an EDF file. The first visit downloads R and its packages, including the roughly 27 MB mrpheus package with its staging models, which can take a minute or two.

### Adjusting the analysis

Open **Analysis settings** under the file picker.

- **Channels** — the lists show every signal in the file with its sampling rate. Pick a different EEG channel, or set EOG or EMG to None. Applying a new channel runs the analysis again.
- **Analysis window** — Automatic, or Custom with a start and end in hours. Applying a new window recomputes the markers without re-staging. A note above the markers always states the channel and window used.

If a recording has no valid EEG on the chosen channel, the page says so; choose another channel.

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

- **Beta; automatic scoring.** Stages come from an automatic model and can differ from manual scoring. The markers have not been validated against manually scored hypnograms. Check them before relying on them.
- **One EEG channel.** Staging uses a single channel. An analysis that averages the probabilities of two channels (C3 and C4) can give different stages, and sleep onset and REM markers are the most sensitive to the difference.
- **Channel choice.** The default is a central derivation when the file has one, but the patterns are label-based and no quality check compares channels. Use Analysis settings if the default is wrong for a file.
- **Flat signal only.** Flat stretches are detected and excluded. Amplitude artefacts and other artefacts are not detected or removed.
- **Wake after sleep onset** counts wake to the end of the analysis window (`waso_until = "end"`), which can be larger than hypnoR's default definition, which stops at the last sleep epoch.
- **Files.** EDF and EDF+ recordings that are continuous. The annotations channel is dropped, and discontinuous EDF+D files are not supported.
- **Not a medical device.** hypnos is a research tool and is not intended for diagnosis or treatment. It is independent of the YASA authors and is not endorsed by them.

---

## 📦 Dependencies

| Component | Version | Purpose |
|-----------|---------|---------|
| [webR](https://docs.r-wasm.org/webr/latest/) | 0.6.0 (pinned) | R compiled to WebAssembly |
| [mrpheus](https://mrpheus.circadia-lab.uk) | 0.2.0 on [r-universe](https://circadia-bio.r-universe.dev) | EDF ingestion, features, staging models, spectrogram |
| [hypnoR](https://hypnor.circadia-lab.uk) | 0.1.2 or later on [r-universe](https://circadia-bio.r-universe.dev) (older versions work through a built-in fallback) | Sleep summary |
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

> **Third-party attribution:** The sleep staging models were originally trained as part of YASA (Vallat & Walker, *eLife*, 2021; [doi:10.7554/eLife.70092](https://doi.org/10.7554/eLife.70092)) and are used under YASA's BSD 3-Clause License with attribution. Bootstrap Icons are used under the MIT License.
