# analysis.R
# Runs inside webR (R compiled to WebAssembly) in the visitor's browser.
# app.js calls these functions one at a time so it can time each stage and
# drive the progress bar. State lives in the .hypnos environment.
# Nothing is written to disk or sent anywhere.

.hypnos <- new.env()

# ── Pure-R LightGBM predictor ────────────────────────────────────────────────
# The webR build of the lightgbm package cannot be loaded in the browser (it is
# compiled with threads / shared memory). mrpheus ships the YASA staging models
# as LightGBM text dumps (plain or gzip), so the model is evaluated here
# directly: walk each tree, sum leaf values per class, softmax. Mirrors
# LightGBM's NumericalDecision(). Stopgap for hypnos only; mrpheus::stage_epochs()
# is untouched, and hypnos follows its choices (model per channel set, features
# rounded to float32 as YASA does).

.hypnos_parse_tree <- function(blk) {
  get <- function(key) {
    ln <- blk[startsWith(blk, paste0(key, "="))]
    if (!length(ln)) return(NULL)
    sub(paste0("^", key, "="), "", ln[1L])
  }
  num <- function(key) {
    x <- get(key)
    if (is.null(x) || !nzchar(x)) numeric(0) else as.numeric(strsplit(x, " ", fixed = TRUE)[[1L]])
  }
  if (isTRUE(as.integer(get("num_cat")) > 0L)) {
    stop("LightGBM model has categorical splits, which this predictor does not support")
  }
  list(
    num_leaves     = as.integer(get("num_leaves")),
    split_feature  = as.integer(num("split_feature")),
    threshold      = num("threshold"),
    decision_type  = as.integer(num("decision_type")),
    left           = as.integer(num("left_child")),
    right          = as.integer(num("right_child")),
    leaf_value     = num("leaf_value")
  )
}

# Lines of a LightGBM text model, plain or gzip-compressed.
.hypnos_read_lines <- function(path) {
  con <- if (grepl("\\.gz$", path)) gzfile(path, "rt") else file(path, "rt")
  on.exit(close(con))
  readLines(con, warn = FALSE)
}

# Round doubles to the nearest IEEE single and return them as doubles, as numpy's
# astype(np.float32) does. YASA rounds its features this way before predicting.
.hypnos_as_float32 <- function(x) {
  v <- as.numeric(x)
  readBin(writeBin(v, raw(), size = 4L), what = "numeric", size = 4L, n = length(v))
}

# YASA classifier key for the channels present (mrpheus:::.yasa_model_key()).
.hypnos_model_key <- function(has_eog, has_emg) {
  paste0("eeg", if (has_eog) "_eog", if (has_emg) "_emg")
}

# The package's gzipped model for this key. The single yasa_staging.txt that hypnos
# served before is the full EEG + EOG + EMG model, so it only stands in for that key.
.hypnos_find_model <- function(key) {
  path <- system.file("models", paste0("yasa_", key, ".txt.gz"), package = "mrpheus")
  if (nzchar(path)) return(path)
  if (identical(key, "eeg_eog_emg") && file.exists("/tmp/yasa_staging.txt")) return("/tmp/yasa_staging.txt")
  root <- system.file(package = "mrpheus")
  stop("YASA model for ", key, " not found. mrpheus ", as.character(utils::packageVersion("mrpheus")),
       " models/ holds: [", paste(list.files(file.path(root, "models")), collapse = ", "), "]")
}

.hypnos_parse_model <- function(path) {
  lines   <- .hypnos_read_lines(path)
  starts  <- which(startsWith(lines, "Tree="))
  end_at  <- which(lines == "end of trees")[1L]
  header  <- lines[seq_len(starts[1L] - 1L)]
  kv <- function(key) {
    ln <- header[startsWith(header, paste0(key, "="))][1L]
    sub(paste0("^", key, "="), "", ln)
  }
  ends  <- c(starts[-1L] - 1L, end_at - 1L)
  trees <- Map(function(s, e) .hypnos_parse_tree(lines[s:e]), starts, ends)
  list(
    num_class     = as.integer(kv("num_class")),
    feature_names = strsplit(kv("feature_names"), " ", fixed = TRUE)[[1L]],
    trees         = trees
  )
}

.hypnos_predict_tree <- function(tr, X) {
  n <- nrow(X)
  if (tr$num_leaves < 2L) return(rep(tr$leaf_value[1L], n))
  out    <- numeric(n)
  active <- seq_len(n)
  cur    <- rep(0L, n)
  while (length(active)) {
    k  <- cur + 1L
    v  <- X[cbind(active, tr$split_feature[k] + 1L)]
    dt <- tr$decision_type[k]
    if (any(bitwAnd(dt, 1L) == 1L)) stop("categorical split encountered")
    mt <- bitwShiftR(bitwAnd(dt, 12L), 2L)        # 0 none, 1 zero, 2 NaN
    dl <- bitwAnd(dt, 2L) > 0L                    # default direction is left
    v[is.na(v) & mt != 2L] <- 0
    miss <- (mt == 1L & abs(v) <= 1e-35) | (mt == 2L & is.na(v))
    left <- ifelse(miss, dl, v <= tr$threshold[k])
    nxt  <- ifelse(left, tr$left[k], tr$right[k])
    at_leaf <- nxt < 0L
    out[active[at_leaf]] <- tr$leaf_value[-nxt[at_leaf]]
    active <- active[!at_leaf]
    cur    <- nxt[!at_leaf]
  }
  out
}

.hypnos_predict_matrix <- function(model, X) {
  K   <- model$num_class
  raw <- matrix(0, nrow(X), K)
  for (t in seq_along(model$trees)) {
    k <- ((t - 1L) %% K) + 1L
    raw[, k] <- raw[, k] + .hypnos_predict_tree(model$trees[[t]], X)
  }
  raw <- raw - apply(raw, 1L, max)
  e   <- exp(raw)
  e / rowSums(e)
}

# ── Signal validity, analysis window and summary ────────────────────────────
# After Greg_PSG/psg_DLBP33N3.qmd: a recording can carry on for hours after the EEG
# goes flat. Each epoch of the staging channel is "flat" (more than half of its
# samples are one value), "clipped" (more than 0.1% of them sit on the channel's
# highest or lowest value) or "ok". Flat epochs are not staged, and the markers are
# computed over an analysis window: from the first epoch with a signal to the epoch
# before the first stretch of 60 minutes of consecutive no-signal epochs.

.hypnos_epoch_state <- function(sig, spe, n, flat_share = 0.5, rail_share = 0.001) {
  hi  <- max(sig, na.rm = TRUE)
  lo  <- min(sig, na.rm = TRUE)
  M   <- matrix(sig[seq_len(spe * n)], nrow = spe)
  # More than half of an epoch's samples equal one value exactly when that value is
  # the epoch's median, so the share of samples equal to the median finds it.
  med  <- apply(M, 2L, stats::median)
  flat <- colMeans(M == rep(med, each = spe)) > flat_share
  rail <- colMeans(M == hi | M == lo) > rail_share
  ifelse(flat, "flat", ifelse(rail, "clipped", "ok"))
}

.hypnos_auto_window <- function(no_signal, gap_epochs = 120L) {
  first_ok <- which(!no_signal)[1L]
  if (is.na(first_ok)) return(NULL)
  r      <- rle(no_signal)
  ends   <- cumsum(r$lengths)
  starts <- ends - r$lengths + 1L
  later_gap <- which(r$values & r$lengths >= gap_epochs & starts > first_ok)
  win_end   <- if (length(later_gap)) starts[later_gap[1L]] - 1L else length(no_signal)
  c(first = first_ok, last = win_end)
}

# The notebook's sleep_summary(), plus N3 latency and stage percentages of TST.
# NA stages (no valid EEG) count towards time in bed but towards no stage.
.hypnos_sleep_summary <- function(stage, epoch_s = 30) {
  n      <- length(stage)
  asleep <- !is.na(stage) & stage != "W"
  mins   <- function(x) sum(x) * epoch_s / 60
  onset  <- which(asleep)[1L]
  tst    <- mins(asleep)
  tib    <- n * epoch_s / 60
  from_onset <- function(s) {
    i <- which(stage == s)[1L]
    if (is.na(onset) || is.na(i)) NA_real_ else (i - onset) * epoch_s / 60
  }
  pct <- function(s) if (tst > 0) 100 * mins(!is.na(stage) & stage == s) / tst else NA_real_
  list(
    tst_min          = tst,
    tib_min          = tib,
    se_pct           = 100 * tst / tib,
    sol_min          = if (is.na(onset)) NA_real_ else (onset - 1L) * epoch_s / 60,
    waso_min         = if (is.na(onset)) NA_real_ else
                         mins(stage[onset:n] == "W" & !is.na(stage[onset:n])),
    rem_lat_min      = from_onset("REM"),
    sws_lat_min      = from_onset("N3"),
    pct_n1           = pct("N1"),
    pct_n2           = pct("N2"),
    pct_n3           = pct("N3"),
    pct_rem          = pct("REM"),
    no_signal_epochs = sum(is.na(stage))
  )
}

# Exact-match regex for a channel label, so prepare_psg() types the channel the user
# chose however it is named (its defaults would read "SpO2" as EEG, because of "O2").
.hypnos_exact <- function(label) {
  if (is.na(label)) return("^$")
  chars   <- strsplit(label, "", fixed = TRUE)[[1L]]
  special <- c(".", "|", "(", ")", "[", "]", "{", "}", "^", "$", "*", "+", "?", "\\")
  paste0("^", paste0(ifelse(chars %in% special, paste0("\\", chars), chars), collapse = ""), "$")
}

# ── Pipeline stages (called one at a time from app.js) ───────────────────────

hypnos_reset <- function() {
  rm(list = ls(.hypnos, all.names = TRUE), envir = .hypnos)
  invisible(gc())
  "ok"
}

hypnos_header <- function(path) {
  hdr <- edfReader::readEdfHeader(path)
  .hypnos$hdr <- hdr
  paste0(nrow(hdr$sHeaders), " signals, ", toString(hdr$recordedPeriod), " s")
}

hypnos_read <- function(path) {
  rec <- mrpheus::read_edf(path)
  # With a single signal edfReader returns it bare, not as a named list, which
  # prepare_psg() cannot index by label.
  if (nrow(rec$channels) == 1L && !is.null(rec$signals$signal)) {
    rec$signals <- stats::setNames(list(rec$signals), rec$channels$label)
  }
  .hypnos$rec <- rec
  paste0(rec$channels$label, " @ ", rec$channels$sample_rate, " Hz", collapse = ", ")
}

hypnos_segment <- function(eeg, eog = NA_character_, emg = NA_character_, epoch_s = 30) {
  .hypnos$channels <- list(eeg = eeg, eog = eog, emg = emg)
  .hypnos$psg <- mrpheus::prepare_psg(
    .hypnos$rec, epoch_s = epoch_s,
    eeg_pattern = .hypnos_exact(eeg),
    eog_pattern = .hypnos_exact(eog),
    emg_pattern = .hypnos_exact(emg)
  )
  paste0(.hypnos$psg$n_epochs, " epochs")
}

hypnos_validity <- function() {
  psg <- .hypnos$psg
  eeg <- .hypnos$channels$eeg
  sig <- psg$edf$signals[[eeg]]$signal
  sr  <- psg$channel_map$sample_rate[psg$channel_map$label == eeg]
  n   <- psg$n_epochs

  state <- .hypnos_epoch_state(sig, round(psg$epoch_s * sr), n)
  .hypnos$state     <- state
  .hypnos$no_signal <- state == "flat"

  w <- .hypnos_auto_window(.hypnos$no_signal)
  if (is.null(w)) {
    stop("No epoch has a valid signal on ", eeg, ". Choose another EEG channel in Analysis settings.")
  }
  .hypnos$window <- w
  paste0(eeg, ": ", sum(state == "flat"), " flat and ", sum(state == "clipped"), " clipped of ", n,
         " epochs; window epochs ", w[["first"]], " to ", w[["last"]],
         sprintf(" (%.2f h)", (w[["last"]] - w[["first"]] + 1L) * psg$epoch_s / 3600))
}

hypnos_features <- function() {
  ch <- .hypnos$channels
  .hypnos$features <- mrpheus:::.extract_staging_features(.hypnos$psg, ch$eeg, ch$eog, ch$emg)
  paste0("EEG=", ch$eeg, ", EOG=", ch$eog, ", EMG=", ch$emg, ", ",
         nrow(.hypnos$features), " epochs x ", ncol(.hypnos$features) - 1L, " features")
}

hypnos_predict <- function() {
  ch  <- .hypnos$channels
  key <- .hypnos_model_key(!is.na(ch$eog), !is.na(ch$emg))
  model <- .hypnos_parse_model(.hypnos_find_model(key))

  feats   <- .hypnos$features
  missing <- setdiff(model$feature_names, names(feats))
  if (length(missing)) stop("Missing model features: ", paste(missing, collapse = ", "))
  X <- as.matrix(feats[, model$feature_names])
  X[] <- .hypnos_as_float32(X)                     # YASA predicts on float32 features

  probs  <- .hypnos_predict_matrix(model, X)
  labels <- c("N1", "N2", "N3", "REM", "W")      # alphabetical, as in stage_epochs()
  colnames(probs) <- paste0("prob_", labels)
  stage <- labels[apply(probs, 1L, which.max)]
  stage[.hypnos$no_signal] <- NA_character_        # no valid EEG: not staged

  .hypnos$stages <- tibble::as_tibble(cbind(
    data.frame(epoch = feats$epoch, stage = stage), probs
  ))
  paste0("classifier ", key, ", ", length(model$trees), " trees; ",
         paste0(names(table(stage)), "=", as.integer(table(stage)), collapse = ", "),
         "; not staged=", sum(is.na(stage)))
}

hypnos_spectrogram <- function() {
  tryCatch({
    eeg <- .hypnos$channels$eeg
    sp  <- mrpheus::compute_spectrogram(.hypnos$psg, channel = eeg, freq_range = c(0, 30))
    power <- sp$power
    power[.hypnos$no_signal, ] <- NA               # a flat signal has no spectrum to show
    .hypnos$spec <- list(channel = eeg, freqs = sp$freqs, power = round(power, 1))
    paste0(eeg, ", ", nrow(power), " epochs x ", length(sp$freqs), " bins")
  }, error = function(e) {
    .hypnos$spec <- NULL
    paste0("skipped: ", conditionMessage(e))
  })
}

# first and last are epoch numbers of a window the user chose; NULL uses the automatic one.
hypnos_metrics <- function(first = NULL, last = NULL, epoch_s = 30) {
  psg    <- .hypnos$psg
  stages <- .hypnos$stages
  n      <- psg$n_epochs
  auto   <- .hypnos$window

  manual <- !is.null(first) && !is.null(last)
  w <- if (manual) c(first = max(1L, as.integer(first)), last = min(n, as.integer(last))) else auto
  if (w[["last"]] < w[["first"]]) stop("The analysis window is empty.")
  idx <- w[["first"]]:w[["last"]]

  stage_chr <- as.character(stages$stage)
  in_win    <- stage_chr[idx]
  summ      <- .hypnos_sleep_summary(in_win, epoch_s)
  stage_min <- vapply(c("W", "N1", "N2", "N3", "REM"),
                      function(s) sum(in_win == s, na.rm = TRUE) * epoch_s / 60, numeric(1))

  out <- list(
    recording = list(
      duration_h = n * epoch_s / 3600,
      n_epochs   = n,
      epoch_s    = epoch_s,
      channels   = psg$channel_map
    ),
    window = list(first = w[["first"]], last = w[["last"]],
                  auto_first = auto[["first"]], auto_last = auto[["last"]], manual = manual),
    metrics       = summ,
    stage_min     = as.list(stage_min),
    no_signal_min = summ$no_signal_epochs * epoch_s / 60,
    signal        = .hypnos$state,
    stages        = stage_chr
  )
  out$spectrogram <- .hypnos$spec     # NULL (omitted) if the spectrogram stage was skipped

  as.character(jsonlite::toJSON(out, auto_unbox = TRUE, na = "null", digits = 4))
}

# Drop the large objects once the run is done; a new window only needs the stages.
hypnos_trim <- function() {
  .hypnos$rec <- NULL
  .hypnos$features <- NULL
  if (!is.null(.hypnos$psg)) {
    .hypnos$psg$edf    <- NULL
    .hypnos$psg$epochs <- NULL
  }
  invisible(gc())
  "ok"
}
